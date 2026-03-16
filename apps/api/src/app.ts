import { createHash, randomUUID } from "node:crypto";

import cors from "cors";
import express from "express";
import multer from "multer";

import { EXTRACTOR_VERSION, stableStringify, type RuntimeServices, normalizeRequestedUrl } from "@auth-layer/core";
import type { ArtifactKind, CaptureRecord, CreateCaptureRequest, CreatePdfCaptureRequest, CreateWatchlistRequest, UpdateWatchlistRequest } from "@auth-layer/shared";

const mapArtifactKey = (kind: ArtifactKind, capture: CaptureRecord): string | undefined => {
  switch (kind) {
    case "raw-html":
      return capture.artifacts.rawHtmlStorageKey;
    case "raw-pdf":
      return capture.artifacts.rawPdfStorageKey;
    case "canonical-content":
      return capture.artifacts.canonicalContentStorageKey;
    case "metadata":
      return capture.artifacts.metadataStorageKey;
    case "proof-bundle":
      return capture.artifacts.proofBundleStorageKey;
    case "screenshot":
      return capture.artifacts.screenshotStorageKey;
    case "approval-receipt":
      return capture.artifacts.approvalReceiptStorageKey;
    default:
      return undefined;
  }
};

export const createApp = (services: RuntimeServices) => {
  const app = express();
  const jsonBodyLimit = process.env.API_JSON_BODY_LIMIT ?? "25mb";
  const pdfUploadLimitBytes = Number(process.env.API_PDF_UPLOAD_LIMIT_BYTES ?? 25 * 1024 * 1024);
  const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: pdfUploadLimitBytes }
  });

  app.use(
    cors({
      origin: process.env.WEB_ORIGIN ?? true
    })
  );
  app.use(express.json({ limit: jsonBodyLimit }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/captures", async (request, response) => {
    const body = request.body as Partial<CreateCaptureRequest>;

    if (!body.url || typeof body.url !== "string") {
      response.status(400).json({ error: "A URL is required" });
      return;
    }

    try {
      const normalizedRequestedUrl = normalizeRequestedUrl(body.url);
      const capture = await services.repository.createCapture({
        requestedUrl: body.url,
        normalizedRequestedUrl,
        extractorVersion: EXTRACTOR_VERSION
      });
      response.status(202).json({ capture });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid URL" });
    }
  });


  app.post("/api/pdfs", pdfUpload.single("file"), async (request, response) => {
    const body = request.body as {
      fileName?: string;
      mediaType?: string;
      actorAccountId?: string;
      approvalType?: string;
      approvalScope?: CreatePdfCaptureRequest["approval"] extends infer T
        ? T extends { approvalScope?: infer S }
          ? S
          : never
        : never;
      approvalMethod?: CreatePdfCaptureRequest["approval"] extends infer T
        ? T extends { approvalMethod?: infer M }
          ? M
          : never
        : never;
    };
    const file = request.file;

    if (!file) {
      response.status(400).json({ error: "A PDF file upload is required" });
      return;
    }

    const fileName = body.fileName?.trim() || file.originalname;
    const mediaType = body.mediaType?.trim() || file.mimetype || "application/pdf";

    if (!fileName || !mediaType) {
      response.status(400).json({ error: "fileName and mediaType are required" });
      return;
    }

    try {
      const digest = createHash("sha256").update(file.buffer).digest("hex");
      const storageKey = `pdf-uploads/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
      await services.objectStore.putObject(storageKey, file.buffer, mediaType);
      const actorAccountId = body.actorAccountId?.trim() || null;
      const capture = await services.repository.createPdfCapture({
        requestedUrl: `pdf://sha256/${digest}`,
        normalizedRequestedUrl: `pdf://sha256/${digest}`,
        extractorVersion: "pdf-text-v1",
        sourceLabel: fileName,
        fileName,
        mediaType,
        byteSize: file.size,
        rawPdfStorageKey: storageKey,
        rawSnapshotHash: `sha256:${digest}`,
        actorAccountId,
        approvalType: body.approvalType?.trim() || (actorAccountId ? "pdf-upload-approval-v1" : null),
        approvalScope: body.approvalScope ?? (actorAccountId ? "file-hash" : null),
        approvalMethod: body.approvalMethod ?? (actorAccountId ? "account-signature" : null)
      });
      response.status(202).json({ capture });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid PDF payload" });
    }
  });

  app.get("/api/captures/:id", async (request, response) => {
    const detail = await services.processor.loadCaptureDetail(request.params.id);

    if (!detail) {
      response.status(404).json({ error: "Capture not found" });
      return;
    }

    response.json(detail);
  });

  app.get("/api/captures/:id/export", async (request, response) => {
    const exportPackage = await services.processor.loadCaptureTransparencyExport(request.params.id);

    if (!exportPackage) {
      response.status(404).json({ error: "Capture not found" });
      return;
    }

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.send(stableStringify(exportPackage));
  });

  app.get("/api/captures/:id/artifacts/:kind", async (request, response) => {
    const detail = await services.processor.loadCaptureDetail(request.params.id);

    if (!detail) {
      response.status(404).json({ error: "Capture not found" });
      return;
    }

    const kind = request.params.kind as ArtifactKind;
    const artifactKey = mapArtifactKey(kind, detail.capture);

    if (!artifactKey) {
      response.status(404).json({ error: "Artifact not found" });
      return;
    }

    const artifact = await services.objectStore.getObject(artifactKey);

    if (!artifact) {
      response.status(404).json({ error: "Artifact not found" });
      return;
    }

    if (artifact.contentType) {
      response.setHeader("Content-Type", artifact.contentType);
    }

    response.send(artifact.body);
  });

  app.get("/api/transparency/log/captures/:id", async (request, response) => {
    const { entry } = await services.transparencyLogService.getCaptureTransparency(request.params.id);

    if (!entry) {
      response.status(404).json({ error: "Transparency log entry not found" });
      return;
    }

    response.json({ entry });
  });

  app.get("/api/transparency/checkpoints/latest", async (_request, response) => {
    const checkpoint = await services.repository.getLatestTransparencyCheckpoint();

    if (!checkpoint) {
      response.status(404).json({ error: "Transparency checkpoint not found" });
      return;
    }

    response.json({ checkpoint });
  });

  app.get("/api/transparency/operator-key", (_request, response) => {
    response.json({ operatorPublicKey: services.transparencyLogService.getOperatorPublicKey() });
  });


  app.post("/api/watchlists", async (request, response) => {
    const body = request.body as Partial<CreateWatchlistRequest>;
    if (!body.url || typeof body.intervalMinutes !== "number") {
      response.status(400).json({ error: "url and intervalMinutes are required" });
      return;
    }

    try {
      const watchlist = await services.watchlistService.createWatchlist({
        url: body.url,
        intervalMinutes: body.intervalMinutes,
        webhookUrl: body.webhookUrl,
        emitJson: body.emitJson
      });
      response.status(201).json({ watchlist });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create watchlist" });
    }
  });

  app.get("/api/watchlists", async (_request, response) => {
    response.json({ watchlists: await services.watchlistService.listWatchlists() });
  });

  app.get("/api/watchlists/:id", async (request, response) => {
    const watchlist = await services.watchlistService.getWatchlist(request.params.id);
    if (!watchlist) {
      response.status(404).json({ error: "Watchlist not found" });
      return;
    }
    response.json({ watchlist });
  });

  app.patch("/api/watchlists/:id", async (request, response) => {
    const watchlist = await services.watchlistService.updateWatchlist(request.params.id, request.body as UpdateWatchlistRequest);
    if (!watchlist) {
      response.status(404).json({ error: "Watchlist not found" });
      return;
    }
    response.json({ watchlist });
  });

  app.post("/api/watchlists/:id/retry", async (request, response) => {
    try {
      const run = await services.watchlistService.runWatchlistNow(request.params.id);
      response.status(202).json({ run });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to retry watchlist" });
    }
  });

  app.get("/api/watchlists/:id/runs", async (request, response) => {
    const watchlist = await services.watchlistService.getWatchlist(request.params.id);
    if (!watchlist) {
      response.status(404).json({ error: "Watchlist not found" });
      return;
    }
    const runs = await services.watchlistService.listWatchlistRuns(request.params.id);
    response.json({ watchlist, runs });
  });

  app.post("/api/watchlists/:id/test-webhook", async (request, response) => {
    try {
      const result = await services.watchlistService.testWebhook(request.params.id);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Webhook test failed" });
    }
  });

  app.get("/api/urls/:encodedUrl/captures", async (request, response) => {
    try {
      const normalizedRequestedUrl = normalizeRequestedUrl(decodeURIComponent(request.params.encodedUrl));
      const captures = await services.processor.getHistory(normalizedRequestedUrl);
      response.json({ normalizedRequestedUrl, captures });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid URL" });
    }
  });

  app.get("/api/urls/:encodedUrl/compare", async (request, response) => {
    try {
      const normalizedRequestedUrl = normalizeRequestedUrl(decodeURIComponent(request.params.encodedUrl));
      const { fromCaptureId, toCaptureId, fromCapturedAt, toCapturedAt } = request.query as Record<string, string | undefined>;

      if (fromCaptureId && toCaptureId) {
        const comparison = await services.processor.compareCapturesForUrl(normalizedRequestedUrl, {
          basis: "capture-id",
          fromCaptureId,
          toCaptureId
        });
        response.json({ normalizedRequestedUrl, comparison });
        return;
      }

      if (fromCapturedAt && toCapturedAt) {
        const comparison = await services.processor.compareCapturesForUrl(normalizedRequestedUrl, {
          basis: "captured-at",
          fromCapturedAt,
          toCapturedAt
        });
        response.json({ normalizedRequestedUrl, comparison });
        return;
      }

      response.status(400).json({
        error: "Provide either fromCaptureId/toCaptureId or fromCapturedAt/toCapturedAt for the requested URL"
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid comparison request" });
    }
  });

  return app;
};

