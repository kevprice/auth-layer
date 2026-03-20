import { createHash, createPrivateKey, createPublicKey, sign as signDetached, verify as verifyDetached, type KeyObject } from "node:crypto";

import type {
  AttestationBundle,
  ContentAttestation,
  ContentAttestationInput,
  OperatorPublicKey
} from "@auth-layer/shared";
import { computeContentAttestationHash } from "@auth-layer/shared";

import { createId } from "../utils/id.js";

const normalizePem = (pem: string): string => `${pem.trim()}\n`;
const sha256Hex = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export const verifyContentAttestationSignature = async (
  attestation: ContentAttestation,
  trustedKeys: OperatorPublicKey[]
): Promise<boolean> => {
  const matchingKey = trustedKeys.find(
    (key) =>
      key.operatorId === attestation.issuerOperatorId &&
      key.keyId === attestation.issuerKeyId &&
      key.algorithm === attestation.signatureAlgorithm &&
      key.publicKeySha256 === attestation.issuerPublicKeySha256
  );

  if (!matchingKey) {
    return false;
  }

  const { signature, attestationHash, ...unsigned } = attestation;
  const recomputedHash = await computeContentAttestationHash(unsigned);
  if (recomputedHash !== attestationHash) {
    return false;
  }

  return verifyDetached(
    null,
    Buffer.from(attestationHash, "utf8"),
    createPublicKey(matchingKey.publicKeyPem),
    Buffer.from(signature, "base64")
  );
};

export class Ed25519ContentAttestationSigner {
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

  async issue(input: {
    subjectContentHash: string;
    attestation: ContentAttestationInput;
  }): Promise<ContentAttestation> {
    const unsigned = {
      schemaVersion: 1,
      id: createId(),
      type: input.attestation.type,
      actor: input.attestation.actor,
      auth: input.attestation.auth,
      timestamp: input.attestation.timestamp ?? new Date().toISOString(),
      notes: input.attestation.notes,
      subjectContentHash: input.subjectContentHash,
      relatedContentHashes: input.attestation.relatedContentHashes,
      metadata: input.attestation.metadata,
      issuerOperatorId: this.operatorPublicKey.operatorId,
      issuerKeyId: this.operatorPublicKey.keyId,
      issuerPublicKeySha256: this.operatorPublicKey.publicKeySha256,
      signatureAlgorithm: this.operatorPublicKey.algorithm
    };

    const attestationHash = await computeContentAttestationHash(unsigned);
    return {
      ...unsigned,
      attestationHash,
      signature: signDetached(null, Buffer.from(attestationHash, "utf8"), this.privateKey).toString("base64")
    };
  }
}

export class ContentAttestationService {
  constructor(private readonly signer: Ed25519ContentAttestationSigner) {}

  getOperatorPublicKey(): OperatorPublicKey {
    return this.signer.getPublicKey();
  }

  async issueBundle(input: {
    subjectContentHash: string;
    attestations: ContentAttestationInput[];
  }): Promise<AttestationBundle | undefined> {
    if (!input.attestations.length) {
      return undefined;
    }

    return {
      schemaVersion: 1,
      bundleType: "auth-layer-attestation-bundle",
      attestations: await Promise.all(
        input.attestations.map((attestation) => this.signer.issue({ subjectContentHash: input.subjectContentHash, attestation }))
      )
    };
  }

  verify(attestation: ContentAttestation, trustedKeys?: OperatorPublicKey[]): Promise<boolean> {
    return verifyContentAttestationSignature(attestation, trustedKeys ?? [this.signer.getPublicKey()]);
  }
}
