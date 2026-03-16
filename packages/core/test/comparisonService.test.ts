import { describe, expect, it } from "vitest";

import type { CaptureComparisonSide, CaptureRecord } from "@auth-layer/shared";

import { compareCaptureDetails, compareWithPreviousCapture } from "../src/services/comparisonService.js";

const createCapture = (
  overrides: Partial<CaptureRecord> & {
    title?: string;
    author?: string;
  }
): CaptureRecord & { title?: string; author?: string } => ({
  id: "capture-id",
  requestedUrl: "https://example.com/article",
  normalizedRequestedUrl: "https://example.com/article",
  extractorVersion: "readability-v1",
  status: "completed",
  artifacts: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
});

const createComparisonSide = (input: {
  id: string;
  canonicalContentHash: string;
  metadataHash: string;
  title: string;
  author: string;
  claimedPublishedAt: string;
  pageKind?: CaptureRecord["pageKind"];
  extractorVersion?: string;
  confidence?: number;
  warnings?: string[];
  heading?: string;
  paragraphs?: string[];
  observedAt: string;
}): CaptureComparisonSide => ({
  capture: createCapture({
    id: input.id,
    canonicalContentHash: input.canonicalContentHash,
    metadataHash: input.metadataHash,
    claimedPublishedAt: input.claimedPublishedAt,
    pageKind: input.pageKind ?? "article",
    extractorVersion: input.extractorVersion ?? "readability-v1",
    contentExtractionStatus: "success",
    capturedAt: input.observedAt
  }),
  observedAt: input.observedAt,
  metadata: {
    schemaVersion: 2,
    normalizationVersion: "canonical-v2",
    sourceUrl: "https://example.com/article",
    title: input.title,
    author: input.author,
    publishedAtClaimed: input.claimedPublishedAt,
    extractorVersion: input.extractorVersion ?? "readability-v1",
    fieldProvenance: {
      title: { sourceKind: "readability", strategy: "Readability selected the page title." },
      subtitle: { sourceKind: "not-found", strategy: "Subtitle extraction" },
      author: { sourceKind: "readability", strategy: "Readability selected the byline." },
      publishedAtClaimed: { sourceKind: "meta-tag", strategy: "Article published time meta tag" },
      canonicalUrl: { sourceKind: "not-found", strategy: "Canonical URL extraction" }
    }
  },
  canonicalContent: {
    schemaVersion: 2,
    normalizationVersion: "canonical-v2",
    sourceUrl: "https://example.com/article",
    title: input.title,
    author: input.author,
    publishedAtClaimed: input.claimedPublishedAt,
    extractorVersion: input.extractorVersion ?? "readability-v1",
    blocks: [
      { order: 0, type: "heading", text: input.heading ?? input.title },
      ...(input.paragraphs ?? ["Paragraph one", "Paragraph two"]).map((paragraph, index) => ({
        order: index + 1,
        type: "paragraph" as const,
        text: paragraph
      }))
    ],
    bodyMarkdown: (input.paragraphs ?? ["Paragraph one", "Paragraph two"]).join("\n\n"),
    stats: {
      characterCount: 120,
      wordCount: 20,
      blockCount: 3,
      paragraphCount: (input.paragraphs ?? ["Paragraph one", "Paragraph two"]).length,
      headingCount: 1,
      imageCount: 0
    },
    diagnostics: {
      confidence: input.confidence ?? 0.88,
      warnings: input.warnings ?? []
    }
  },
  proofBundle: {
    schemaVersion: 3,
    captureId: input.id,
    requestedUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    pageKind: input.pageKind ?? "article",
    extractorVersion: input.extractorVersion ?? "readability-v1",
    normalizationVersion: "canonical-v2",
    hashAlgorithm: "sha256-v1",
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
    canonicalContentHash: input.canonicalContentHash,
    metadataHash: input.metadataHash,
    createdAt: input.observedAt
  }
});

describe("comparisonService", () => {
  it("distinguishes field-level metadata changes from semantic content changes", () => {
    const previous = createCapture({
      id: "capture-1",
      canonicalContentHash: "sha256:a",
      metadataHash: "sha256:meta-a",
      claimedPublishedAt: "2024-11-05T09:00:00Z",
      title: "Launch day",
      author: "Ada Lovelace"
    });
    const current = createCapture({
      id: "capture-2",
      canonicalContentHash: "sha256:a",
      metadataHash: "sha256:meta-b",
      claimedPublishedAt: "2024-11-06T09:00:00Z",
      title: "Launch day updated",
      author: "Grace Hopper"
    });

    expect(compareWithPreviousCapture(current, previous)).toEqual({
      comparedToCaptureId: "capture-1",
      contentChangedFromPrevious: false,
      metadataChangedFromPrevious: true,
      titleChangedFromPrevious: true,
      authorChangedFromPrevious: true,
      claimedPublishedAtChangedFromPrevious: true
    });
  });

  it("builds a forensic comparison summary with block and diagnostics context", () => {
    const older = createComparisonSide({
      id: "capture-older",
      canonicalContentHash: "sha256:content-a",
      metadataHash: "sha256:meta-a",
      title: "Launch day",
      author: "Ada Lovelace",
      claimedPublishedAt: "2024-11-05T09:00:00Z",
      heading: "Launch day",
      paragraphs: ["Paragraph one", "Paragraph two"],
      observedAt: "2026-03-15T10:00:00.000Z"
    });
    const newer = createComparisonSide({
      id: "capture-newer",
      canonicalContentHash: "sha256:content-b",
      metadataHash: "sha256:meta-b",
      title: "Launch day updated",
      author: "Grace Hopper",
      claimedPublishedAt: "2024-11-06T09:00:00Z",
      heading: "Launch day updated",
      paragraphs: ["Paragraph two", "Paragraph three"],
      extractorVersion: "readability-v2",
      confidence: 0.61,
      warnings: ["Extractor saw multiple article candidates."],
      observedAt: "2026-03-15T12:00:00.000Z"
    });

    const comparison = compareCaptureDetails({
      normalizedRequestedUrl: "https://example.com/article",
      basis: "capture-id",
      older,
      newer
    });

    expect(comparison.fields.canonicalContentHashChanged).toBe(true);
    expect(comparison.fields.metadataHashChanged).toBe(true);
    expect(comparison.fields.titleChanged).toBe(true);
    expect(comparison.fields.authorChanged).toBe(true);
    expect(comparison.fields.claimedPublishedAtChanged).toBe(true);
    expect(comparison.fields.extractorVersionChanged).toBe(true);
    expect(comparison.blockSummary.paragraphsAdded).toBe(1);
    expect(comparison.blockSummary.paragraphsRemoved).toBe(1);
    expect(comparison.blockSummary.headingsChanged).toBe(1);
    expect(comparison.diagnostics.notes.some((note) => /Extractor version changed/i.test(note))).toBe(true);
    expect(comparison.observationStatement).toMatch(/differences between two observed captures/i);
  });
});
