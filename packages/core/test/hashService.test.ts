import { describe, expect, it } from "vitest";

import { HASH_ALGORITHM, HashService, PROOF_BUNDLE_SCHEMA_VERSION } from "../src/services/hashService.js";
import { NORMALIZATION_VERSION } from "../src/services/extractionService.js";
import { normalizeContentUrl } from "../src/utils/url.js";

const createCanonicalContent = (bodyMarkdown: string) => ({
  schemaVersion: 2,
  normalizationVersion: NORMALIZATION_VERSION,
  sourceUrl: "https://example.com/article",
  canonicalUrl: "https://example.com/article",
  title: "Café update",
  blocks: [
    { order: 0, type: "paragraph" as const, text: "Line one" },
    { order: 1, type: "paragraph" as const, text: "Line two" }
  ],
  bodyMarkdown,
  imageUrls: [normalizeContentUrl("https://cdn.example.com/image.jpg?a=1&b=2", "https://example.com/article")],
  extractorVersion: "readability-v1",
  stats: {
    characterCount: 17,
    wordCount: 4,
    blockCount: 2,
    paragraphCount: 2,
    headingCount: 0,
    imageCount: 1
  },
  diagnostics: {
    confidence: 0.88,
    warnings: []
  }
});

describe("HashService", () => {
  it("produces identical canonical hashes for semantically identical content", () => {
    const hashService = new HashService();
    const firstContent = createCanonicalContent("Line one\r\n\r\n\r\nLine two");
    const secondContent = createCanonicalContent("Line one\n\nLine two");

    expect(hashService.hashCanonicalContent(firstContent)).toBe(hashService.hashCanonicalContent(secondContent));
  });

  it("normalizes tracked asset URLs before they are stored in canonical content", () => {
    expect(
      normalizeContentUrl(
        "https://cdn.example.com/image.jpg?utm_source=newsletter&b=2&a=1",
        "https://example.com/article"
      )
    ).toBe("https://cdn.example.com/image.jpg?a=1&b=2");
  });

  it("builds a self-describing proof bundle", () => {
    const hashService = new HashService();
    const proof = hashService.buildProofBundle({
      captureId: "capture-1",
      requestedUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      pageKind: "article",
      extractorVersion: "readability-v1",
      normalizationVersion: NORMALIZATION_VERSION,
      rawSnapshotSchemaVersion: 1,
      canonicalContentSchemaVersion: 2,
      metadataSchemaVersion: 2,
      captureScope: {
        rawHttpBodyPreserved: true,
        canonicalContentExtracted: true,
        metadataExtracted: true,
        screenshotPreserved: false,
        renderedDomPreserved: false
      },
      rawSnapshotHash: "sha256:raw",
      canonicalContentHash: "sha256:content",
      metadataHash: "sha256:meta",
      createdAt: "2026-03-14T12:00:00.000Z"
    });

    expect(proof.proofBundle.schemaVersion).toBe(PROOF_BUNDLE_SCHEMA_VERSION);
    expect(proof.proofBundle.hashAlgorithm).toBe(HASH_ALGORITHM);
    expect(proof.proofBundle.captureId).toBe("capture-1");
    expect(proof.proofBundle.captureScope.rawHttpBodyPreserved).toBe(true);
    expect(proof.proofBundle.rawSnapshotSchemaVersion).toBe(1);
  });
});
