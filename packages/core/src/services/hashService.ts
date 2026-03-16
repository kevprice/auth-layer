import { createHash } from "node:crypto";

import type { CanonicalContent, CanonicalMetadata, CaptureArtifactType, CaptureScope, ProofBundle, RawSnapshot } from "@auth-layer/shared";

import { hashStableValue, normalizeValue } from "../utils/stableJson.js";

export const HASH_ALGORITHM = "sha256-v1";
export const PROOF_BUNDLE_SCHEMA_VERSION = 3;

export type HashBundle = {
  rawSnapshotHash: string;
  canonicalContentHash: string;
  metadataHash: string;
  proofBundleHash: string;
  proofBundle: ProofBundle;
};

export class HashService {
  hashRawSnapshot(rawSnapshot: RawSnapshot, rawHtml: string): string {
    return hashStableValue({ ...rawSnapshot, rawHtml });
  }

  hashBuffer(buffer: Buffer): string {
    return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
  }

  hashPdfFile(buffer: Buffer): string {
    return this.hashBuffer(buffer);
  }

  hashCanonicalContent(canonicalContent: CanonicalContent): string {
    return hashStableValue(normalizeValue(canonicalContent));
  }

  hashMetadata(metadata: CanonicalMetadata): string {
    return hashStableValue(normalizeValue(metadata));
  }

  buildProofBundle(input: {
    artifactType?: CaptureArtifactType;
    captureId: string;
    sourceLabel?: string;
    fileName?: string;
    mediaType?: string;
    byteSize?: number;
    requestedUrl: string;
    finalUrl: string;
    pageKind: ProofBundle["pageKind"];
    extractorVersion: string;
    normalizationVersion: string;
    rawSnapshotSchemaVersion: number;
    canonicalContentSchemaVersion: number;
    metadataSchemaVersion: number;
    captureScope: CaptureScope;
    rawSnapshotHash: string;
    screenshotHash?: string;
    canonicalContentHash: string;
    metadataHash: string;
    createdAt: string;
  }): HashBundle {
    const proofBundle: ProofBundle = {
      schemaVersion: PROOF_BUNDLE_SCHEMA_VERSION,
      artifactType: input.artifactType,
      captureId: input.captureId,
      sourceLabel: input.sourceLabel,
      fileName: input.fileName,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
      requestedUrl: input.requestedUrl,
      finalUrl: input.finalUrl,
      pageKind: input.pageKind,
      extractorVersion: input.extractorVersion,
      normalizationVersion: input.normalizationVersion,
      hashAlgorithm: HASH_ALGORITHM,
      rawSnapshotSchemaVersion: input.rawSnapshotSchemaVersion,
      canonicalContentSchemaVersion: input.canonicalContentSchemaVersion,
      metadataSchemaVersion: input.metadataSchemaVersion,
      captureScope: input.captureScope,
      rawSnapshotHash: input.rawSnapshotHash,
      screenshotHash: input.screenshotHash,
      canonicalContentHash: input.canonicalContentHash,
      metadataHash: input.metadataHash,
      createdAt: input.createdAt
    };

    return {
      rawSnapshotHash: input.rawSnapshotHash,
      canonicalContentHash: input.canonicalContentHash,
      metadataHash: input.metadataHash,
      proofBundleHash: hashStableValue(proofBundle),
      proofBundle
    };
  }
}
