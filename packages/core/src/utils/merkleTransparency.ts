import { createHash } from "node:crypto";

import type {
  TransparencyCheckpoint,
  TransparencyInclusionProof,
  TransparencyMerkleProofStep,
  TransparencyLogEntry
} from "@auth-layer/shared";

const hashBuffer = (buffer: Buffer): string => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const bufferFromHash = (hash: string): Buffer => Buffer.from(hash.replace(/^sha256:/, ""), "hex");

export const hashMerkleLeaf = (entryHash: string): string =>
  hashBuffer(Buffer.concat([Buffer.from([0]), bufferFromHash(entryHash)]));

export const hashMerkleNode = (leftHash: string, rightHash: string): string =>
  hashBuffer(Buffer.concat([Buffer.from([1]), bufferFromHash(leftHash), bufferFromHash(rightHash)]));

const buildNextLevel = (nodes: string[]): string[] => {
  const next: string[] = [];

  for (let index = 0; index < nodes.length; index += 2) {
    const left = nodes[index];
    if (!left) {
      continue;
    }

    const right = nodes[index + 1];
    next.push(right ? hashMerkleNode(left, right) : left);
  }

  return next;
};

export const computeMerkleRootFromEntryHashes = (entryHashes: string[]): string | undefined => {
  if (entryHashes.length === 0) {
    return undefined;
  }

  let level = entryHashes.map(hashMerkleLeaf);
  while (level.length > 1) {
    level = buildNextLevel(level);
  }

  return level[0] ?? undefined;
};

export const buildMerkleInclusionProof = (input: {
  entry: TransparencyLogEntry;
  checkpoint: TransparencyCheckpoint;
  entries: TransparencyLogEntry[];
}): TransparencyInclusionProof => {
  const entryHashes = input.entries.map((candidate) => candidate.entryHash);
  const leafIndex = input.entries.findIndex((candidate) => candidate.captureId === input.entry.captureId);
  if (leafIndex === -1) {
    throw new Error(`Capture ${input.entry.captureId} is not present in the checkpoint log slice`);
  }

  const steps: TransparencyMerkleProofStep[] = [];
  let index = leafIndex;
  let level = entryHashes.map(hashMerkleLeaf);

  while (level.length > 1) {
    if (index % 2 === 0) {
      const sibling = level[index + 1];
      if (sibling) {
        steps.push({ direction: "right", hash: sibling });
      }
    } else {
      const sibling = level[index - 1];
      if (sibling) {
        steps.push({ direction: "left", hash: sibling });
      }
    }

    level = buildNextLevel(level);
    index = Math.floor(index / 2);
  }

  return {
    schemaVersion: 1,
    mode: "merkle-v1",
    algorithm: "sha256-merkle-v1",
    checkpointId: input.checkpoint.checkpointId,
    treeSize: input.checkpoint.treeSize,
    leafIndex,
    logEntryHash: input.entry.entryHash,
    leafHash: hashMerkleLeaf(input.entry.entryHash),
    rootHash: input.checkpoint.rootHash,
    steps
  };
};

export const verifyMerkleInclusionProof = (proof: TransparencyInclusionProof): boolean => {
  if (proof.mode !== "merkle-v1") {
    return false;
  }

  let currentHash = proof.leafHash;
  for (const step of proof.steps) {
    currentHash = step.direction === "left"
      ? hashMerkleNode(step.hash, currentHash)
      : hashMerkleNode(currentHash, step.hash);
  }

  return currentHash === proof.rootHash;
};
