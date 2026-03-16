import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type {
  CanonicalBlock,
  CanonicalBlockType,
  CanonicalContent,
  CanonicalMetadata,
  ContentExtractionStatus,
  ExtractedFieldSource,
  ExtractionDiagnostics,
  ExtractionStats,
  FieldProvenance,
  PageKind
} from "@auth-layer/shared";

import { normalizeString } from "../utils/stableJson.js";
import { normalizeContentUrl } from "../utils/url.js";

export const EXTRACTOR_VERSION = "readability-v1";
export const NORMALIZATION_VERSION = "canonical-v2";
export const CANONICAL_CONTENT_SCHEMA_VERSION = 2;
export const CANONICAL_METADATA_SCHEMA_VERSION = 2;

type FieldCandidate = {
  selector: string;
  attribute?: string;
  sourceKind: ExtractedFieldSource["sourceKind"];
  strategy: string;
};

export type ExtractionResult = {
  canonicalContent: CanonicalContent;
  metadata: CanonicalMetadata;
  pageKind: PageKind;
  extractionStatus: ContentExtractionStatus;
};

const FIELD_CANDIDATES: Record<keyof FieldProvenance, FieldCandidate[]> = {
  canonicalUrl: [{ selector: "link[rel='canonical']", attribute: "href", sourceKind: "link-rel", strategy: "HTML canonical link" }],
  title: [
    { selector: "meta[property='og:title']", attribute: "content", sourceKind: "meta-tag", strategy: "Open Graph title" },
    { selector: "meta[name='twitter:title']", attribute: "content", sourceKind: "meta-tag", strategy: "Twitter card title" }
  ],
  subtitle: [
    { selector: "meta[name='description']", attribute: "content", sourceKind: "meta-tag", strategy: "Meta description" },
    { selector: "meta[property='og:description']", attribute: "content", sourceKind: "meta-tag", strategy: "Open Graph description" }
  ],
  author: [
    { selector: "meta[name='author']", attribute: "content", sourceKind: "meta-tag", strategy: "Author meta tag" },
    { selector: "meta[property='article:author']", attribute: "content", sourceKind: "meta-tag", strategy: "Article author meta tag" }
  ],
  publishedAtClaimed: [
    { selector: "meta[property='article:published_time']", attribute: "content", sourceKind: "meta-tag", strategy: "Article published time meta tag" },
    { selector: "meta[name='article:published_time']", attribute: "content", sourceKind: "meta-tag", strategy: "Article published time name meta tag" },
    { selector: "meta[name='pubdate']", attribute: "content", sourceKind: "meta-tag", strategy: "Pubdate meta tag" },
    { selector: "meta[property='og:published_time']", attribute: "content", sourceKind: "meta-tag", strategy: "Open Graph published time meta tag" },
    { selector: "meta[itemprop='datePublished']", attribute: "content", sourceKind: "meta-tag", strategy: "Schema.org datePublished meta tag" }
  ]
};

const BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li, blockquote";
const NOISE_SELECTOR = "script, style, noscript, nav, footer, aside, form, iframe, [role='navigation'], .ad, .ads, .advertisement, [data-testid*='cookie']";

const missingFieldSource = (strategy: string): ExtractedFieldSource => ({
  sourceKind: "not-found",
  strategy,
  note: "Field was not found in the captured page."
});

const getFieldFromCandidates = (document: Document, candidates: FieldCandidate[]): { value?: string; source: ExtractedFieldSource } => {
  for (const candidate of candidates) {
    const element = document.querySelector(candidate.selector);

    if (!element) {
      continue;
    }

    const rawValue = candidate.attribute ? element.getAttribute(candidate.attribute) : element.textContent;
    const normalizedValue = normalizeString(rawValue ?? "");

    if (!normalizedValue) {
      continue;
    }

    return {
      value: normalizedValue,
      source: {
        sourceKind: candidate.sourceKind,
        strategy: candidate.strategy,
        selector: candidate.selector,
        attribute: candidate.attribute
      }
    };
  }

  return {
    source: missingFieldSource(candidates[0]?.strategy ?? "Field extraction")
  };
};

const blockTypeForElement = (tagName: string): CanonicalBlockType => {
  if (/^H[1-6]$/.test(tagName)) {
    return "heading";
  }

  if (tagName === "BLOCKQUOTE") {
    return "blockquote";
  }

  if (tagName === "LI") {
    return "list-item";
  }

  return "paragraph";
};

const extractBlocks = (document: Document): CanonicalBlock[] => {
  const blocks: CanonicalBlock[] = [];

  for (const element of Array.from(document.querySelectorAll(BLOCK_SELECTOR))) {
    const text = normalizeString(element.textContent ?? "");

    if (!text) {
      continue;
    }

    const nextBlock: CanonicalBlock = {
      order: blocks.length,
      type: blockTypeForElement(element.tagName),
      text
    };

    if (nextBlock.type === "heading") {
      nextBlock.level = Number(element.tagName.slice(1));
    }

    const previousBlock = blocks[blocks.length - 1];
    if (previousBlock && previousBlock.type === nextBlock.type && previousBlock.text === nextBlock.text) {
      continue;
    }

    blocks.push(nextBlock);
  }

  return blocks;
};

const buildBodyMarkdown = (blocks: CanonicalBlock[]): string => blocks.map((block) => block.text).join("\n\n");

const extractImageUrls = (document: Document, baseUrl: string): string[] | undefined => {
  const urls = Array.from(document.querySelectorAll("img[src]"))
    .map((element) => normalizeContentUrl(element.getAttribute("src") ?? undefined, baseUrl))
    .filter((value): value is string => Boolean(value));

  const unique = urls.filter((value, index) => urls.indexOf(value) === index).slice(0, 8);
  return unique.length > 0 ? unique : undefined;
};

const buildStats = (blocks: CanonicalBlock[], imageUrls?: string[]): ExtractionStats => {
  const bodyText = buildBodyMarkdown(blocks);
  return {
    characterCount: bodyText.length,
    wordCount: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
    blockCount: blocks.length,
    paragraphCount: blocks.filter((block) => block.type === "paragraph" || block.type === "blockquote" || block.type === "list-item").length,
    headingCount: blocks.filter((block) => block.type === "heading").length,
    imageCount: imageUrls?.length ?? 0
  };
};

const buildDiagnostics = (input: {
  pageKind: PageKind;
  stats: ExtractionStats;
  title?: string;
  author?: string;
  publishedAtClaimed?: string;
  canonicalUrl?: string;
}): ExtractionDiagnostics => {
  const warnings: string[] = [];

  if (input.pageKind === "generic") {
    warnings.push("Main article extraction fell back to generic page parsing.");
  }

  if (input.stats.characterCount < 400) {
    warnings.push("Canonical content is short; review the extracted blocks before relying on comparisons.");
  }

  if (input.stats.headingCount === 0) {
    warnings.push("No heading blocks were extracted from the canonical content.");
  }

  let confidence = input.pageKind === "article" ? 0.72 : 0.48;
  if (input.title) confidence += 0.08;
  if (input.author) confidence += 0.06;
  if (input.publishedAtClaimed) confidence += 0.06;
  if (input.canonicalUrl) confidence += 0.04;
  confidence -= warnings.length * 0.04;

  return {
    confidence: Math.max(0.2, Math.min(0.98, Number(confidence.toFixed(2)))),
    warnings
  };
};

const buildFieldProvenance = (input: {
  title: ExtractedFieldSource;
  subtitle: ExtractedFieldSource;
  author: ExtractedFieldSource;
  publishedAtClaimed: ExtractedFieldSource;
  canonicalUrl: ExtractedFieldSource;
}): FieldProvenance => input;

const applyReadabilityOverrides = (input: {
  title?: string;
  titleSource: ExtractedFieldSource;
  author?: string;
  authorSource: ExtractedFieldSource;
  readabilityTitle?: string | null;
  readabilityByline?: string | null;
}): {
  title?: string;
  titleSource: ExtractedFieldSource;
  author?: string;
  authorSource: ExtractedFieldSource;
} => {
  let title = input.title;
  let titleSource = input.titleSource;
  let author = input.author;
  let authorSource = input.authorSource;

  const readabilityTitle = normalizeString(input.readabilityTitle ?? "");
  if (readabilityTitle) {
    title = readabilityTitle;
    titleSource = {
      sourceKind: "readability",
      strategy: "Readability selected the page title.",
      note: "Preferred for article-mode captures."
    };
  }

  const readabilityByline = normalizeString(input.readabilityByline ?? "");
  if (readabilityByline) {
    author = readabilityByline;
    authorSource = {
      sourceKind: "readability",
      strategy: "Readability selected the article byline.",
      note: "Preferred for article-mode captures."
    };
  }

  return { title, titleSource, author, authorSource };
};

const extractGenericBlocks = (document: Document): CanonicalBlock[] => {
  const workingDocument = document.cloneNode(true) as Document;
  workingDocument.querySelectorAll(NOISE_SELECTOR).forEach((element) => element.remove());

  const blocks = extractBlocks(workingDocument);
  if (blocks.length > 0) {
    return blocks;
  }

  const bodyText = normalizeString(workingDocument.body?.textContent ?? "");
  return bodyText ? [{ order: 0, type: "paragraph", text: bodyText }] : [];
};

export class ExtractionService {
  async extract(input: { rawHtml: string; sourceUrl: string }): Promise<ExtractionResult> {
    const dom = new JSDOM(input.rawHtml, { url: input.sourceUrl });

    try {
      const { document } = dom.window;
      const canonicalUrlField = getFieldFromCandidates(document, FIELD_CANDIDATES.canonicalUrl);
      const titleField = getFieldFromCandidates(document, FIELD_CANDIDATES.title);
      const subtitleField = getFieldFromCandidates(document, FIELD_CANDIDATES.subtitle);
      const authorField = getFieldFromCandidates(document, FIELD_CANDIDATES.author);
      const publishedField = getFieldFromCandidates(document, FIELD_CANDIDATES.publishedAtClaimed);
      const normalizedDocumentTitle = normalizeString(document.title ?? "");
      const language = document.documentElement.getAttribute("lang") ?? undefined;

      const baseTitle = titleField.value ?? (normalizedDocumentTitle || undefined);
      const baseTitleSource: ExtractedFieldSource = titleField.value
        ? titleField.source
        : normalizedDocumentTitle
          ? {
              sourceKind: "document-title",
              strategy: "Document title fallback.",
              note: "Used because no stronger title metadata was found."
            }
          : missingFieldSource("Title extraction");

      const baseCanonicalUrl = canonicalUrlField.value ? normalizeContentUrl(canonicalUrlField.value, input.sourceUrl) : undefined;
      const baseCanonicalUrlSource = baseCanonicalUrl ? canonicalUrlField.source : missingFieldSource("Canonical URL extraction");
      const baseSubtitle = subtitleField.value ?? undefined;
      const baseSubtitleSource = subtitleField.value ? subtitleField.source : missingFieldSource("Subtitle extraction");
      const baseAuthor = authorField.value ?? undefined;
      const baseAuthorSource = authorField.value ? authorField.source : missingFieldSource("Author extraction");
      const basePublishedAt = publishedField.value ?? undefined;
      const basePublishedAtSource = publishedField.value ? publishedField.source : missingFieldSource("Claimed publish date extraction");

      const readabilityDocument = document.cloneNode(true) as Document;
      const article = new Readability(readabilityDocument).parse();

      if (article?.textContent && normalizeString(article.textContent).length >= 160) {
        const articleDom = new JSDOM(article.content, { url: baseCanonicalUrl ?? input.sourceUrl });
        try {
          const articleBlocks = extractBlocks(articleDom.window.document);
          const imageUrls = extractImageUrls(articleDom.window.document, baseCanonicalUrl ?? input.sourceUrl);
          const readabilityFields = applyReadabilityOverrides({
            title: baseTitle,
            titleSource: baseTitleSource,
            author: baseAuthor,
            authorSource: baseAuthorSource,
            readabilityTitle: article.title,
            readabilityByline: article.byline
          });
          const stats = buildStats(articleBlocks, imageUrls);
          const diagnostics = buildDiagnostics({
            pageKind: "article",
            stats,
            title: readabilityFields.title,
            author: readabilityFields.author,
            publishedAtClaimed: basePublishedAt,
            canonicalUrl: baseCanonicalUrl
          });

          return {
            pageKind: "article",
            extractionStatus: "success",
            canonicalContent: {
              schemaVersion: CANONICAL_CONTENT_SCHEMA_VERSION,
              normalizationVersion: NORMALIZATION_VERSION,
              sourceUrl: input.sourceUrl,
              canonicalUrl: baseCanonicalUrl,
              title: readabilityFields.title,
              subtitle: baseSubtitle,
              author: readabilityFields.author,
              publishedAtClaimed: basePublishedAt,
              blocks: articleBlocks,
              bodyMarkdown: buildBodyMarkdown(articleBlocks),
              imageUrls,
              extractorVersion: EXTRACTOR_VERSION,
              stats,
              diagnostics
            },
            metadata: {
              schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
              normalizationVersion: NORMALIZATION_VERSION,
              sourceUrl: input.sourceUrl,
              canonicalUrl: baseCanonicalUrl,
              title: readabilityFields.title,
              subtitle: baseSubtitle,
              author: readabilityFields.author,
              publishedAtClaimed: basePublishedAt,
              language,
              extractorVersion: EXTRACTOR_VERSION,
              fieldProvenance: buildFieldProvenance({
                title: readabilityFields.titleSource,
                subtitle: baseSubtitleSource,
                author: readabilityFields.authorSource,
                publishedAtClaimed: basePublishedAtSource,
                canonicalUrl: baseCanonicalUrlSource
              })
            }
          };
        } finally {
          articleDom.window.close();
        }
      }

      const genericBlocks = extractGenericBlocks(document);
      if (genericBlocks.length === 0) {
        throw new Error("No extractable body text found");
      }

      const imageUrls = extractImageUrls(document, baseCanonicalUrl ?? input.sourceUrl);
      const stats = buildStats(genericBlocks, imageUrls);
      const diagnostics = buildDiagnostics({
        pageKind: "generic",
        stats,
        title: baseTitle,
        author: baseAuthor,
        publishedAtClaimed: basePublishedAt,
        canonicalUrl: baseCanonicalUrl
      });

      return {
        pageKind: "generic",
        extractionStatus: "fallback",
        canonicalContent: {
          schemaVersion: CANONICAL_CONTENT_SCHEMA_VERSION,
          normalizationVersion: NORMALIZATION_VERSION,
          sourceUrl: input.sourceUrl,
          canonicalUrl: baseCanonicalUrl,
          title: baseTitle,
          subtitle: baseSubtitle,
          author: baseAuthor,
          publishedAtClaimed: basePublishedAt,
          blocks: genericBlocks,
          bodyMarkdown: buildBodyMarkdown(genericBlocks),
          imageUrls,
          extractorVersion: EXTRACTOR_VERSION,
          stats,
          diagnostics
        },
        metadata: {
          schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
          normalizationVersion: NORMALIZATION_VERSION,
          sourceUrl: input.sourceUrl,
          canonicalUrl: baseCanonicalUrl,
          title: baseTitle,
          subtitle: baseSubtitle,
          author: baseAuthor,
          publishedAtClaimed: basePublishedAt,
          language,
          extractorVersion: EXTRACTOR_VERSION,
          fieldProvenance: buildFieldProvenance({
            title: baseTitleSource,
            subtitle: baseSubtitleSource,
            author: baseAuthorSource,
            publishedAtClaimed: basePublishedAtSource,
            canonicalUrl: baseCanonicalUrlSource
          })
        }
      };
    } finally {
      dom.window.close();
    }
  }
}


