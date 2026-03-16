import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });

beforeEach(() => {
  window.location.hash = "#/";
  vi.restoreAllMocks();
});

describe("App", () => {
  it("submits a capture and renders the capture detail honesty copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/api/captures") && init?.method === "POST") {
          return Promise.resolve(
            jsonResponse({
              capture: {
                id: "capture-1",
                requestedUrl: "https://example.com/story",
                normalizedRequestedUrl: "https://example.com/story",
                extractorVersion: "readability-v1",
                status: "queued",
                artifacts: {},
                createdAt: "2026-03-14T12:00:00.000Z",
                updatedAt: "2026-03-14T12:00:00.000Z"
              }
            })
          );
        }

        if (url.endsWith("/api/captures/capture-1")) {
          return Promise.resolve(
            jsonResponse({
              capture: {
                id: "capture-1",
                requestedUrl: "https://example.com/story",
                normalizedRequestedUrl: "https://example.com/story",
                extractorVersion: "readability-v1",
                normalizationVersion: "canonical-v2",
                hashAlgorithm: "sha256-v1",
                status: "completed",
                capturedAt: "2026-03-14T12:00:05.000Z",
                claimedPublishedAt: "2024-11-05T09:00:00Z",
                finalUrl: "https://example.com/story",
                rawSnapshotHash: "sha256:raw",
                canonicalContentHash: "sha256:content",
                metadataHash: "sha256:meta",
                proofBundleHash: "sha256:bundle",
                proofReceiptId: "receipt-1",
                pageKind: "article",
                contentExtractionStatus: "success",
                comparedToCaptureId: "capture-0",
                contentChangedFromPrevious: false,
                metadataChangedFromPrevious: true,
                titleChangedFromPrevious: true,
                authorChangedFromPrevious: false,
                claimedPublishedAtChangedFromPrevious: true,
                artifacts: {
                  rawHtmlStorageKey: "captures/capture-1/raw.html",
                  canonicalContentStorageKey: "captures/capture-1/canonical-content.json",
                  metadataStorageKey: "captures/capture-1/metadata.json",
                  proofBundleStorageKey: "captures/capture-1/proof-bundle.json"
                },
                createdAt: "2026-03-14T12:00:00.000Z",
                updatedAt: "2026-03-14T12:00:05.000Z"
              },
              metadata: {
                schemaVersion: 2,
                normalizationVersion: "canonical-v2",
                sourceUrl: "https://example.com/story",
                title: "Launch day",
                author: "Ada Lovelace",
                extractorVersion: "readability-v1",
                fieldProvenance: {
                  title: { sourceKind: "readability", strategy: "Readability selected the page title." },
                  subtitle: { sourceKind: "not-found", strategy: "Subtitle extraction" },
                  author: { sourceKind: "meta-tag", strategy: "Author meta tag" },
                  publishedAtClaimed: { sourceKind: "meta-tag", strategy: "Article published time meta tag" },
                  canonicalUrl: { sourceKind: "not-found", strategy: "Canonical URL extraction" }
                }
              },
              canonicalContent: {
                schemaVersion: 2,
                normalizationVersion: "canonical-v2",
                sourceUrl: "https://example.com/story",
                bodyMarkdown: "Proof body\n\nSecond paragraph",
                blocks: [
                  { order: 0, type: "paragraph", text: "Proof body" },
                  { order: 1, type: "paragraph", text: "Second paragraph" }
                ],
                extractorVersion: "readability-v1",
                stats: {
                  characterCount: 27,
                  wordCount: 4,
                  blockCount: 2,
                  paragraphCount: 2,
                  headingCount: 0,
                  imageCount: 0
                },
                diagnostics: {
                  confidence: 0.87,
                  warnings: ["Canonical content is short; review the extracted blocks before relying on comparisons."]
                }
              },
              proofBundle: {
                schemaVersion: 3,
                captureId: "capture-1",
                requestedUrl: "https://example.com/story",
                finalUrl: "https://example.com/story",
                pageKind: "article",
                extractorVersion: "readability-v1",
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
                canonicalContentHash: "sha256:content",
                metadataHash: "sha256:meta",
                createdAt: "2026-03-14T12:00:05.000Z"
              },
              receipt: {
                id: "receipt-1",
                proofBundleHash: "sha256:bundle",
                receivedAt: "2026-03-14T12:00:05.000Z",
                provider: "internal-hmac-v1",
                signature: "signed"
              }
            })
          );
        }

        return Promise.reject(new Error(`Unhandled fetch ${url}`));
      })
    );

    render(<App />);

    await userEvent.type(screen.getByLabelText(/paste a url to audit/i), "https://example.com/story");
    await userEvent.click(screen.getByRole("button", { name: /create proof/i }));

    expect(await screen.findByText(/Observed by our system at the capture time shown below/i)).toBeInTheDocument();
    expect(screen.getByText("Launch day")).toBeInTheDocument();
    expect(screen.getByText(/Capture Scope/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What This Proves/i })).toBeInTheDocument();
    expect(screen.getByText(/Integrity Hashes/i)).toBeInTheDocument();
    expect(screen.getByText(/Transparency Proof/i)).toBeInTheDocument();
    expect(screen.getByText(/Advanced JSON/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Extraction Diagnostics/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Evidence Layers/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Verification Appendix/i })).toBeInTheDocument();
    expect(screen.getByText(/Semantic content stable/i)).toBeInTheDocument();
    expect(screen.getByText(/Title changed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /compare with previous/i })).toBeInTheDocument();
  });

  it("renders URL history badges and compare actions", async () => {
    window.location.hash = "#/history/https%3A%2F%2Fexample.com%2Fstory";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/urls/")) {
          return Promise.resolve(
            jsonResponse({
              normalizedRequestedUrl: "https://example.com/story",
              captures: [
                {
                  id: "capture-2",
                  requestedUrl: "https://example.com/story",
                  normalizedRequestedUrl: "https://example.com/story",
                  extractorVersion: "readability-v1",
                  status: "completed",
                  capturedAt: "2026-03-14T12:10:00.000Z",
                  comparedToCaptureId: "capture-1",
                  contentChangedFromPrevious: true,
                  metadataChangedFromPrevious: true,
                  titleChangedFromPrevious: true,
                  authorChangedFromPrevious: false,
                  claimedPublishedAtChangedFromPrevious: true,
                  artifacts: {},
                  createdAt: "2026-03-14T12:09:59.000Z",
                  updatedAt: "2026-03-14T12:10:00.000Z"
                },
                {
                  id: "capture-1",
                  requestedUrl: "https://example.com/story",
                  normalizedRequestedUrl: "https://example.com/story",
                  extractorVersion: "readability-v1",
                  status: "completed",
                  capturedAt: "2026-03-14T12:00:00.000Z",
                  artifacts: {},
                  createdAt: "2026-03-14T11:59:59.000Z",
                  updatedAt: "2026-03-14T12:00:00.000Z"
                }
              ]
            })
          );
        }

        return Promise.reject(new Error(`Unhandled fetch ${url}`));
      })
    );

    render(<App />);

    expect(await screen.findByText(/Semantic content changed/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Metadata changed/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Title changed/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Claimed publish date changed/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /compare latest two/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /compare oldest vs newest/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /compare/i }).length).toBeGreaterThan(1);
  });

  it("renders the compare view for two observed captures", async () => {
    window.location.hash = "#/compare/https%3A%2F%2Fexample.com%2Fstory/capture-1/capture-2";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/transparency/operator-key")) {
          return Promise.resolve(
            jsonResponse({
              operatorPublicKey: {
                schemaVersion: 1,
                operatorId: "test-operator",
                keyId: "test-operator-ed25519-v1",
                algorithm: "ed25519",
                publicKeyPem: "pem",
                publicKeySha256: "sha256:operator",
                createdAt: "2026-03-15T00:00:00.000Z"
              }
            })
          );
        }

        if (url.includes("/api/urls/") && url.includes("/compare?")) {
          return Promise.resolve(
            jsonResponse({
              normalizedRequestedUrl: "https://example.com/story",
              comparison: {
                schemaVersion: 1,
                normalizedRequestedUrl: "https://example.com/story",
                basis: "capture-id",
                observationStatement:
                  "This comparison describes differences between two observed captures of the same URL. It does not prove publisher intent, original creation time, or why the page changed.",
                older: {
                  observedAt: "2026-03-14T12:00:00.000Z",
                  capture: {
                    id: "capture-1",
                    requestedUrl: "https://example.com/story",
                    normalizedRequestedUrl: "https://example.com/story",
                    extractorVersion: "readability-v1",
                    status: "completed",
                    canonicalContentHash: "sha256:old-content",
                    metadataHash: "sha256:old-meta",
                    proofBundleHash: "sha256:old-bundle",
                    pageKind: "article",
                    contentExtractionStatus: "success",
                    artifacts: {},
                    createdAt: "2026-03-14T12:00:00.000Z",
                    updatedAt: "2026-03-14T12:00:00.000Z"
                  }
                },
                newer: {
                  observedAt: "2026-03-14T12:10:00.000Z",
                  capture: {
                    id: "capture-2",
                    requestedUrl: "https://example.com/story",
                    normalizedRequestedUrl: "https://example.com/story",
                    extractorVersion: "readability-v1",
                    status: "completed",
                    canonicalContentHash: "sha256:new-content",
                    metadataHash: "sha256:new-meta",
                    proofBundleHash: "sha256:new-bundle",
                    pageKind: "article",
                    contentExtractionStatus: "success",
                    artifacts: {},
                    createdAt: "2026-03-14T12:10:00.000Z",
                    updatedAt: "2026-03-14T12:10:00.000Z"
                  }
                },
                fields: {
                  canonicalContentHashChanged: true,
                  metadataHashChanged: true,
                  titleChanged: true,
                  authorChanged: true,
                  claimedPublishedAtChanged: true,
                  pageKindChanged: false,
                  extractorVersionChanged: false
                },
                blockSummary: {
                  paragraphsAdded: 1,
                  paragraphsRemoved: 1,
                  headingsChanged: 1,
                  addedParagraphSamples: ["A newly observed paragraph appears in this later capture."],
                  removedParagraphSamples: ["This paragraph was present only in the earlier capture."],
                  changedHeadingSamples: [{ index: 0, from: "Launch day", to: "Launch day updated" }]
                },
                diagnostics: {
                  older: {
                    captureId: "capture-1",
                    pageKind: "article",
                    extractionStatus: "success",
                    extractorVersion: "readability-v1",
                    confidence: 0.88,
                    warnings: []
                  },
                  newer: {
                    captureId: "capture-2",
                    pageKind: "article",
                    extractionStatus: "success",
                    extractorVersion: "readability-v1",
                    confidence: 0.62,
                    warnings: ["Extractor saw multiple article candidates."]
                  },
                  notes: ["Extraction confidence changed materially between captures. Manual review is recommended before drawing conclusions."]
                },
                changeSummary: [
                  "Canonical content hash: changed",
                  "Metadata hash: changed",
                  "Block diff summary: 1 paragraphs added, 1 paragraphs removed, 1 headings changed."
                ]
              }
            })
          );
        }

        return Promise.reject(new Error(`Unhandled fetch ${url}`));
      })
    );

    render(<App />);

    expect(await screen.findByText(/Shareable comparison report/i)).toBeInTheDocument();
    expect(screen.getByText(/Verdict/i)).toBeInTheDocument();
    expect(screen.getByText(/differences between two stored captures/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Paragraphs added/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Extractor saw multiple article candidates/i)).toBeInTheDocument();
    expect(screen.getByText(/Canonical content hash changed/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What This Proves/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What This Does Not Prove/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Verification Footer/i })).toBeInTheDocument();
    expect(screen.getByText(/Operator key fingerprint/i)).toBeInTheDocument();
    expect(screen.getByText(/A newly observed paragraph appears in this later capture/i)).toBeInTheDocument();
  });
});









