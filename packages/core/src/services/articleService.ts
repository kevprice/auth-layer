import type { CanonicalBlock, CanonicalContent, CanonicalMetadata, ExtractedFieldSource, FieldProvenance, PageKind, WordPressArticlePayload, ArticleObject } from "@auth-layer/shared";

import { NORMALIZATION_VERSION } from "./extractionService.js";

export const WORDPRESS_ARTICLE_EXTRACTOR_VERSION = "wordpress-publish-v1";

const fallbackSource = (strategy: string, note?: string): ExtractedFieldSource => ({
  sourceKind: "fallback",
  strategy,
  note
});

const notFoundSource = (strategy: string): ExtractedFieldSource => ({
  sourceKind: "not-found",
  strategy
});

const normalizeText = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const extractParagraphs = (bodyHtml: string): string[] => {
  const paragraphMatches = Array.from(bodyHtml.matchAll(/<(p|li|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi), (match) => normalizeText(match[2] ?? ""));
  const filtered = paragraphMatches.filter(Boolean);
  if (filtered.length) {
    return filtered;
  }
  const fallback = normalizeText(bodyHtml);
  return fallback ? fallback.split(/\n\n+/).map((paragraph) => paragraph.trim()).filter(Boolean) : [];
};

const buildBlocks = (payload: WordPressArticlePayload): CanonicalBlock[] => {
  const blocks: CanonicalBlock[] = [];
  let order = 0;
  const title = payload.title.trim();
  if (title) {
    blocks.push({ order: order++, type: "heading", level: 1, text: title });
  }
  for (const paragraph of extractParagraphs(payload.bodyHtml)) {
    blocks.push({ order: order++, type: "paragraph", text: paragraph });
  }
  return blocks;
};

const buildFieldProvenance = (payload: WordPressArticlePayload): FieldProvenance => ({
  title: payload.title.trim() ? fallbackSource("WordPress post payload title") : notFoundSource("WordPress post payload title"),
  subtitle: payload.excerpt?.trim() ? fallbackSource("WordPress post payload excerpt") : notFoundSource("WordPress post payload excerpt"),
  author: payload.authorDisplayName?.trim() ? fallbackSource("WordPress post payload authorDisplayName") : notFoundSource("WordPress post payload authorDisplayName"),
  publishedAtClaimed: payload.publishedAt?.trim() ? fallbackSource("WordPress post payload publishedAt") : notFoundSource("WordPress post payload publishedAt"),
  canonicalUrl: payload.canonicalUrl.trim() ? fallbackSource("WordPress post payload canonicalUrl") : notFoundSource("WordPress post payload canonicalUrl")
});

export const buildCanonicalArticleHtml = (payload: WordPressArticlePayload): string => {
  const language = payload.language?.trim() || "en";
  const excerpt = payload.excerpt?.trim();
  const author = payload.authorDisplayName?.trim();
  const publishedAt = payload.publishedAt?.trim();
  const updatedAt = payload.updatedAt?.trim();
  const featuredImageUrl = payload.featuredImageUrl?.trim();
  const categories = payload.categories?.filter(Boolean) ?? [];
  const tags = payload.tags?.filter(Boolean) ?? [];

  return [
    "<!doctype html>",
    `<html lang=\"${language}\">`,
    "  <head>",
    "    <meta charset=\"utf-8\" />",
    `    <title>${payload.title.trim()}</title>`,
    `    <link rel=\"canonical\" href=\"${payload.canonicalUrl.trim()}\" />`,
    `    <meta name=\"auth-layer:site-identifier\" content=\"${payload.siteIdentifier.trim()}\" />`,
    author ? `    <meta name=\"author\" content=\"${author}\" />` : undefined,
    excerpt ? `    <meta name=\"description\" content=\"${excerpt}\" />` : undefined,
    publishedAt ? `    <meta property=\"article:published_time\" content=\"${publishedAt}\" />` : undefined,
    updatedAt ? `    <meta property=\"article:modified_time\" content=\"${updatedAt}\" />` : undefined,
    featuredImageUrl ? `    <meta property=\"og:image\" content=\"${featuredImageUrl}\" />` : undefined,
    categories.map((category) => `    <meta name=\"article:section\" content=\"${category.trim()}\" />`).join("\n") || undefined,
    tags.map((tag) => `    <meta property=\"article:tag\" content=\"${tag.trim()}\" />`).join("\n") || undefined,
    "  </head>",
    "  <body>",
    `    <article data-post-id=\"${payload.postId.trim()}\" data-revision-id=\"${payload.revisionId?.trim() ?? ""}\">`,
    `      <h1>${payload.title.trim()}</h1>`,
    excerpt ? `      <p class=\"excerpt\">${excerpt}</p>` : undefined,
    `      <div class=\"article-body\">${payload.bodyHtml.trim()}</div>`,
    "    </article>",
    "  </body>",
    "</html>"
  ].filter((line): line is string => Boolean(line)).join("\n");
};

export class ArticleService {
  normalizePayload(payload: WordPressArticlePayload): WordPressArticlePayload {
    return {
      schemaVersion: payload.schemaVersion ?? 1,
      siteIdentifier: payload.siteIdentifier.trim(),
      siteUrl: payload.siteUrl.trim(),
      postId: payload.postId.trim(),
      revisionId: payload.revisionId?.trim() || undefined,
      publishedUrl: payload.publishedUrl.trim(),
      canonicalUrl: payload.canonicalUrl.trim(),
      title: payload.title.trim(),
      bodyHtml: payload.bodyHtml.trim(),
      excerpt: payload.excerpt?.trim() || undefined,
      authorDisplayName: payload.authorDisplayName?.trim() || undefined,
      publishedAt: payload.publishedAt?.trim() || undefined,
      updatedAt: payload.updatedAt?.trim() || undefined,
      categories: payload.categories?.map((value) => value.trim()).filter(Boolean) ?? [],
      tags: payload.tags?.map((value) => value.trim()).filter(Boolean) ?? [],
      featuredImageUrl: payload.featuredImageUrl?.trim() || undefined,
      language: payload.language?.trim() || undefined
    };
  }

  extract(payload: WordPressArticlePayload, input: { sourceLabel: string; mediaType: string; byteSize: number }): {
    pageKind: PageKind;
    extractionStatus: "success";
    canonicalContent: CanonicalContent;
    metadata: CanonicalMetadata;
  } {
    const normalizedPayload = this.normalizePayload(payload);
    const blocks = buildBlocks(normalizedPayload);
    const bodyMarkdown = blocks.filter((block) => block.type === "paragraph").map((block) => block.text).join("\n\n");
    const articleObject: ArticleObject = {
      type: "article",
      siteIdentifier: normalizedPayload.siteIdentifier,
      siteUrl: normalizedPayload.siteUrl,
      postId: normalizedPayload.postId,
      revisionId: normalizedPayload.revisionId,
      publishedUrl: normalizedPayload.publishedUrl,
      canonicalUrl: normalizedPayload.canonicalUrl,
      excerpt: normalizedPayload.excerpt,
      categories: normalizedPayload.categories,
      tags: normalizedPayload.tags,
      featuredImageUrl: normalizedPayload.featuredImageUrl,
      authorDisplayName: normalizedPayload.authorDisplayName,
      publishedAt: normalizedPayload.publishedAt,
      updatedAt: normalizedPayload.updatedAt,
      language: normalizedPayload.language
    };

    return {
      pageKind: "article",
      extractionStatus: "success",
      canonicalContent: {
        schemaVersion: 3,
        artifactType: "article-publish",
        normalizationVersion: NORMALIZATION_VERSION,
        sourceUrl: normalizedPayload.canonicalUrl,
        sourceLabel: input.sourceLabel,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        textAvailable: true,
        canonicalUrl: normalizedPayload.canonicalUrl,
        title: normalizedPayload.title,
        subtitle: normalizedPayload.excerpt,
        author: normalizedPayload.authorDisplayName,
        publishedAtClaimed: normalizedPayload.publishedAt,
        articleObject,
        blocks,
        bodyMarkdown,
        extractorVersion: WORDPRESS_ARTICLE_EXTRACTOR_VERSION,
        stats: {
          characterCount: bodyMarkdown.length,
          wordCount: bodyMarkdown ? bodyMarkdown.split(/\s+/).length : 0,
          blockCount: blocks.length,
          paragraphCount: blocks.filter((block) => block.type === "paragraph").length,
          headingCount: blocks.filter((block) => block.type === "heading").length,
          imageCount: normalizedPayload.featuredImageUrl ? 1 : 0
        },
        diagnostics: {
          confidence: 0.98,
          warnings: []
        }
      },
      metadata: {
        schemaVersion: 3,
        artifactType: "article-publish",
        normalizationVersion: NORMALIZATION_VERSION,
        sourceUrl: normalizedPayload.canonicalUrl,
        sourceLabel: input.sourceLabel,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        textAvailable: true,
        canonicalUrl: normalizedPayload.canonicalUrl,
        title: normalizedPayload.title,
        subtitle: normalizedPayload.excerpt,
        author: normalizedPayload.authorDisplayName,
        publishedAtClaimed: normalizedPayload.publishedAt,
        articleObject,
        language: normalizedPayload.language,
        extractorVersion: WORDPRESS_ARTICLE_EXTRACTOR_VERSION,
        fieldProvenance: buildFieldProvenance(normalizedPayload)
      }
    };
  }
}

export const buildArticleRevisionLineage = (input: {
  currentCaptureId: string;
  currentText: string;
  currentTitle?: string;
  currentCapturedAt?: string;
  currentSourceLabel?: string;
  previousCaptureId?: string;
  previousText?: string;
  previousTitle?: string;
  previousCapturedAt?: string;
  previousSourceLabel?: string;
}) => {
  if (!input.previousCaptureId || !input.previousText) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    bundleType: "auth-layer-lineage-bundle" as const,
    subject: input.currentTitle ?? input.currentSourceLabel ?? input.currentCaptureId,
    subjectIdentifiers: [input.currentCaptureId],
    contentObjects: [
      {
        id: `capture:${input.previousCaptureId}`,
        type: "article-snippet" as const,
        text: input.previousText,
        capturedAt: input.previousCapturedAt,
        sourceRef: {
          captureId: input.previousCaptureId,
          sourceLabel: input.previousSourceLabel
        },
        metadata: {
          title: input.previousTitle
        }
      },
      {
        id: `capture:${input.currentCaptureId}`,
        type: "article-snippet" as const,
        text: input.currentText,
        capturedAt: input.currentCapturedAt,
        sourceRef: {
          captureId: input.currentCaptureId,
          sourceLabel: input.currentSourceLabel
        },
        metadata: {
          title: input.currentTitle
        }
      }
    ],
    edges: [
      {
        from: `capture:${input.previousCaptureId}`,
        to: `capture:${input.currentCaptureId}`,
        derivationType: "revision" as const,
        notes: "Later WordPress article revision observed and packaged by the operator."
      }
    ],
    rootObjectIds: [`capture:${input.previousCaptureId}`]
  };
};
