import type {
  CanonicalBlock,
  CanonicalContent,
  CanonicalMetadata,
  CaptureComparison,
  CaptureComparisonBlockSummary,
  CaptureComparisonDiagnostics,
  CaptureComparisonFields,
  CaptureComparisonSide,
  CaptureRecord,
  PageKind
} from "@auth-layer/shared";

import { normalizeString } from "../utils/stableJson.js";

export type ComparisonSource = Pick<CaptureRecord, "id" | "canonicalContentHash" | "metadataHash" | "claimedPublishedAt"> & {
  title?: string;
  author?: string;
};

export type ComparisonResult = {
  comparedToCaptureId?: string;
  contentChangedFromPrevious?: boolean;
  metadataChangedFromPrevious?: boolean;
  titleChangedFromPrevious?: boolean;
  authorChangedFromPrevious?: boolean;
  claimedPublishedAtChangedFromPrevious?: boolean;
};

const normalizeOptionalString = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeString(value);
  return normalized || undefined;
};

const changed = (current: string | undefined, previous: string | undefined): boolean =>
  normalizeOptionalString(current) !== normalizeOptionalString(previous);

const normalizeBlockText = (value: string | undefined): string | undefined => normalizeOptionalString(value);

const toMultiset = (values: string[]): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return counts;
};

const multisetDifference = (left: string[], right: string[]): string[] => {
  const rightCounts = toMultiset(right);
  const difference: string[] = [];

  for (const value of left) {
    const current = rightCounts.get(value) ?? 0;
    if (current > 0) {
      rightCounts.set(value, current - 1);
      continue;
    }
    difference.push(value);
  }

  return difference;
};

const canonicalParagraphs = (content?: CanonicalContent): string[] =>
  (content?.blocks ?? [])
    .filter((block) => block.type === "paragraph")
    .map((block) => normalizeBlockText(block.text))
    .filter((value): value is string => Boolean(value));

const canonicalHeadings = (content?: CanonicalContent): string[] => {
  const headings = (content?.blocks ?? [])
    .filter((block) => block.type === "heading")
    .map((block) => normalizeBlockText(block.text))
    .filter((value): value is string => Boolean(value));

  if (headings.length > 0) {
    return headings;
  }

  const title = normalizeBlockText(content?.title);
  return title ? [title] : [];
};

const summarizeBlockDiff = (older?: CanonicalContent, newer?: CanonicalContent): CaptureComparisonBlockSummary => {
  const olderParagraphs = canonicalParagraphs(older);
  const newerParagraphs = canonicalParagraphs(newer);
  const addedParagraphs = multisetDifference(newerParagraphs, olderParagraphs);
  const removedParagraphs = multisetDifference(olderParagraphs, newerParagraphs);

  const olderHeadings = canonicalHeadings(older);
  const newerHeadings = canonicalHeadings(newer);
  const maxHeadings = Math.max(olderHeadings.length, newerHeadings.length);
  const changedHeadingSamples: CaptureComparisonBlockSummary["changedHeadingSamples"] = [];

  for (let index = 0; index < maxHeadings; index += 1) {
    if (olderHeadings[index] === newerHeadings[index]) {
      continue;
    }

    changedHeadingSamples.push({
      index,
      from: olderHeadings[index],
      to: newerHeadings[index]
    });
  }

  return {
    paragraphsAdded: addedParagraphs.length,
    paragraphsRemoved: removedParagraphs.length,
    headingsChanged: changedHeadingSamples.length,
    addedParagraphSamples: addedParagraphs.slice(0, 3),
    removedParagraphSamples: removedParagraphs.slice(0, 3),
    changedHeadingSamples: changedHeadingSamples.slice(0, 3)
  };
};

const diagnosticsNotes = (older: CaptureComparisonSide, newer: CaptureComparisonSide, fields: CaptureComparisonFields): string[] => {
  const notes: string[] = [];
  const olderConfidence = older.canonicalContent?.diagnostics.confidence;
  const newerConfidence = newer.canonicalContent?.diagnostics.confidence;
  const olderWarnings = new Set(older.canonicalContent?.diagnostics.warnings ?? []);
  const newerWarnings = new Set(newer.canonicalContent?.diagnostics.warnings ?? []);

  if (fields.extractorVersionChanged) {
    notes.push("Extractor version changed between these observed captures. Review differences carefully before treating them as semantic edits.");
  }

  if (fields.pageKindChanged) {
    notes.push("Page classification changed between captures. Extraction drift may explain some observed differences.");
  }

  if (olderConfidence !== undefined && newerConfidence !== undefined && Math.abs(newerConfidence - olderConfidence) >= 0.15) {
    notes.push("Extraction confidence changed materially between captures. Manual review is recommended before drawing conclusions.");
  }

  const addedWarnings = [...newerWarnings].filter((warning) => !olderWarnings.has(warning));
  if (addedWarnings.length > 0) {
    notes.push(`New extraction warnings appeared: ${addedWarnings.slice(0, 2).join("; ")}.`);
  }

  if (!fields.canonicalContentHashChanged && (fields.extractorVersionChanged || fields.pageKindChanged)) {
    notes.push("Canonical content hash stayed stable even though extraction settings changed. That suggests the underlying extracted content remained consistent.");
  }

  if (fields.canonicalContentHashChanged && (fields.extractorVersionChanged || fields.pageKindChanged)) {
    notes.push("Canonical content changed alongside extraction drift indicators. Treat the diff as observed output from two captures, not proof of publisher intent.");
  }

  return notes;
};

const buildDiagnostics = (older: CaptureComparisonSide, newer: CaptureComparisonSide, fields: CaptureComparisonFields): CaptureComparisonDiagnostics => ({
  older: {
    captureId: older.capture.id,
    pageKind: older.capture.pageKind,
    extractionStatus: older.capture.contentExtractionStatus,
    extractorVersion: older.canonicalContent?.extractorVersion ?? older.capture.extractorVersion,
    confidence: older.canonicalContent?.diagnostics.confidence,
    warnings: older.canonicalContent?.diagnostics.warnings ?? []
  },
  newer: {
    captureId: newer.capture.id,
    pageKind: newer.capture.pageKind,
    extractionStatus: newer.capture.contentExtractionStatus,
    extractorVersion: newer.canonicalContent?.extractorVersion ?? newer.capture.extractorVersion,
    confidence: newer.canonicalContent?.diagnostics.confidence,
    warnings: newer.canonicalContent?.diagnostics.warnings ?? []
  },
  notes: diagnosticsNotes(older, newer, fields)
});

const buildFieldChanges = (older: CaptureComparisonSide, newer: CaptureComparisonSide): CaptureComparisonFields => ({
  canonicalContentHashChanged: older.capture.canonicalContentHash !== newer.capture.canonicalContentHash,
  metadataHashChanged: older.capture.metadataHash !== newer.capture.metadataHash,
  titleChanged: changed(newer.metadata?.title ?? newer.canonicalContent?.title, older.metadata?.title ?? older.canonicalContent?.title),
  authorChanged: changed(newer.metadata?.author ?? newer.canonicalContent?.author, older.metadata?.author ?? older.canonicalContent?.author),
  claimedPublishedAtChanged: changed(
    newer.metadata?.publishedAtClaimed ?? newer.canonicalContent?.publishedAtClaimed ?? newer.capture.claimedPublishedAt,
    older.metadata?.publishedAtClaimed ?? older.canonicalContent?.publishedAtClaimed ?? older.capture.claimedPublishedAt
  ),
  pageKindChanged: (older.capture.pageKind ?? "unknown") !== (newer.capture.pageKind ?? "unknown"),
  extractorVersionChanged:
    (older.canonicalContent?.extractorVersion ?? older.capture.extractorVersion) !==
    (newer.canonicalContent?.extractorVersion ?? newer.capture.extractorVersion)
});

const fieldChangeLabel = (label: string, changedValue: boolean): string => `${label}: ${changedValue ? "changed" : "stable"}`;

const buildChangeSummary = (fields: CaptureComparisonFields, blockSummary: CaptureComparisonBlockSummary): string[] => {
  const summary = [
    fieldChangeLabel("Canonical content hash", fields.canonicalContentHashChanged),
    fieldChangeLabel("Metadata hash", fields.metadataHashChanged),
    fieldChangeLabel("Title", fields.titleChanged),
    fieldChangeLabel("Author", fields.authorChanged),
    fieldChangeLabel("Claimed published date", fields.claimedPublishedAtChanged),
    fieldChangeLabel("Page kind", fields.pageKindChanged),
    fieldChangeLabel("Extractor version", fields.extractorVersionChanged)
  ];

  if (blockSummary.paragraphsAdded > 0 || blockSummary.paragraphsRemoved > 0 || blockSummary.headingsChanged > 0) {
    summary.push(
      `Block diff summary: ${blockSummary.paragraphsAdded} paragraphs added, ${blockSummary.paragraphsRemoved} paragraphs removed, ${blockSummary.headingsChanged} headings changed.`
    );
  } else {
    summary.push("Block diff summary: no paragraph additions/removals or heading changes were detected in the canonical block model.");
  }

  return summary;
};

export const compareWithPreviousCapture = (
  currentCapture: ComparisonSource,
  previousCapture: ComparisonSource | undefined
): ComparisonResult => {
  if (!previousCapture) {
    return {};
  }

  return {
    comparedToCaptureId: previousCapture.id,
    contentChangedFromPrevious:
      previousCapture.canonicalContentHash !== undefined &&
      currentCapture.canonicalContentHash !== undefined &&
      previousCapture.canonicalContentHash !== currentCapture.canonicalContentHash,
    metadataChangedFromPrevious:
      previousCapture.metadataHash !== undefined &&
      currentCapture.metadataHash !== undefined &&
      previousCapture.metadataHash !== currentCapture.metadataHash,
    titleChangedFromPrevious: changed(currentCapture.title, previousCapture.title),
    authorChangedFromPrevious: changed(currentCapture.author, previousCapture.author),
    claimedPublishedAtChangedFromPrevious: changed(currentCapture.claimedPublishedAt, previousCapture.claimedPublishedAt)
  };
};

export const compareCaptureDetails = (input: {
  normalizedRequestedUrl: string;
  basis: CaptureComparison["basis"];
  older: CaptureComparisonSide;
  newer: CaptureComparisonSide;
}): CaptureComparison => {
  const fields = buildFieldChanges(input.older, input.newer);
  const blockSummary = summarizeBlockDiff(input.older.canonicalContent, input.newer.canonicalContent);

  return {
    schemaVersion: 1,
    normalizedRequestedUrl: input.normalizedRequestedUrl,
    basis: input.basis,
    older: input.older,
    newer: input.newer,
    fields,
    blockSummary,
    diagnostics: buildDiagnostics(input.older, input.newer, fields),
    changeSummary: buildChangeSummary(fields, blockSummary),
    observationStatement:
      "This comparison describes differences between two observed captures of the same URL. It does not prove publisher intent, original creation time, or why the page changed."
  };
};

