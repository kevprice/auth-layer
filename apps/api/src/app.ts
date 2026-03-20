import { createHash, randomUUID } from "node:crypto";

import cors from "cors";
import express from "express";
import multer from "multer";

import { ArticleService, EXTRACTOR_VERSION, WORDPRESS_ARTICLE_EXTRACTOR_VERSION, buildCanonicalArticleHtml, stableStringify, type RuntimeServices, normalizeRequestedUrl } from "@auth-layer/core";
import type { ArtifactKind, ArticleDiscoveryManifest, CaptureRecord, CompleteWordPressApprovalRequest, CreateCaptureRequest, CreateImageCaptureRequest, CreatePdfCaptureRequest, CreateWatchlistRequest, CreateWordPressArticleRequest, UpdateWatchlistRequest, WordPressApprovalChallenge, WordPressArticlePayload } from "@auth-layer/shared";

const articleService = new ArticleService();

const shouldRequireApproval = (
  action: "publish" | "update",
  policy: CreateWordPressArticleRequest["approval"] extends infer T
    ? T extends { policy?: infer P }
      ? P
      : never
    : never
): boolean => {
  switch (policy) {
    case "passkey-on-publish":
      return action === "publish";
    case "passkey-on-update":
      return action === "update";
    case "passkey-on-all":
      return true;
    default:
      return false;
  }
};

const normalizeArticlePayload = (payload: WordPressArticlePayload): WordPressArticlePayload => articleService.normalizePayload(payload);

const buildArticleStorageKeys = (canonicalUrl: string) => {
  const slug = canonicalUrl.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "article";
  const id = randomUUID();
  return {
    rawHtml: `wordpress-articles/${id}-${slug}/raw.html`,
    articleInput: `wordpress-articles/${id}-${slug}/article-input.json`,
    approvalChallenge: `wordpress-articles/${id}-${slug}/approval-challenge.json`
  };
};

const buildArticleManifestUrl = (article: WordPressArticlePayload): string =>
  `/api/discovery/articles/${encodeURIComponent(article.canonicalUrl)}`;
const mapArtifactKey = (kind: ArtifactKind, capture: CaptureRecord): string | undefined => {
  switch (kind) {
    case "raw-html":
      return capture.artifacts.rawHtmlStorageKey;
    case "raw-pdf":
      return capture.artifacts.rawPdfStorageKey;
    case "raw-image":
      return capture.artifacts.rawImageStorageKey;
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
    case "attestation-bundle":
      return capture.artifacts.attestationBundleStorageKey;
    default:
      return undefined;
  }
};

export const createApp = (services: RuntimeServices) => {
  const app = express();
  const jsonBodyLimit = process.env.API_JSON_BODY_LIMIT ?? "25mb";
  const pdfUploadLimitBytes = Number(process.env.API_PDF_UPLOAD_LIMIT_BYTES ?? 25 * 1024 * 1024);
  const imageUploadLimitBytes = Number(process.env.API_IMAGE_UPLOAD_LIMIT_BYTES ?? 25 * 1024 * 1024);
  const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: pdfUploadLimitBytes }
  });
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: imageUploadLimitBytes }
  });

  const wordpressToken = process.env.WORDPRESS_INTEGRATION_TOKEN?.trim();

  const authorizeWordPressRequest = (request: express.Request, response: express.Response): boolean => {
    if (!wordpressToken) {
      return true;
    }
    const authorization = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (authorization !== wordpressToken) {
      response.status(401).json({ error: "Invalid WordPress integration token" });
      return false;
    }
    return true;
  };
  const queueWordPressArticle = async (input: {
    article: WordPressArticlePayload;
    action: "publish" | "update";
    attestations?: CreateWordPressArticleRequest["attestations"];
  }) => {
    const article = normalizeArticlePayload(input.article);
    const canonicalHtml = buildCanonicalArticleHtml(article);
    const storageKeys = buildArticleStorageKeys(article.canonicalUrl);
    await services.objectStore.putObject(storageKeys.rawHtml, canonicalHtml, "text/html; charset=utf-8");
    await services.objectStore.putJson(storageKeys.articleInput, {
      article,
      action: input.action,
      attestations: input.attestations?.length ? input.attestations : undefined
    });

    const rawSnapshotHash = `sha256:${createHash("sha256").update(stableStringify({ article, rawHtml: canonicalHtml })).digest("hex")}`;
    const capture = await services.repository.createArticleCapture({
      requestedUrl: article.canonicalUrl,
      normalizedRequestedUrl: article.canonicalUrl,
      extractorVersion: WORDPRESS_ARTICLE_EXTRACTOR_VERSION,
      sourceLabel: article.title,
      fileName: `${article.postId}.html`,
      mediaType: "text/html; charset=utf-8",
      byteSize: Buffer.byteLength(canonicalHtml, "utf8"),
      rawHtmlStorageKey: storageKeys.rawHtml,
      rawSnapshotHash,
      articleInputStorageKey: storageKeys.articleInput
    });

    return { capture, manifestUrl: buildArticleManifestUrl(article) };
  };

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



  app.post("/api/images", imageUpload.single("file"), async (request, response) => {
    const body = request.body as {
      fileName?: string;
      mediaType?: string;
      caption?: string;
      altText?: string;
      capturedAt?: string;
      publishedAt?: string;
      derivativeOfContentHash?: string;
      attestations?: string;
    };
    const file = request.file;

    if (!file) {
      response.status(400).json({ error: "An image file upload is required" });
      return;
    }

    const fileName = body.fileName?.trim() || file.originalname;
    const mediaType = body.mediaType?.trim() || file.mimetype || "application/octet-stream";
    if (!mediaType.startsWith("image/")) {
      response.status(400).json({ error: "Uploaded file must be an image" });
      return;
    }

    let attestations: CreateImageCaptureRequest["attestations"] | undefined;
    if (body.attestations?.trim()) {
      try {
        attestations = JSON.parse(body.attestations) as CreateImageCaptureRequest["attestations"];
      } catch {
        response.status(400).json({ error: "attestations must be valid JSON" });
        return;
      }
    }

    try {
      const digest = createHash("sha256").update(file.buffer).digest("hex");
      const storageKey = `image-uploads/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
      await services.objectStore.putObject(storageKey, file.buffer, mediaType);
      const imageInputStorageKey = `image-uploads/${randomUUID()}-input.json`;
      await services.objectStore.putJson(imageInputStorageKey, {
        caption: body.caption?.trim() || undefined,
        altText: body.altText?.trim() || undefined,
        capturedAt: body.capturedAt?.trim() || undefined,
        publishedAt: body.publishedAt?.trim() || undefined,
        derivativeOfContentHash: body.derivativeOfContentHash?.trim() || undefined,
        attestations: attestations?.length ? attestations : undefined
      });
      const capture = await services.repository.createImageCapture({
        requestedUrl: `image://sha256/${digest}`,
        normalizedRequestedUrl: `image://sha256/${digest}`,
        extractorVersion: "image-metadata-v1",
        sourceLabel: fileName,
        fileName,
        mediaType,
        byteSize: file.size,
        rawImageStorageKey: storageKey,
        rawSnapshotHash: `sha256:${digest}`,
        imageInputStorageKey
      });
      response.status(202).json({ capture });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid image payload" });
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

  app.post("/api/integrations/wordpress/articles", async (request, response) => {
    if (!authorizeWordPressRequest(request, response)) {
      return;
    }
    const body = request.body as Partial<CreateWordPressArticleRequest>;
    if (!body.article) {
      response.status(400).json({ error: "article payload is required" });
      return;
    }

    try {
      const article = normalizeArticlePayload(body.article);
      const action = body.action === "update" ? "update" : "publish";
      const policy = body.approval?.policy ?? "none";
      const manifestUrl = buildArticleManifestUrl(article);

      if (shouldRequireApproval(action, policy)) {
        const challenge: WordPressApprovalChallenge = {
          id: randomUUID(),
          article,
          action,
          requestedAt: new Date().toISOString(),
          actor: body.approval?.actor,
          policy,
          attestations: body.attestations,
          notes: body.approval?.notes
        };
        await services.objectStore.putJson(`wordpress-approvals/${challenge.id}.json`, challenge);
        response.status(202).json({ status: "approval_required", challengeId: challenge.id, manifestUrl });
        return;
      }

      const publishAttestation: CreateWordPressArticleRequest["attestations"] = body.approval?.actor
        ? [{
            type: action as "publish" | "update",
            actor: body.approval.actor,
            auth: { method: "session" as const, level: "standard" as const },
            timestamp: new Date().toISOString(),
            notes: body.approval.notes,
            metadata: { role: body.approval.actor.role ?? (action === "publish" ? "author" : "editor") }
          }]
        : [];

      const queued = await queueWordPressArticle({
        article,
        action,
        attestations: [...(body.attestations ?? []), ...publishAttestation]
      });
      response.status(202).json({ status: "queued", manifestUrl: queued.manifestUrl, capture: queued.capture });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid WordPress article payload" });
    }
  });

  app.post("/api/integrations/wordpress/approvals/:id/complete", async (request, response) => {
    if (!authorizeWordPressRequest(request, response)) {
      return;
    }
    const body = request.body as Partial<CompleteWordPressApprovalRequest>;
    const challengeId = request.params.id || body.challengeId;
    if (!challengeId) {
      response.status(400).json({ error: "challenge id is required" });
      return;
    }

    const challenge = await services.objectStore.getText(`wordpress-approvals/${challengeId}.json`);
    if (!challenge) {
      response.status(404).json({ error: "Approval challenge not found" });
      return;
    }

    try {
      const parsed = JSON.parse(challenge) as WordPressApprovalChallenge;
      const actor = body.actor ?? parsed.actor;
      if (!actor) {
        response.status(400).json({ error: "actor is required to complete approval" });
        return;
      }
      const approvalAttestation = {
        type: "approval" as const,
        actor,
        auth: { method: "passkey" as const, level: "phishing-resistant" as const },
        timestamp: new Date().toISOString(),
        notes: body.notes ?? parsed.notes,
        metadata: { wordpressAction: parsed.action }
      };
      const queued = await queueWordPressArticle({
        article: parsed.article,
        action: parsed.action,
        attestations: [...(parsed.attestations ?? []), approvalAttestation]
      });
      response.status(202).json({ status: "queued", manifestUrl: queued.manifestUrl, capture: queued.capture });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to complete approval" });
    }
  });

  app.get("/api/discovery/articles/:encodedCanonicalUrl", async (request, response) => {
    try {
      const canonicalUrl = decodeURIComponent(request.params.encodedCanonicalUrl);
      const captures = await services.repository.listCapturesForUrl(canonicalUrl);
      const latestCompleted = captures.find((capture) => capture.status === "completed");
      if (!latestCompleted) {
        response.status(404).json({ error: "No completed article package found for this canonical URL" });
        return;
      }
      const detail = await services.processor.loadCaptureDetail(latestCompleted.id);
      if (!detail) {
        response.status(404).json({ error: "Capture not found" });
        return;
      }
      const articleObject = detail.metadata?.articleObject ?? detail.canonicalContent?.articleObject;
      const manifest: ArticleDiscoveryManifest = {
        schemaVersion: 1,
        manifestType: "auth-layer-article-discovery",
        siteIdentifier: articleObject?.siteIdentifier,
        canonicalUrl,
        latestCaptureId: latestCompleted.id,
        artifactType: latestCompleted.artifactType ?? "article-publish",
        title: detail.metadata?.title ?? detail.canonicalContent?.title,
        publisher: articleObject?.siteIdentifier,
        publishedAt: articleObject?.publishedAt ?? detail.metadata?.publishedAtClaimed,
        updatedAt: articleObject?.updatedAt,
        captureExportUrl: `/api/captures/${latestCompleted.id}/export`,
        transparencyLogUrl: `/api/transparency/log/captures/${latestCompleted.id}`
      };
      response.json({ manifest });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid discovery request" });
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
    const intervalSeconds = typeof body.intervalSeconds === "number" ? body.intervalSeconds : undefined;
    const intervalMinutes = typeof body.intervalMinutes === "number" ? body.intervalMinutes : undefined;
    if (!body.url || (typeof intervalSeconds !== "number" && typeof intervalMinutes !== "number")) {
      response.status(400).json({ error: "url and intervalSeconds or intervalMinutes are required" });
      return;
    }

    try {
      const watchlist = await services.watchlistService.createWatchlist({
        url: body.url,
        intervalMinutes,
        intervalSeconds,
        webhookUrl: body.webhookUrl,
        emitJson: body.emitJson,
        expiresAt: body.expiresAt,
        burstConfig: body.burstConfig
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













