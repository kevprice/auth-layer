import { describe, expect, it } from "vitest";

import { NORMALIZATION_VERSION, ExtractionService } from "../src/services/extractionService.js";

const articleHtml = `
<!doctype html>
<html lang="en">
  <head>
    <title>Ignored title</title>
    <meta property="og:title" content="Launch day" />
    <meta name="author" content="Ada Lovelace" />
    <meta property="article:published_time" content="2024-11-05T09:00:00Z" />
  </head>
  <body>
    <nav>Navigation junk</nav>
    <article>
      <h1>Launch day</h1>
      <p>This is the opening paragraph for the feature story and it is intentionally long enough to satisfy readability.</p>
      <p>The second paragraph carries the core article facts while cookie banners and sidebars should be excluded.</p>
      <p>The third paragraph adds enough length to ensure the extraction path remains article-first rather than generic fallback.</p>
      <img src="/hero.jpg?utm_source=newsletter" />
    </article>
    <aside>Related links</aside>
  </body>
</html>`;

const genericHtml = `
<!doctype html>
<html>
  <head>
    <title>Status page</title>
  </head>
  <body>
    <header>Navigation</header>
    <main>
      <h1>Service status</h1>
      <p>API is operational.</p>
      <p>Workers are caught up.</p>
    </main>
    <footer>Footer links</footer>
  </body>
</html>`;

describe("ExtractionService", () => {
  it("extracts article-like pages while excluding obvious noise", async () => {
    const service = new ExtractionService();
    const result = await service.extract({ rawHtml: articleHtml, sourceUrl: "https://example.com/posts/launch" });

    expect(result.pageKind).toBe("article");
    expect(result.canonicalContent.title).toBe("Launch day");
    expect(result.metadata.author).toBe("Ada Lovelace");
    expect(result.canonicalContent.bodyMarkdown).toContain("opening paragraph");
    expect(result.canonicalContent.bodyMarkdown).not.toContain("Navigation junk");
    expect(result.canonicalContent.imageUrls?.[0]).toBe("https://example.com/hero.jpg");
    expect(result.canonicalContent.blocks.length).toBeGreaterThan(2);
    expect(result.canonicalContent.stats.paragraphCount).toBeGreaterThan(2);
    expect(result.canonicalContent.normalizationVersion).toBe(NORMALIZATION_VERSION);
    expect(result.metadata.fieldProvenance.author.sourceKind).toBe("readability");
  });

  it("falls back to generic extraction for non-article pages", async () => {
    const service = new ExtractionService();
    const result = await service.extract({ rawHtml: genericHtml, sourceUrl: "https://example.com/status" });

    expect(result.pageKind).toBe("generic");
    expect(result.extractionStatus).toBe("fallback");
    expect(result.canonicalContent.bodyMarkdown).toContain("API is operational.");
    expect(result.canonicalContent.diagnostics.warnings.length).toBeGreaterThan(0);
  });
});

