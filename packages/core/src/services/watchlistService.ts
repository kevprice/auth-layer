import type {
  CaptureComparison,
  CaptureDetail,
  CreateWatchlistRequest,
  UpdateWatchlistRequest,
  Watchlist,
  WatchlistCaptureHealth,
  WatchlistEventType,
  WatchlistResultPayload,
  WatchlistRun,
  WatchlistRunVerdict
} from "@auth-layer/shared";

import type { CaptureRepository } from "../repositories/captureRepository.js";
import { normalizeRequestedUrl } from "../utils/url.js";
import type { CaptureProcessor } from "./captureProcessor.js";

const WATCHLIST_TIMEOUT_MS = 30_000;
const WATCHLIST_USER_AGENT = "AuthLayerWatchlist/0.1 (+https://auth-layer.local)";

const deriveCaptureHealth = (detail?: CaptureDetail): WatchlistCaptureHealth => {
  if (!detail || detail.capture.status !== "completed") {
    return "failed";
  }

  if (detail.capture.contentExtractionStatus === "failed") {
    return "failed";
  }

  if (detail.capture.contentExtractionStatus === "fallback") {
    return "degraded";
  }

  if ((detail.canonicalContent?.diagnostics.warnings?.length ?? 0) > 0) {
    return "degraded";
  }

  return "success";
};

const deriveChangedFields = (comparison?: CaptureComparison): WatchlistResultPayload["changedFields"] => ({
  canonicalContentHashChanged: comparison?.fields.canonicalContentHashChanged ?? false,
  metadataHashChanged: comparison?.fields.metadataHashChanged ?? false,
  titleChanged: comparison?.fields.titleChanged ?? false,
  authorChanged: comparison?.fields.authorChanged ?? false,
  claimedPublishedAtChanged: comparison?.fields.claimedPublishedAtChanged ?? false,
  pageKindChanged: comparison?.fields.pageKindChanged ?? false,
  extractorVersionChanged: comparison?.fields.extractorVersionChanged ?? false
});

const normalizeContentType = (contentType?: string | null): string | undefined => contentType?.split(";")[0]?.trim().toLowerCase();

const isSupportedWatchContentType = (contentType?: string): boolean => {
  if (!contentType) {
    return true;
  }
  return contentType === "text/html" || contentType === "application/xhtml+xml" || contentType === "application/xml";
};

const deriveAvailabilityState = (input: { outcome?: WatchlistRun["outcome"]; httpStatus?: number }): "available" | "missing" | "unknown" => {
  if (input.outcome === "not_found" || input.outcome === "gone") {
    return "missing";
  }
  if (typeof input.httpStatus === "number" && input.httpStatus >= 200 && input.httpStatus < 300) {
    return "available";
  }
  return "unknown";
};

const deriveWatchlistVerdict = (input: { status?: WatchlistRun["status"]; previousCaptureId?: string; changeDetected?: boolean; stateChanged?: boolean; hadPreviousObservation?: boolean }): WatchlistRunVerdict => {
  if (input.status === "failed") {
    return "failed";
  }

  if (!input.previousCaptureId && !input.hadPreviousObservation) {
    return "baseline";
  }

  return input.changeDetected || input.stateChanged ? "changed" : "unchanged";
};

const deriveWatchlistEventType = (verdict: WatchlistRunVerdict): WatchlistEventType => {
  if (verdict === "failed") {
    return "watchlist.run.failed";
  }

  return verdict === "changed" ? "watchlist.change.detected" : "watchlist.run.completed";
};

type WatchFetchAssessment = {
  outcome: NonNullable<WatchlistRun["outcome"]>;
  httpStatus?: number;
  resolvedUrl?: string;
  contentType?: string;
  previousResolvedUrl?: string;
  stateChanged: boolean;
  availabilityTransition?: WatchlistRun["availabilityTransition"];
  redirectChanged?: boolean;
  lastSuccessfulFetchAt?: string;
  lastErrorCode?: string;
  shouldCapture: boolean;
  failureCount: number;
  changeSummary: string[];
  watchStatus?: Watchlist["status"];
};
export class WatchlistService {
  constructor(
    private readonly repository: CaptureRepository,
    private readonly processor: CaptureProcessor,
    private readonly extractorVersion: string,
    private readonly fetchImpl: typeof fetch,
    private readonly publicWebOrigin?: string
  ) {}

  async createWatchlist(input: CreateWatchlistRequest): Promise<Watchlist> {
    const normalizedRequestedUrl = normalizeRequestedUrl(input.url);
    const watchlist = await this.repository.createWatchlist({
      url: normalizedRequestedUrl,
      intervalMinutes: input.intervalMinutes,
      intervalSeconds: input.intervalSeconds,
      webhookUrl: input.webhookUrl,
      emitJson: input.emitJson,
      expiresAt: input.expiresAt,
      burstConfig: input.burstConfig
    });
    return this.enrichWatchlist(watchlist);
  }

  async listWatchlists(): Promise<Watchlist[]> {
    const watchlists = await this.repository.listWatchlists();
    return Promise.all(watchlists.map((watchlist) => this.enrichWatchlist(watchlist)));
  }

  async getWatchlist(id: string): Promise<Watchlist | undefined> {
    const watchlist = await this.repository.getWatchlist(id);
    return watchlist ? this.enrichWatchlist(watchlist) : undefined;
  }

  async updateWatchlist(id: string, input: UpdateWatchlistRequest): Promise<Watchlist | undefined> {
    const watchlist = await this.repository.updateWatchlist(id, input);
    return watchlist ? this.enrichWatchlist(watchlist) : undefined;
  }

  async listWatchlistRuns(id: string): Promise<WatchlistRun[]> {
    const runs = await this.repository.listWatchlistRuns(id);
    return Promise.all(runs.map((run) => this.enrichRun(run)));
  }

  private buildComparePath(normalizedRequestedUrl: string, olderCaptureId?: string, newerCaptureId?: string): string | undefined {
    if (!olderCaptureId || !newerCaptureId) {
      return undefined;
    }

    const hashPath = `#/compare/${encodeURIComponent(normalizedRequestedUrl)}/${olderCaptureId}/${newerCaptureId}`;
    if (this.publicWebOrigin) {
      return `${this.publicWebOrigin.replace(/\/$/, "")}/${hashPath.replace(/^#\//, "#/")}`;
    }
    return hashPath;
  }

  private async loadCaptureDetail(captureId?: string): Promise<CaptureDetail | undefined> {
    return captureId ? this.processor.loadCaptureDetail(captureId) : undefined;
  }

  private async deriveRunCaptureHealth(run: WatchlistRun): Promise<WatchlistCaptureHealth> {
    const detail = await this.loadCaptureDetail(run.newerCaptureId);
    return deriveCaptureHealth(detail);
  }

  private async getLatestSuccessfulCapture(normalizedRequestedUrl: string) {
    const captures = await this.repository.listCapturesForUrl(normalizedRequestedUrl);
    return captures.find((capture) => capture.status === "completed");
  }

  private async assessFetch(watchlist: Watchlist, now = new Date().toISOString()): Promise<WatchFetchAssessment> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WATCHLIST_TIMEOUT_MS);
    const previousCapture = await this.getLatestSuccessfulCapture(watchlist.normalizedRequestedUrl);
    const previousRuns = await this.repository.listWatchlistRuns(watchlist.id);
    const previousRun = previousRuns.find((candidate) => candidate.status !== "started" && Boolean(candidate.completedAt));
    const previousAvailability = deriveAvailabilityState({ httpStatus: watchlist.lastHttpStatus ?? previousRun?.httpStatus, outcome: previousRun?.outcome });
    const previousResolvedUrl = watchlist.lastResolvedUrl ?? previousRun?.resolvedUrl;

    try {
      const response = await this.fetchImpl(watchlist.requestedUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": WATCHLIST_USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      clearTimeout(timeout);
      const emittedAt = now;
      const httpStatus = response.status;
      const resolvedUrl = response.url || watchlist.requestedUrl;
      const contentType = normalizeContentType(response.headers.get("content-type"));
      const redirectObserved = resolvedUrl !== watchlist.requestedUrl;
      const redirectChanged = redirectObserved ? previousResolvedUrl !== resolvedUrl : false;
      const currentAvailability = deriveAvailabilityState({ httpStatus, outcome: httpStatus === 404 ? "not_found" : httpStatus === 410 ? "gone" : undefined });
      const availabilityTransition = previousAvailability === "available" && currentAvailability === "missing"
        ? "available_to_missing"
        : previousAvailability === "missing" && currentAvailability === "available"
          ? "missing_to_available"
          : undefined;
      const previousContentType = normalizeContentType(previousCapture?.contentType);
      const contentTypeChanged = Boolean(previousContentType && contentType && previousContentType !== contentType);
      const stateChanged = Boolean(availabilityTransition || redirectChanged || contentTypeChanged);
      const lastSuccessfulFetchAt = httpStatus >= 200 && httpStatus < 300 ? emittedAt : undefined;

      if (httpStatus === 404) {
        return {
          outcome: "not_found",
          httpStatus,
          resolvedUrl,
          previousResolvedUrl,
          stateChanged,
          availabilityTransition,
          redirectChanged,
          shouldCapture: false,
          failureCount: 0,
          changeSummary: [availabilityTransition ? "Observed transition from available to missing (404 Not Found)." : "Observed 404 Not Found for the watched URL."]
        };
      }

      if (httpStatus === 410) {
        return {
          outcome: "gone",
          httpStatus,
          resolvedUrl,
          previousResolvedUrl,
          stateChanged,
          availabilityTransition,
          redirectChanged,
          shouldCapture: false,
          failureCount: 0,
          changeSummary: [availabilityTransition ? "Observed transition from available to gone (410 Gone)." : "Observed 410 Gone for the watched URL."]
        };
      }

      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429 || httpStatus === 451) {
        return {
          outcome: "blocked",
          httpStatus,
          resolvedUrl,
          previousResolvedUrl,
          stateChanged,
          availabilityTransition,
          redirectChanged,
          shouldCapture: false,
          failureCount: (watchlist.failureCount ?? 0) + 1,
          lastErrorCode: "http_" + httpStatus,
          changeSummary: ["Observed blocked fetch outcome (" + httpStatus + ")."]
        };
      }

      if (httpStatus >= 500) {
        return {
          outcome: "server_error",
          httpStatus,
          resolvedUrl,
          previousResolvedUrl,
          stateChanged,
          availabilityTransition,
          redirectChanged,
          shouldCapture: false,
          failureCount: (watchlist.failureCount ?? 0) + 1,
          lastErrorCode: "http_" + httpStatus,
          changeSummary: ["Observed server error (" + httpStatus + ") while checking the watched URL."]
        };
      }

      if (httpStatus < 200 || httpStatus >= 300) {
        return {
          outcome: "network_error",
          httpStatus,
          resolvedUrl,
          previousResolvedUrl,
          stateChanged,
          availabilityTransition,
          redirectChanged,
          shouldCapture: false,
          failureCount: (watchlist.failureCount ?? 0) + 1,
          lastErrorCode: "http_" + httpStatus,
          changeSummary: ["Observed unsupported fetch outcome (" + httpStatus + ") while checking the watched URL."]
        };
      }

      if (contentTypeChanged && !isSupportedWatchContentType(contentType)) {
        return {
          outcome: "content_type_changed",
          httpStatus,
          resolvedUrl,
          contentType,
          previousResolvedUrl,
          stateChanged: true,
          availabilityTransition,
          redirectChanged,
          lastSuccessfulFetchAt,
          shouldCapture: false,
          failureCount: 0,
          changeSummary: ["Observed content type change from " + (previousContentType ?? "unknown") + " to " + (contentType ?? "unknown") + "."]
        };
      }

      if (!isSupportedWatchContentType(contentType)) {
        return {
          outcome: "content_type_changed",
          httpStatus,
          resolvedUrl,
          contentType,
          previousResolvedUrl,
          stateChanged,
          availabilityTransition,
          redirectChanged,
          lastSuccessfulFetchAt,
          shouldCapture: false,
          failureCount: 0,
          changeSummary: ["Observed unsupported content type " + (contentType ?? "unknown") + " for the watched URL."]
        };
      }

      return {
        outcome: redirectObserved ? "redirected" : contentTypeChanged ? "content_type_changed" : "ok_unchanged",
        httpStatus,
        resolvedUrl,
        contentType,
        previousResolvedUrl,
        stateChanged,
        availabilityTransition,
        redirectChanged,
        lastSuccessfulFetchAt,
        shouldCapture: true,
        failureCount: 0,
        changeSummary: redirectObserved
          ? [redirectChanged ? "Observed redirect target change to " + resolvedUrl + "." : "Observed redirect to " + resolvedUrl + "."]
          : contentTypeChanged
            ? ["Observed content type change from " + (previousContentType ?? "unknown") + " to " + (contentType ?? "unknown") + "."]
            : ["Watch fetch completed successfully with no fetch-state changes detected."]
      };
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : "Watch fetch failed";
      const isTimeout = error instanceof Error && error.name === "AbortError";
      return {
        outcome: isTimeout ? "timeout" : "network_error",
        previousResolvedUrl,
        stateChanged: false,
        shouldCapture: false,
        failureCount: (watchlist.failureCount ?? 0) + 1,
        lastErrorCode: isTimeout ? "timeout" : "network_error",
        changeSummary: [message]
      };
    }
  }

  private buildPayload(args: {
    watchlist: Watchlist;
    runId: string;
    verdict: WatchlistRunVerdict;
    olderCaptureId?: string;
    newerCaptureId?: string;
    changeDetected: boolean;
    changeSummary: string[];
    comparison?: CaptureComparison;
    proofBundleHashes: { older?: string; newer?: string };
    checkpointIds: { older?: string; newer?: string };
    outcome?: WatchlistRun["outcome"];
    httpStatus?: number;
    resolvedUrl?: string;
    previousResolvedUrl?: string;
    stateChanged?: boolean;
    availabilityTransition?: WatchlistRun["availabilityTransition"];
    redirectChanged?: boolean;
    captureHealth?: WatchlistCaptureHealth;
    extractionDriftDetected?: boolean;
    screenshotPresent?: boolean;
    screenshotHash?: string;
    emittedAt?: string;
    eventType?: WatchlistEventType;
    deliveryKind?: WatchlistResultPayload["deliveryKind"];
    deliveryTarget?: string;
    deliveryError?: string;
  }): WatchlistResultPayload {
    const emittedAt = args.emittedAt ?? new Date().toISOString();
    const comparePath = this.buildComparePath(args.watchlist.normalizedRequestedUrl, args.olderCaptureId, args.newerCaptureId);

    return {
      schemaVersion: 3,
      eventType: args.eventType ?? deriveWatchlistEventType(args.verdict),
      watchlistId: args.watchlist.id,
      watchlistRunId: args.runId,
      watchedUrl: args.watchlist.requestedUrl,
      normalizedRequestedUrl: args.watchlist.normalizedRequestedUrl,
      runTimestamp: emittedAt,
      verdict: args.verdict,
      outcome: args.outcome,
      httpStatus: args.httpStatus,
      resolvedUrl: args.resolvedUrl,
      previousResolvedUrl: args.previousResolvedUrl,
      stateChanged: args.stateChanged,
      availabilityTransition: args.availabilityTransition,
      redirectChanged: args.redirectChanged,
      comparePath,
      comparePermalink: comparePath,
      olderCaptureId: args.olderCaptureId,
      newerCaptureId: args.newerCaptureId,
      changeDetected: args.changeDetected,
      changedFields: deriveChangedFields(args.comparison),
      conciseSummary: args.changeSummary[0] ?? "Watchlist run completed.",
      changeSummary: args.changeSummary,
      proofBundleHashes: args.proofBundleHashes,
      checkpointIds: args.checkpointIds,
      latestCheckpointId: args.checkpointIds.newer ?? args.checkpointIds.older,
      captureHealth: args.captureHealth,
      extractionDriftDetected: args.extractionDriftDetected,
      screenshotPresent: args.screenshotPresent,
      screenshotHash: args.screenshotHash,
      deliveryKind: args.deliveryKind,
      deliveryTarget: args.deliveryTarget,
      deliveryError: args.deliveryError,
      emittedAt
    };
  }

  private async enrichRun(run: WatchlistRun): Promise<WatchlistRun> {
    const deliveries = await this.repository.listWatchlistNotificationDeliveries(run.id);
    let extractionDriftDetected = false;

    if (run.previousCaptureId && run.newerCaptureId) {
      try {
        const comparison = await this.processor.compareCapturesForUrl(run.normalizedRequestedUrl, {
          basis: "capture-id",
          fromCaptureId: run.previousCaptureId,
          toCaptureId: run.newerCaptureId
        });
        extractionDriftDetected = comparison.diagnostics.notes.length > 0;
      } catch {
        extractionDriftDetected = false;
      }
    }

    return {
      ...run,
      comparePath: this.buildComparePath(run.normalizedRequestedUrl, run.previousCaptureId, run.newerCaptureId),
      extractionDriftDetected,
      captureHealth: run.captureHealth ?? (run.newerCaptureId ? await this.deriveRunCaptureHealth(run) : run.status === "failed" ? "failed" : undefined),
      notificationSummary: {
        total: deliveries.length,
        localRecorded: deliveries.filter((delivery) => delivery.kind === "local" && delivery.status === "recorded").length,
        jsonRecorded: deliveries.filter((delivery) => delivery.kind === "json" && delivery.status === "recorded").length,
        webhookSent: deliveries.filter((delivery) => delivery.kind === "webhook" && delivery.status === "sent").length,
        webhookFailed: deliveries.filter((delivery) => delivery.kind === "webhook" && delivery.status === "failed").length
      },
      deliveries
    };
  }

  private async enrichWatchlist(watchlist: Watchlist): Promise<Watchlist> {
    const runs = await this.listWatchlistRuns(watchlist.id);
    const latestRun = runs[0];
    const latestCompletedRun = runs.find((run) => run.status === "completed" && run.newerCaptureId);
    const latestChangedRun = runs.find((run) => run.status === "completed" && run.changeDetected && run.newerCaptureId);
    const latestCapture = latestCompletedRun?.newerCaptureId
      ? await this.repository.getCapture(latestCompletedRun.newerCaptureId)
      : undefined;
    const latestCaptureDetail = latestCompletedRun?.newerCaptureId
      ? await this.loadCaptureDetail(latestCompletedRun.newerCaptureId)
      : undefined;
    const lastChangedCapture = latestChangedRun?.newerCaptureId
      ? await this.repository.getCapture(latestChangedRun.newerCaptureId)
      : undefined;

    const latestRunVerdict = latestRun
      ? deriveWatchlistVerdict({
          status: latestRun.status,
          previousCaptureId: latestRun.previousCaptureId,
          changeDetected: latestRun.changeDetected,
          stateChanged: latestRun.stateChanged,
          hadPreviousObservation: runs.length > 1
        })
      : undefined;

    return {
      ...watchlist,
      latestRun,
      latestRunVerdict,
      latestCaptureHealth: latestRun?.status === "failed" ? "failed" : latestRun?.captureHealth ?? (latestCaptureDetail ? deriveCaptureHealth(latestCaptureDetail) : undefined),
      lastCaptureAt: latestCapture?.capturedAt ?? latestCapture?.createdAt,
      lastChangeDetectedAt: lastChangedCapture?.capturedAt ?? lastChangedCapture?.createdAt,
      nextScheduledRunAt: watchlist.nextRunAt,
      lastSuccessfulCaptureAt: latestCapture?.capturedAt,
      lastSuccessfulCheckpointId: latestCompletedRun?.checkpointIds.newer
    };
  }

  async testWebhook(id: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const watchlist = await this.repository.getWatchlist(id);
    if (!watchlist?.webhookUrl) {
      throw new Error("This watchlist does not have a webhook URL configured");
    }

    const payload = this.buildPayload({
      watchlist,
      runId: "test-webhook",
      verdict: "unchanged",
      changeDetected: false,
      changeSummary: ["Test delivery from the auth-layer watchlist system."],
      proofBundleHashes: {},
      checkpointIds: {},
      captureHealth: "success"
    });

    try {
      const response = await this.fetchImpl(watchlist.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Webhook request failed" };
    }
  }

  private async deliverWatchlistPayload(watchlist: Watchlist, runId: string, payload: WatchlistResultPayload): Promise<void> {
    await this.repository.recordWatchlistNotificationDelivery({
      watchlistRunId: runId,
      kind: "local",
      status: "recorded",
      payload
    });

    if (watchlist.emitJson) {
      await this.repository.recordWatchlistNotificationDelivery({
        watchlistRunId: runId,
        kind: "json",
        status: "recorded",
        payload
      });
    }

    if (!watchlist.webhookUrl) {
      return;
    }

    try {
      const response = await this.fetchImpl(watchlist.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        await this.repository.recordWatchlistNotificationDelivery({
          watchlistRunId: runId,
          kind: "webhook",
          status: "sent",
          target: watchlist.webhookUrl,
          payload,
          responseStatus: response.status
        });
        return;
      }

      await this.repository.recordWatchlistNotificationDelivery({
        watchlistRunId: runId,
        kind: "webhook",
        status: "failed",
        target: watchlist.webhookUrl,
        payload: {
          ...payload,
          eventType: "watchlist.delivery.failed",
          deliveryKind: "webhook",
          deliveryTarget: watchlist.webhookUrl,
          deliveryError: "Webhook responded with status " + response.status
        },
        responseStatus: response.status,
        errorMessage: "Webhook responded with status " + response.status
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook request failed";
      await this.repository.recordWatchlistNotificationDelivery({
        watchlistRunId: runId,
        kind: "webhook",
        status: "failed",
        target: watchlist.webhookUrl,
        payload: {
          ...payload,
          eventType: "watchlist.delivery.failed",
          deliveryKind: "webhook",
          deliveryTarget: watchlist.webhookUrl,
          deliveryError: message
        },
        errorMessage: message
      });
    }
  }

  private async executeWatchlist(watchlist: Watchlist): Promise<WatchlistRun> {
    const run = await this.repository.createWatchlistRun({
      watchlistId: watchlist.id,
      normalizedRequestedUrl: watchlist.normalizedRequestedUrl
    });
    const emittedAt = new Date().toISOString();
    const hadPreviousObservation = Boolean(watchlist.lastCheckedAt || watchlist.lastRunAt || watchlist.latestRunId);

    try {
      const fetchAssessment = await this.assessFetch(watchlist, emittedAt);

      if (!fetchAssessment.shouldCapture) {
        const isOperationalFailure = fetchAssessment.outcome === "blocked" || fetchAssessment.outcome === "server_error" || fetchAssessment.outcome === "network_error" || fetchAssessment.outcome === "timeout";
        const verdict = deriveWatchlistVerdict({
          status: isOperationalFailure ? "failed" : "completed",
          changeDetected: false,
          stateChanged: fetchAssessment.stateChanged,
          hadPreviousObservation
        });
        const payload = this.buildPayload({
          watchlist,
          runId: run.id,
          verdict,
          outcome: fetchAssessment.outcome,
          httpStatus: fetchAssessment.httpStatus,
          resolvedUrl: fetchAssessment.resolvedUrl,
          previousResolvedUrl: fetchAssessment.previousResolvedUrl,
          stateChanged: fetchAssessment.stateChanged,
          availabilityTransition: fetchAssessment.availabilityTransition,
          redirectChanged: fetchAssessment.redirectChanged,
          changeDetected: false,
          changeSummary: fetchAssessment.changeSummary,
          proofBundleHashes: {},
          checkpointIds: {},
          captureHealth: isOperationalFailure ? "failed" : undefined,
          eventType: isOperationalFailure ? "watchlist.run.failed" : undefined,
          emittedAt
        });

        if (isOperationalFailure) {
          const failedRun = await this.repository.failWatchlistRun({
            watchlistRunId: run.id,
            errorMessage: fetchAssessment.changeSummary[0] ?? "Watch fetch failed",
            outcome: fetchAssessment.outcome,
            httpStatus: fetchAssessment.httpStatus,
            resolvedUrl: fetchAssessment.resolvedUrl,
            previousResolvedUrl: fetchAssessment.previousResolvedUrl,
            stateChanged: fetchAssessment.stateChanged,
            availabilityTransition: fetchAssessment.availabilityTransition,
            redirectChanged: fetchAssessment.redirectChanged,
            completedAt: emittedAt,
            lastCheckedAt: emittedAt,
            lastStateChangeAt: fetchAssessment.stateChanged ? emittedAt : undefined,
            lastHttpStatus: fetchAssessment.httpStatus,
            lastResolvedUrl: fetchAssessment.resolvedUrl,
            failureCount: fetchAssessment.failureCount,
            lastErrorCode: fetchAssessment.lastErrorCode
          });
          await this.deliverWatchlistPayload(watchlist, run.id, payload);
          return this.enrichRun(failedRun);
        }

        const completedRun = await this.repository.completeWatchlistRun({
          watchlistRunId: run.id,
          outcome: fetchAssessment.outcome,
          httpStatus: fetchAssessment.httpStatus,
          resolvedUrl: fetchAssessment.resolvedUrl,
          previousResolvedUrl: fetchAssessment.previousResolvedUrl,
          stateChanged: fetchAssessment.stateChanged,
          availabilityTransition: fetchAssessment.availabilityTransition,
          redirectChanged: fetchAssessment.redirectChanged,
          changeDetected: false,
          changeSummary: fetchAssessment.changeSummary,
          proofBundleHashes: {},
          checkpointIds: {},
          completedAt: emittedAt,
          lastCheckedAt: emittedAt,
          lastSuccessfulFetchAt: fetchAssessment.lastSuccessfulFetchAt,
          lastStateChangeAt: fetchAssessment.stateChanged ? emittedAt : undefined,
          lastHttpStatus: fetchAssessment.httpStatus,
          lastResolvedUrl: fetchAssessment.resolvedUrl,
          failureCount: fetchAssessment.failureCount,
          lastErrorCode: fetchAssessment.lastErrorCode
        });
        await this.deliverWatchlistPayload(watchlist, run.id, payload);
        return this.enrichRun(completedRun);
      }

      const capture = await this.repository.createCapture({
        requestedUrl: watchlist.requestedUrl,
        normalizedRequestedUrl: watchlist.normalizedRequestedUrl,
        extractorVersion: this.extractorVersion
      });
      const processed = await this.processor.processClaimedCapture(capture);
      const olderCaptureId = processed.comparedToCaptureId;
      const newerCaptureId = processed.id;
      const comparison = olderCaptureId
        ? await this.processor.compareCapturesForUrl(watchlist.normalizedRequestedUrl, {
            basis: "capture-id",
            fromCaptureId: olderCaptureId,
            toCaptureId: newerCaptureId
          })
        : undefined;
      const changeDetected = comparison
        ? Object.values(comparison.fields).some(Boolean) || comparison.blockSummary.paragraphsAdded > 0 || comparison.blockSummary.paragraphsRemoved > 0 || comparison.blockSummary.headingsChanged > 0
        : false;
      const newerDetail = await this.loadCaptureDetail(newerCaptureId);
      const captureHealth = deriveCaptureHealth(newerDetail);
      const extractionDriftDetected = comparison ? comparison.diagnostics.notes.length > 0 : false;
      const outcome = fetchAssessment.outcome === "ok_unchanged"
        ? changeDetected
          ? "ok_changed"
          : "ok_unchanged"
        : fetchAssessment.outcome;
      const changeSummary = comparison?.changeSummary
        ? fetchAssessment.outcome === "ok_unchanged"
          ? comparison.changeSummary
          : [...fetchAssessment.changeSummary, ...comparison.changeSummary]
        : fetchAssessment.outcome === "ok_unchanged"
          ? ["Baseline observation: this watchlist has no prior successful capture yet."]
          : [...fetchAssessment.changeSummary, "Baseline observation: this watchlist has no prior successful capture yet."];
      const verdict = deriveWatchlistVerdict({
        status: "completed",
        previousCaptureId: olderCaptureId,
        changeDetected,
        stateChanged: fetchAssessment.stateChanged,
        hadPreviousObservation
      });
      const payload = this.buildPayload({
        watchlist,
        runId: run.id,
        verdict,
        olderCaptureId,
        newerCaptureId,
        outcome,
        httpStatus: fetchAssessment.httpStatus,
        resolvedUrl: fetchAssessment.resolvedUrl,
        previousResolvedUrl: fetchAssessment.previousResolvedUrl,
        stateChanged: fetchAssessment.stateChanged,
        availabilityTransition: fetchAssessment.availabilityTransition,
        redirectChanged: fetchAssessment.redirectChanged,
        changeDetected,
        changeSummary,
        comparison,
        proofBundleHashes: {
          older: comparison?.older.capture.proofBundleHash,
          newer: processed.proofBundleHash
        },
        checkpointIds: {
          older: comparison?.older.receipt?.transparencyCheckpointId,
          newer: comparison?.newer.receipt?.transparencyCheckpointId
        },
        captureHealth,
        extractionDriftDetected,
        screenshotPresent: Boolean(newerDetail?.capture.artifacts.screenshotStorageKey),
        screenshotHash: newerDetail?.capture.renderedEvidence?.screenshot?.hash ?? newerDetail?.capture.renderedEvidence?.screenshotHash,
        emittedAt
      });

      const completedRun = await this.repository.completeWatchlistRun({
        watchlistRunId: run.id,
        captureId: processed.id,
        previousCaptureId: olderCaptureId,
        newerCaptureId,
        outcome,
        httpStatus: fetchAssessment.httpStatus,
        resolvedUrl: fetchAssessment.resolvedUrl,
        previousResolvedUrl: fetchAssessment.previousResolvedUrl,
        stateChanged: fetchAssessment.stateChanged,
        availabilityTransition: fetchAssessment.availabilityTransition,
        redirectChanged: fetchAssessment.redirectChanged,
        changeDetected,
        changeSummary,
        proofBundleHashes: payload.proofBundleHashes,
        checkpointIds: payload.checkpointIds,
        completedAt: emittedAt,
        lastCheckedAt: emittedAt,
        lastSuccessfulFetchAt: fetchAssessment.lastSuccessfulFetchAt ?? emittedAt,
        lastStateChangeAt: fetchAssessment.stateChanged || changeDetected ? emittedAt : undefined,
        lastHttpStatus: fetchAssessment.httpStatus,
        lastResolvedUrl: fetchAssessment.resolvedUrl,
        failureCount: 0,
        lastErrorCode: undefined
      });

      await this.deliverWatchlistPayload(watchlist, run.id, payload);
      return this.enrichRun(completedRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown watchlist failure";
      const failedRun = await this.repository.failWatchlistRun({
        watchlistRunId: run.id,
        errorMessage: message,
        outcome: "network_error",
        completedAt: emittedAt,
        lastCheckedAt: emittedAt,
        failureCount: (watchlist.failureCount ?? 0) + 1,
        lastErrorCode: "watch_execution_failed"
      });
      const payload = this.buildPayload({
        watchlist,
        runId: run.id,
        verdict: "failed",
        outcome: "network_error",
        changeDetected: false,
        changeSummary: [message],
        proofBundleHashes: {},
        checkpointIds: {},
        captureHealth: "failed",
        eventType: "watchlist.run.failed",
        emittedAt
      });
      await this.deliverWatchlistPayload(watchlist, run.id, payload);
      return this.enrichRun(failedRun);
    }
  }

  async runWatchlistNow(id: string): Promise<WatchlistRun> {
    const watchlist = await this.repository.getWatchlist(id);
    if (!watchlist) {
      throw new Error("Watchlist " + id + " not found");
    }
    if (watchlist.status === "expired" || watchlist.status === "archived") {
      throw new Error("Watchlist " + id + " is " + watchlist.status + " and cannot be run");
    }

    return this.executeWatchlist(watchlist);
  }

  async runDueWatchlist(workerId: string, now = new Date().toISOString()): Promise<WatchlistRun | undefined> {
    const watchlist = await this.repository.claimNextDueWatchlist(workerId, now);
    if (!watchlist) {
      return undefined;
    }

    return this.executeWatchlist(watchlist);
  }
}
