import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signDetached,
  verify as verifyDetached,
  type KeyObject
} from "node:crypto";

import type {
  OperatorPublicKey,
  TransparencyCheckpoint,
  TransparencyInclusionProof,
  TransparencyLogEntry,
  TransparencyReceipt
} from "@auth-layer/shared";

import type { CaptureRepository } from "../repositories/captureRepository.js";
import { createId } from "../utils/id.js";
import { hashStableValue } from "../utils/stableJson.js";
import { buildMerkleInclusionProof, computeMerkleRootFromEntryHashes } from "../utils/merkleTransparency.js";

export const DEV_OPERATOR_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICuDjMQ9dp3BORmrTQ3bY68tEe7Pg5s3O1zt9KCuzK/J
-----END PRIVATE KEY-----
`;

export const DEV_OPERATOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7qW1iCRvTCU4Zz2iLX7gSV8l2N4NLCVpNYD+ps5c/nQ=
-----END PUBLIC KEY-----
`;

const normalizePem = (pem: string): string => `${pem.trim()}\n`;
const sha256Hex = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const unsignedCheckpointPayload = (checkpoint: Omit<TransparencyCheckpoint, "signature" | "checkpointHash">) => ({
  schemaVersion: checkpoint.schemaVersion,
  checkpointId: checkpoint.checkpointId,
  treeSize: checkpoint.treeSize,
  lastLogIndex: checkpoint.lastLogIndex,
  lastEntryHash: checkpoint.lastEntryHash,
  rootHash: checkpoint.rootHash,
  issuedAt: checkpoint.issuedAt,
  operatorId: checkpoint.operatorId,
  operatorKeyId: checkpoint.operatorKeyId,
  operatorPublicKeySha256: checkpoint.operatorPublicKeySha256,
  signatureAlgorithm: checkpoint.signatureAlgorithm,
  logMode: checkpoint.logMode ?? "legacy-hash-chain",
  previousCheckpointId: checkpoint.previousCheckpointId ?? null,
  previousCheckpointHash: checkpoint.previousCheckpointHash ?? null
});

export const computeTransparencyCheckpointHash = (
  checkpoint: Omit<TransparencyCheckpoint, "signature" | "checkpointHash">
): string => hashStableValue(unsignedCheckpointPayload(checkpoint));

const matchesTrustedKey = (checkpoint: TransparencyCheckpoint, key: OperatorPublicKey): boolean =>
  key.operatorId === checkpoint.operatorId &&
  key.keyId === checkpoint.operatorKeyId &&
  key.algorithm === checkpoint.signatureAlgorithm &&
  key.publicKeySha256 === checkpoint.operatorPublicKeySha256;

export const verifyTransparencyCheckpointSignature = (
  checkpoint: TransparencyCheckpoint,
  trustedOperatorKeys: OperatorPublicKey[]
): boolean => {
  const matchingKey = trustedOperatorKeys.find((key) => matchesTrustedKey(checkpoint, key));
  if (!matchingKey) {
    return false;
  }

  const { signature, checkpointHash, ...unsigned } = checkpoint;
  const expectedHash = computeTransparencyCheckpointHash(unsigned);
  if (checkpointHash !== expectedHash) {
    return false;
  }

  return verifyDetached(
    null,
    Buffer.from(checkpointHash, "utf8"),
    createPublicKey(matchingKey.publicKeyPem),
    Buffer.from(signature, "base64")
  );
};

export class Ed25519TransparencyCheckpointSigner {
  private readonly privateKey: KeyObject;
  private readonly operatorPublicKey: OperatorPublicKey;

  constructor(input: {
    privateKeyPem: string;
    publicKeyPem?: string;
    operatorId: string;
    keyId: string;
    createdAt?: string;
  }) {
    this.privateKey = createPrivateKey(normalizePem(input.privateKeyPem));
    const publicKeyPem = input.publicKeyPem
      ? normalizePem(input.publicKeyPem)
      : createPublicKey(this.privateKey).export({ type: "spki", format: "pem" }).toString();

    this.operatorPublicKey = {
      schemaVersion: 1,
      operatorId: input.operatorId,
      keyId: input.keyId,
      algorithm: "ed25519",
      publicKeyPem,
      publicKeySha256: sha256Hex(publicKeyPem),
      createdAt: input.createdAt ?? new Date().toISOString()
    };
  }

  getPublicKey(): OperatorPublicKey {
    return { ...this.operatorPublicKey };
  }

  issue(input: {
    treeSize: number;
    lastLogIndex: number;
    lastEntryHash: string;
    rootHash: string;
    issuedAt?: string;
    previousCheckpoint?: TransparencyCheckpoint;
  }): TransparencyCheckpoint {
    const issuedAt = input.issuedAt ?? new Date().toISOString();
    const unsigned: Omit<TransparencyCheckpoint, "signature" | "checkpointHash"> = {
      schemaVersion: 3,
      checkpointId: createId(),
      treeSize: input.treeSize,
      lastLogIndex: input.lastLogIndex,
      lastEntryHash: input.lastEntryHash,
      rootHash: input.rootHash,
      issuedAt,
      operatorId: this.operatorPublicKey.operatorId,
      operatorKeyId: this.operatorPublicKey.keyId,
      operatorPublicKeySha256: this.operatorPublicKey.publicKeySha256,
      signatureAlgorithm: this.operatorPublicKey.algorithm,
      logMode: "merkle-tree-v1",
      previousCheckpointId: input.previousCheckpoint?.checkpointId,
      previousCheckpointHash: input.previousCheckpoint?.checkpointHash
    };
    const checkpointHash = computeTransparencyCheckpointHash(unsigned);

    return {
      ...unsigned,
      checkpointHash,
      signature: signDetached(null, Buffer.from(checkpointHash, "utf8"), this.privateKey).toString("base64")
    };
  }

  verify(checkpoint: TransparencyCheckpoint): boolean {
    return verifyTransparencyCheckpointSignature(checkpoint, [this.operatorPublicKey]);
  }
}

export class TransparencyLogService {
  constructor(
    private readonly repository: CaptureRepository,
    private readonly signer: Ed25519TransparencyCheckpointSigner
  ) {}

  getOperatorPublicKey(): OperatorPublicKey {
    return this.signer.getPublicKey();
  }

  async appendCapture(captureId: string, proofBundleHash: string, receipt?: TransparencyReceipt): Promise<{
    entry: TransparencyLogEntry;
    checkpoint: TransparencyCheckpoint;
    inclusionProof: TransparencyInclusionProof;
    receipt?: TransparencyReceipt;
  }> {
    const [entry, previousCheckpoint] = await Promise.all([
      this.repository.appendTransparencyLogEntry({ captureId, proofBundleHash }),
      this.repository.getLatestTransparencyCheckpoint()
    ]);
    const logEntries = await this.repository.listTransparencyLogEntries({ uptoLogIndex: entry.logIndex });
    const rootHash = computeMerkleRootFromEntryHashes(logEntries.map((candidate) => candidate.entryHash));
    if (!rootHash) {
      throw new Error("Cannot issue a Merkle checkpoint for an empty transparency log");
    }

    const checkpoint = this.signer.issue({
      treeSize: logEntries.length,
      lastLogIndex: entry.logIndex,
      lastEntryHash: entry.entryHash,
      rootHash,
      previousCheckpoint
    });
    await this.repository.saveTransparencyCheckpoint(checkpoint);

    const inclusionProof = buildMerkleInclusionProof({
      entry,
      checkpoint,
      entries: logEntries
    });

    const nextReceipt = receipt
      ? {
          ...receipt,
          logIndex: entry.logIndex,
          transparencyLogEntryHash: entry.entryHash,
          transparencyCheckpointId: checkpoint.checkpointId,
          merkleRoot: checkpoint.rootHash
        }
      : undefined;

    return {
      entry,
      checkpoint,
      inclusionProof,
      receipt: nextReceipt
    };
  }

  async getCaptureTransparency(captureId: string, checkpointId?: string): Promise<{
    entry?: TransparencyLogEntry;
    checkpoint?: TransparencyCheckpoint;
    inclusionProof?: TransparencyInclusionProof;
  }> {
    const entry = await this.repository.getTransparencyLogEntry(captureId);
    if (!entry) {
      return {};
    }

    const checkpoint = checkpointId
      ? await this.repository.getTransparencyCheckpoint(checkpointId)
      : await this.repository.getLatestTransparencyCheckpoint();

    if (!checkpoint) {
      return { entry };
    }

    if ((checkpoint.logMode ?? "legacy-hash-chain") !== "merkle-tree-v1") {
      return { entry, checkpoint };
    }

    const logEntries = await this.repository.listTransparencyLogEntries({ uptoLogIndex: checkpoint.lastLogIndex });
    const inclusionProof = buildMerkleInclusionProof({
      entry,
      checkpoint,
      entries: logEntries
    });

    return { entry, checkpoint, inclusionProof };
  }

  verifyCheckpoint(checkpoint: TransparencyCheckpoint, trustedOperatorKeys?: OperatorPublicKey[]): boolean {
    return trustedOperatorKeys?.length
      ? verifyTransparencyCheckpointSignature(checkpoint, trustedOperatorKeys)
      : this.signer.verify(checkpoint);
  }
}
