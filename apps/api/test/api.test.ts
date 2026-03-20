import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newDb } from "pg-mem";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CaptureProcessor,
  Ed25519TransparencyCheckpointSigner,
  ExtractionService,
  FetchService,
  FileSystemObjectStore,
  HashService,
  InternalHmacTimestampProvider,
  NORMALIZATION_VERSION,
  PollingWorker,
  PostgresCaptureRepository,
  ProofPackageService,
  PROOF_BUNDLE_SCHEMA_VERSION,
  runMigrations,
  TransparencyLogService
} from "@auth-layer/core";

import { createApp } from "../src/app.js";

const articleHtml = (
  language: string,
  title = "Launch day",
  author = "Ada Lovelace",
  publishedAt = "2024-11-05T09:00:00Z",
  paragraphs = [
    "This is the opening paragraph for the feature story and it is intentionally long enough to satisfy readability.",
    "The second paragraph carries the core article facts while cookie banners and sidebars should be excluded.",
    "The third paragraph adds enough length to ensure the extraction path remains article-first rather than generic fallback."
  ]
) => `
<!doctype html>
<html lang="${language}">
  <head>
    <title>${title}</title>
    <meta property="og:title" content="${title}" />
    <meta name="author" content="${author}" />
    <meta property="article:published_time" content="${publishedAt}" />
  </head>
  <body>
    <article>
      <h1>${title}</h1>
      ${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("\n")}
    </article>
  </body>
</html>`;

const createFetchResponse = (html: string, url: string): Response =>
  ({
    status: 200,
    url,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    arrayBuffer: async () => Buffer.from(html)
  } as unknown as Response);

const temporaryDirectories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createPostgresRuntime = async (rootDirectory: string, fetchImpl: typeof fetch) => {
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await runMigrations(pool);

  const repository = new PostgresCaptureRepository(pool);
  const objectStore = new FileSystemObjectStore(join(rootDirectory, "artifacts"));
  const transparencyLogService = new TransparencyLogService(
    repository,
    new Ed25519TransparencyCheckpointSigner({
      privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICuDjMQ9dp3BORmrTQ3bY68tEe7Pg5s3O1zt9KCuzK/J
-----END PRIVATE KEY-----`,
      publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7qW1iCRvTCU4Zz2iLX7gSV8l2N4NLCVpNYD+ps5c/nQ=
-----END PUBLIC KEY-----`,
      operatorId: "test-operator",
      keyId: "test-operator-ed25519-v1",
      createdAt: "2026-03-15T00:00:00.000Z"
    })
  );
  const processor = new CaptureProcessor(
    repository,
    objectStore,
    new FetchService(fetchImpl),
    new ExtractionService(),
    new HashService(),
    new InternalHmacTimestampProvider("test-secret"),
    transparencyLogService
  );
  const proofPackageService = new ProofPackageService(repository, objectStore, processor, transparencyLogService);
  const worker = new PollingWorker(repository, processor, 1000, "test-worker");

  closers.push(async () => {
    worker.stop();
    await repository.close?.();
  });

  return {
    repository,
    objectStore,
    processor,
    proofPackageService,
    transparencyLogService,
    worker,
    app: createApp({ repository, objectStore, processor, proofPackageService, transparencyLogService, worker })
  };
};

describe("capture API", () => {
  it("processes captures, exposes history, and compares two observed captures for the same URL", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "auth-layer-"));
    temporaryDirectories.push(rootDirectory);

    const responses = [
      createFetchResponse(articleHtml("en"), "https://news.example.com/final-story"),
      createFetchResponse(
        articleHtml(
          "fr",
          "Launch day updated",
          "Grace Hopper",
          "2024-11-06T09:00:00Z",
          [
            "The second paragraph carries the core article facts while cookie banners and sidebars should be excluded.",
            "A newly observed paragraph appears in this later capture and changes the semantic story.",
            "The third paragraph adds enough length to ensure the extraction path remains article-first rather than generic fallback."
          ]
        ),
        "https://news.example.com/final-story"
      )
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? createFetchResponse(articleHtml("en"), "https://news.example.com/final-story"));
    const { app, repository, worker } = await createPostgresRuntime(rootDirectory, fetchImpl as unknown as typeof fetch);

    const createFirstResponse = await request(app).post("/api/captures").send({ url: "https://news.example.com/story" }).expect(202);
    await worker.runOnce();
    const firstCaptureId = createFirstResponse.body.capture.id as string;

    const firstDetail = await request(app).get(`/api/captures/${firstCaptureId}`).expect(200);
    expect(firstDetail.body.capture.status).toBe("completed");
    expect(firstDetail.body.capture.finalUrl).toBe("https://news.example.com/final-story");
    expect(firstDetail.body.capture.capturedAt).toBeTruthy();
    expect(firstDetail.body.capture.claimedPublishedAt).toBe("2024-11-05T09:00:00Z");
    expect(firstDetail.body.capture.rawSnapshotHash).toMatch(/^sha256:/);
    expect(firstDetail.body.capture.latestEventSequence).toBe(6);
    expect(firstDetail.body.canonicalContent.normalizationVersion).toBe(NORMALIZATION_VERSION);
    expect(firstDetail.body.canonicalContent.blocks.length).toBeGreaterThan(2);
    expect(firstDetail.body.metadata.fieldProvenance.author.sourceKind).not.toBe("not-found");
    expect(firstDetail.body.proofBundle.schemaVersion).toBe(PROOF_BUNDLE_SCHEMA_VERSION);
    expect(firstDetail.body.proofBundle.captureId).toBe(firstCaptureId);
    expect(firstDetail.body.proofBundle.captureScope.rawHttpBodyPreserved).toBe(true);

    const exportResponseA = await request(app).get(`/api/captures/${firstCaptureId}/export`).expect(200);
    const exportResponseB = await request(app).get(`/api/captures/${firstCaptureId}/export`).expect(200);
    expect(exportResponseA.text).toBe(exportResponseB.text);
    const exportPayload = JSON.parse(exportResponseA.text);
    expect(exportPayload.exportType).toBe("capture-transparency-export");
    expect(exportPayload.proofStatement).toMatch(/does not prove original authorship/i);
    expect(exportPayload.captureScope.rawHttpBodyPreserved).toBe(true);
    expect(exportPayload.evidenceLayers.map((layer: { id: string }) => layer.id)).toEqual([
      "raw-snapshot",
      "canonical-content",
      "metadata",
      "rendered-evidence",
      "operator-observation",
      "attestations",
      "uploader-approval"
    ]);
    expect(exportPayload.pdfQualityDiagnostics).toBeUndefined();
    expect(exportPayload.transparencyLogEntry.captureId).toBe(firstCaptureId);
    expect(exportPayload.transparencyCheckpoint.lastLogIndex).toBe(1);
    expect(exportPayload.transparencyCheckpoint.operatorId).toBe("test-operator");
    expect(exportPayload.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "queued",
      "fetch_started",
      "fetch_completed",
      "extraction_completed",
      "hashing_completed",
      "timestamping_completed"
    ]);
    expect(exportPayload.artifactReferences.map((artifact: { kind: string }) => artifact.kind)).toEqual([
      "raw-html",
      "canonical-content",
      "metadata",
      "proof-bundle"
    ]);

    const createSecondResponse = await request(app).post("/api/captures").send({ url: "https://news.example.com/story" }).expect(202);
    await worker.runOnce();
    const secondCaptureId = createSecondResponse.body.capture.id as string;

    const secondDetail = await request(app).get(`/api/captures/${secondCaptureId}`).expect(200);
    expect(secondDetail.body.capture.metadataChangedFromPrevious).toBe(true);
    expect(secondDetail.body.capture.contentChangedFromPrevious).toBe(true);
    expect(secondDetail.body.capture.titleChangedFromPrevious).toBe(true);
    expect(secondDetail.body.capture.authorChangedFromPrevious).toBe(true);
    expect(secondDetail.body.capture.claimedPublishedAtChangedFromPrevious).toBe(true);
    expect(secondDetail.body.capture.comparedToCaptureId).toBe(firstCaptureId);

    const history = await request(app)
      .get(`/api/urls/${encodeURIComponent("https://news.example.com/story")}/captures`)
      .expect(200);
    expect(history.body.captures).toHaveLength(2);
    expect(history.body.captures[0].id).toBe(secondCaptureId);

    const compareById = await request(app)
      .get(`/api/urls/${encodeURIComponent("https://news.example.com/story")}/compare`)
      .query({ fromCaptureId: firstCaptureId, toCaptureId: secondCaptureId })
      .expect(200);
    expect(compareById.body.comparison.fields.canonicalContentHashChanged).toBe(true);
    expect(compareById.body.comparison.fields.metadataHashChanged).toBe(true);
    expect(compareById.body.comparison.fields.titleChanged).toBe(true);
    expect(compareById.body.comparison.fields.authorChanged).toBe(true);
    expect(compareById.body.comparison.fields.claimedPublishedAtChanged).toBe(true);
    expect(compareById.body.comparison.fields.pageKindChanged).toBe(false);
    expect(compareById.body.comparison.fields.extractorVersionChanged).toBe(false);
    expect(compareById.body.comparison.blockSummary.paragraphsAdded).toBe(1);
    expect(compareById.body.comparison.blockSummary.paragraphsRemoved).toBe(1);
    expect(compareById.body.comparison.blockSummary.headingsChanged).toBe(1);
    expect(compareById.body.comparison.changeSummary.length).toBeGreaterThan(0);
    expect(compareById.body.comparison.observationStatement).toMatch(/observed captures/i);

    const compareByTimestamp = await request(app)
      .get(`/api/urls/${encodeURIComponent("https://news.example.com/story")}/compare`)
      .query({
        fromCapturedAt: firstDetail.body.capture.capturedAt,
        toCapturedAt: secondDetail.body.capture.capturedAt
      })
      .expect(200);
    expect(compareByTimestamp.body.comparison.basis).toBe("captured-at");
    expect(compareByTimestamp.body.comparison.older.capture.id).toBe(firstCaptureId);
    expect(compareByTimestamp.body.comparison.newer.capture.id).toBe(secondCaptureId);

    const transparencyEntry = await request(app).get(`/api/transparency/log/captures/${firstCaptureId}`).expect(200);
    expect(transparencyEntry.body.entry.captureId).toBe(firstCaptureId);

    const latestCheckpoint = await request(app).get("/api/transparency/checkpoints/latest").expect(200);
    expect(latestCheckpoint.body.checkpoint.lastLogIndex).toBe(2);

    const operatorKey = await request(app).get("/api/transparency/operator-key").expect(200);
    expect(operatorKey.body.operatorPublicKey.operatorId).toBe("test-operator");
    expect(operatorKey.body.operatorPublicKey.keyId).toBe("test-operator-ed25519-v1");

    const events = await repository.listCaptureEvents(firstCaptureId);
    expect(events).toHaveLength(6);
    const artifacts = await repository.listArtifactReferences(firstCaptureId);
    expect(artifacts).toHaveLength(4);
  });
});


