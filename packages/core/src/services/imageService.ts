import type { CanonicalContent, CanonicalMetadata, ExtractedFieldSource, FieldProvenance, ImageObject, PageKind } from "@auth-layer/shared";

import { NORMALIZATION_VERSION } from "./extractionService.js";

export const IMAGE_EXTRACTOR_VERSION = "image-metadata-v1";

const fallbackSource = (strategy: string, note?: string): ExtractedFieldSource => ({
  sourceKind: "fallback",
  strategy,
  note
});

const notFoundSource = (strategy: string): ExtractedFieldSource => ({
  sourceKind: "not-found",
  strategy
});

const buildFieldProvenance = (titleFound: boolean, publishedFound: boolean): FieldProvenance => ({
  title: titleFound ? fallbackSource("Uploaded image filename") : notFoundSource("Uploaded image filename"),
  subtitle: notFoundSource("Image subtitles are not extracted in v1"),
  author: notFoundSource("Image author is not extracted in v1"),
  publishedAtClaimed: publishedFound ? fallbackSource("Uploaded image metadata publishedAt") : notFoundSource("Uploaded image metadata publishedAt"),
  canonicalUrl: notFoundSource("Uploaded image files do not expose canonical URLs in v1")
});

const filenameStem = (fileName: string): string => fileName.replace(/\.[a-z0-9]+$/i, "");

const parsePng = (buffer: Buffer): { width: number; height: number } | undefined => {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
};

const parseGif = (buffer: Buffer): { width: number; height: number } | undefined => {
  const header = buffer.subarray(0, 6).toString("ascii");
  if (buffer.length < 10 || (header !== "GIF87a" && header !== "GIF89a")) {
    return undefined;
  }
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8)
  };
};

const parseJpeg = (buffer: Buffer): { width: number; height: number } | undefined => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) {
      break;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > buffer.length) {
      break;
    }
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return undefined;
};

const parseWebp = (buffer: Buffer): { width: number; height: number } | undefined => {
  if (buffer.length < 30 || buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
    return undefined;
  }

  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 ") {
    if (buffer.length < 30) {
      return undefined;
    }
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  if (chunk === "VP8L") {
    const b1 = buffer[21] ?? 0;
    const b2 = buffer[22] ?? 0;
    const b3 = buffer[23] ?? 0;
    const b4 = buffer[24] ?? 0;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    };
  }

  if (chunk === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }

  return undefined;
};

const parseDimensions = (buffer: Buffer): { width?: number; height?: number } =>
  parsePng(buffer) ?? parseJpeg(buffer) ?? parseGif(buffer) ?? parseWebp(buffer) ?? {};

export class ImageService {
  extract(input: {
    buffer: Buffer;
    sourceUrl: string;
    sourceLabel: string;
    fileName: string;
    mediaType: string;
    byteSize: number;
    contentHash: string;
    caption?: string;
    altText?: string;
    capturedAt?: string;
    publishedAt?: string;
    derivativeOfContentHash?: string;
  }): {
    pageKind: PageKind;
    extractionStatus: "success";
    canonicalContent: CanonicalContent;
    metadata: CanonicalMetadata;
  } {
    const dimensions = parseDimensions(input.buffer);
    const imageObject: ImageObject = {
      type: "image",
      mimeType: input.mediaType,
      byteLength: input.byteSize,
      contentHash: input.contentHash,
      width: dimensions.width,
      height: dimensions.height,
      filename: input.fileName,
      caption: input.caption,
      altText: input.altText,
      capturedAt: input.capturedAt,
      publishedAt: input.publishedAt,
      derivativeOfContentHash: input.derivativeOfContentHash
    };

    const blocks = [input.caption, input.altText]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((text, index) => ({ order: index, type: "paragraph" as const, text: text.trim() }));
    const bodyMarkdown = blocks.map((block) => block.text).join("\n\n");
    const title = input.caption?.trim() || filenameStem(input.fileName);
    const fieldProvenance = buildFieldProvenance(Boolean(title), Boolean(input.publishedAt));

    return {
      pageKind: "generic",
      extractionStatus: "success",
      canonicalContent: {
        schemaVersion: 3,
        artifactType: "image-file",
        normalizationVersion: NORMALIZATION_VERSION,
        sourceUrl: input.sourceUrl,
        sourceLabel: input.sourceLabel,
        fileName: input.fileName,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        title,
        publishedAtClaimed: input.publishedAt,
        blocks,
        bodyMarkdown,
        extractorVersion: IMAGE_EXTRACTOR_VERSION,
        stats: {
          characterCount: bodyMarkdown.length,
          wordCount: bodyMarkdown ? bodyMarkdown.split(/\s+/).length : 0,
          blockCount: blocks.length,
          paragraphCount: blocks.length,
          headingCount: 0,
          imageCount: 1
        },
        diagnostics: {
          confidence: 0.95,
          warnings: input.derivativeOfContentHash ? ["This image declares a derivative source hash in its packaged metadata."] : []
        },
        imageObject
      },
      metadata: {
        schemaVersion: 3,
        artifactType: "image-file",
        normalizationVersion: NORMALIZATION_VERSION,
        sourceUrl: input.sourceUrl,
        sourceLabel: input.sourceLabel,
        fileName: input.fileName,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        title,
        publishedAtClaimed: input.publishedAt,
        extractorVersion: IMAGE_EXTRACTOR_VERSION,
        fieldProvenance,
        imageObject
      }
    };
  }
}


