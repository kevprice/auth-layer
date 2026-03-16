import type { CanonicalContent, CanonicalMetadata, ExtractedFieldSource, FieldProvenance, PageKind } from "@auth-layer/shared";

import { NORMALIZATION_VERSION } from "./extractionService.js";

export const PDF_EXTRACTOR_VERSION = "pdf-text-v1";

const fallbackSource = (strategy: string, note?: string): ExtractedFieldSource => ({
  sourceKind: "fallback",
  strategy,
  note
});

const notFoundSource = (strategy: string): ExtractedFieldSource => ({
  sourceKind: "not-found",
  strategy
});

const buildFieldProvenance = (titleFound: boolean, authorFound: boolean, publishedFound: boolean): FieldProvenance => ({
  title: titleFound ? fallbackSource("PDF document title") : notFoundSource("PDF document title"),
  subtitle: notFoundSource("PDF subtitles are not extracted in v1"),
  author: authorFound ? fallbackSource("PDF document author") : notFoundSource("PDF document author"),
  publishedAtClaimed: publishedFound ? fallbackSource("PDF document creation date") : notFoundSource("PDF document creation date"),
  canonicalUrl: notFoundSource("PDF files do not expose canonical URLs in v1")
});

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const decodePdfString = (value: string): string =>
  normalizeWhitespace(
    value
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\\/g, "\\")
  );

const matchFirst = (pattern: RegExp, input: string): string | undefined => {
  const match = pattern.exec(input);
  return match?.[1] ? decodePdfString(match[1]) : undefined;
};

const extractTextStrings = (pdfText: string): string[] => {
  const matches = [...pdfText.matchAll(/\(([^()]*)\)\s*(?:Tj|TJ|')/g)];
  const values = matches
    .map((match) => decodePdfString(match[1] ?? ""))
    .filter((value) => value.length >= 24 && !value.startsWith("D:"));

  return [...new Set(values)];
};

const extractCreatedAt = (pdfText: string): string | undefined => {
  const raw = matchFirst(/\/CreationDate\s*\(([^)]*)\)/, pdfText);
  if (!raw) {
    return undefined;
  }

  const compact = raw.replace(/^D:/, "");
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(compact);
  if (!match) {
    return raw;
  }

  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
};

export class PdfService {
  extract(input: {
    buffer: Buffer;
    sourceUrl: string;
    sourceLabel: string;
    fileName: string;
    mediaType: string;
    byteSize: number;
  }): {
    pageKind: PageKind;
    extractionStatus: "success" | "fallback";
    canonicalContent: CanonicalContent;
    metadata: CanonicalMetadata;
  } {
    const pdfText = input.buffer.toString("latin1");
    const title = matchFirst(/\/Title\s*\(([^)]*)\)/, pdfText) ?? input.fileName.replace(/\.pdf$/i, "");
    const author = matchFirst(/\/Author\s*\(([^)]*)\)/, pdfText);
    const publishedAtClaimed = extractCreatedAt(pdfText);
    const pageCount = Math.max(1, (pdfText.match(/\/Type\s*\/Page\b/g) ?? []).length || 1);
    const textBlocks = extractTextStrings(pdfText);
    const blocks = textBlocks.map((text, index) => ({ order: index, type: "paragraph" as const, text }));
    const bodyMarkdown = textBlocks.join("\n\n");
    const textAvailable = textBlocks.length > 0;
    const diagnostics = {
      confidence: textAvailable ? 0.76 : 0.3,
      warnings: textAvailable ? [] : ["No extractable PDF text blocks were found. Verification still covers exact file integrity."]
    };
    const stats = {
      characterCount: bodyMarkdown.length,
      wordCount: bodyMarkdown ? bodyMarkdown.split(/\s+/).length : 0,
      blockCount: blocks.length,
      paragraphCount: blocks.length,
      headingCount: 0,
      imageCount: 0
    };
    const fieldProvenance = buildFieldProvenance(Boolean(title), Boolean(author), Boolean(publishedAtClaimed));

    return {
      pageKind: "generic",
      extractionStatus: textAvailable ? "success" : "fallback",
      canonicalContent: {
        schemaVersion: 2,
        artifactType: "pdf-file",
        normalizationVersion: NORMALIZATION_VERSION,
        sourceUrl: input.sourceUrl,
        sourceLabel: input.sourceLabel,
        fileName: input.fileName,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        pageCount,
        textAvailable,
        title,
        author,
        publishedAtClaimed,
        blocks,
        bodyMarkdown,
        extractorVersion: PDF_EXTRACTOR_VERSION,
        stats,
        diagnostics
      },
      metadata: {
        schemaVersion: 2,
        artifactType: "pdf-file",
        normalizationVersion: NORMALIZATION_VERSION,
        sourceUrl: input.sourceUrl,
        sourceLabel: input.sourceLabel,
        fileName: input.fileName,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        pageCount,
        textAvailable,
        title,
        author,
        publishedAtClaimed,
        extractorVersion: PDF_EXTRACTOR_VERSION,
        fieldProvenance
      }
    };
  }
}
