import { describe, expect, it } from "vitest";

import {
  badgeStateForDiscovery,
  buildPreviewModel,
  extractManifestUrlFromHtml,
  findAuthenticityManifestHref,
  resolveManifestUrl
} from "../src/discovery.js";

describe("browser extension discovery helpers", () => {
  it("detects an authenticity manifest link and resolves relative URLs", () => {
    document.body.innerHTML = '<link rel="authenticity-manifest" href="/api/discovery/articles/story.json">';
    expect(findAuthenticityManifestHref(document)).toBe("/api/discovery/articles/story.json");
    expect(resolveManifestUrl("/api/discovery/articles/story.json", "https://example.com/news/story")).toBe(
      "https://example.com/api/discovery/articles/story.json"
    );
  });

  it("extracts a manifest link from raw HTML", () => {
    const html = '<html><head><link rel="authenticity-manifest" href="https://operator.example/api/discovery/articles/123"></head></html>';
    expect(extractManifestUrlFromHtml(html, "https://news.example/story")).toBe(
      "https://operator.example/api/discovery/articles/123"
    );
  });

  it("returns a neutral badge state when no manifest exists", () => {
    expect(badgeStateForDiscovery({ manifestDetected: false, hadError: false })).toEqual({
      text: "",
      color: "#718096",
      label: "No authenticity manifest detected."
    });
  });

  it("builds a preview model from manifest and export metadata", () => {
    const preview = buildPreviewModel({
      pageUrl: "https://example.com/story",
      manifestUrl: "https://operator.example/api/discovery/articles/123",
      manifest: {
        artifactType: "article-publish",
        title: "Launch day",
        publisher: "Example Newsroom",
        publishedAt: "2026-03-20T10:00:00.000Z",
        captureExportUrl: "/api/captures/capture-1/export",
        transparencyLogUrl: "/api/transparency/log/captures/capture-1"
      },
      exportPayload: {
        attestationSummary: { attestationCount: 2, hasAttestations: true },
        lineageSummary: { lineageNodeCount: 2 },
        transparencyLogEntry: { captureId: "capture-1" }
      }
    });

    expect(preview.captureExportUrl).toBe("https://operator.example/api/captures/capture-1/export");
    expect(preview.transparencyLogUrl).toBe("https://operator.example/api/transparency/log/captures/capture-1");
    expect(preview.attestationCount).toBe(2);
    expect(preview.lineageNodeCount).toBe(2);
    expect(preview.hasTransparencyMaterials).toBe(true);
    expect(preview.publisher).toBe("Example Newsroom");
    expect(preview.materials).toEqual({
      manifestFound: true,
      captureExportFound: true,
      transparencyEntryFound: true
    });
  });

  it("derives transparency presence from export metadata when no transparency URL is exposed", () => {
    const preview = buildPreviewModel({
      pageUrl: "https://example.com/story",
      manifestUrl: "https://operator.example/api/discovery/articles/123",
      manifest: {
        artifactType: "article-publish",
        captureExportUrl: "/api/captures/capture-1/export"
      },
      exportPayload: {
        transparencyCheckpoint: { checkpointId: "cp-1" }
      }
    });

    expect(preview.materials.transparencyEntryFound).toBe(true);
    expect(preview.transparencyLogUrl).toBeUndefined();
  });
});
