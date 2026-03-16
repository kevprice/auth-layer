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

const deriveWatchlistVerdict = (input: { status?: WatchlistRun["status"]; previousCaptureId?: string; changeDetected?: boolean }): WatchlistRunVerdict => {
  if (input.status === "failed") {
    return "failed";
  }

  if (!input.previousCaptureId) {
    return "baseline";
  }

  return input.changeDetected ? "changed" : "unchanged";
};

const deriveWatchlistEventType = (verdict: WatchlistRunVerdict): WatchlistEventType => {
  if (verdict === "failed") {
    return "watchlist.run.failed";
  }

  return verdict === "changed" ? "watchlist.change.detected" : "watchlist.run.completed";
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
      webhookUrl: input.webhookUrl,
      emitJson: input.emitJson
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
      schemaVersion: 2,
      eventType: args.eventType ?? deriveWatchlistEventType(args.verdict),
      watchlistId: args.watchlist.id,
      watchlistRunId: args.runId,
      watchedUrl: args.watchlist.requestedUrl,
      normalizedRequestedUrl: args.watchlist.normalizedRequestedUrl,
      runTimestamp: emittedAt,
      verdict: args.verdict,
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
      captureHealth: run.captureHealth ?? await this.deriveRunCaptureHealth(run),
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
          changeDetected: latestRun.changeDetected
        })
      : undefined;

    return {
      ...watchlist,
      latestRun,
      latestRunVerdict,
      latestCaptureHealth: latestRun?.status === "failed" ? "failed" : deriveCaptureHealth(latestCaptureDetail),
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

  private async executeWatchlist(watchlist: Watchlist): Promise<WatchlistRun> {
    const run = await this.repository.createWatchlistRun({
      watchlistId: watchlist.id,
      normalizedRequestedUrl: watchlist.normalizedRequestedUrl
    });

    try {
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
      const changeSummary = comparison?.changeSummary ?? ["Baseline observation: this watchlist has no prior successful capture yet."];
      const changeDetected = comparison
        ? Object.values(comparison.fields).some(Boolean) || comparison.blockSummary.paragraphsAdded > 0 || comparison.blockSummary.paragraphsRemoved > 0 || comparison.blockSummary.headingsChanged > 0
        : false;
      const newerDetail = await this.loadCaptureDetail(newerCaptureId);
      const captureHealth = deriveCaptureHealth(newerDetail);
      const extractionDriftDetected = comparison ? comparison.diagnostics.notes.length > 0 : false;
      const verdict = deriveWatchlistVerdict({
        status: "completed",
        previousCaptureId: olderCaptureId,
        changeDetected
      });
      const payload = this.buildPayload({
        watchlist,
        runId: run.id,
        verdict,
        olderCaptureId,
        newerCaptureId,
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
        screenshotHash: newerDetail?.capture.renderedEvidence?.screenshot?.hash ?? newerDetail?.capture.renderedEvidence?.screenshotHash
      });

      const completedRun = await this.repository.completeWatchlistRun({
        watchlistRunId: run.id,
        captureId: processed.id,
        previousCaptureId: olderCaptureId,
        newerCaptureId,
        changeDetected,
        changeSummary,
        proofBundleHashes: payload.proofBundleHashes,
        checkpointIds: payload.checkpointIds,
        completedAt: payload.emittedAt
      });

      await this.repository.recordWatchlistNotificationDelivery({
        watchlistRunId: run.id,
        kind: "local",
        status: "recorded",
        payload
      });

      if (watchlist.emitJson) {
        await this.repository.recordWatchlistNotificationDelivery({
          watchlistRunId: run.id,
          kind: "json",
          status: "recorded",
          payload
        });
      }

      if (watchlist.webhookUrl) {
        try {
          const response = await this.fetchImpl(watchlist.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (response.ok) {
            await this.repository.recordWatchlistNotificationDelivery({
              watchlistRunId: run.id,
              kind: "webhook",
              status: "sent",
              target: watchlist.webhookUrl,
              payload,
              responseStatus: response.status
            });
          } else {
            await this.repository.recordWatchlistNotificationDelivery({
              watchlistRunId: run.id,
              kind: "webhook",
              status: "failed",
              target: watchlist.webhookUrl,
              payload: this.buildPayload({
                watchlist,
                runId: run.id,
                verdict,
                olderCaptureId,
                newerCaptureId,
                changeDetected,
                changeSummary,
                comparison,
                proofBundleHashes: payload.proofBundleHashes,
                checkpointIds: payload.checkpointIds,
                captureHealth,
                extractionDriftDetected,
                screenshotPresent: payload.screenshotPresent,
                screenshotHash: payload.screenshotHash,
                eventType: "watchlist.delivery.failed",
                deliveryKind: "webhook",
                deliveryTarget: watchlist.webhookUrl,
                deliveryError: `Webhook responded with status ${response.status}`,
                emittedAt: payload.emittedAt
              }),
              responseStatus: response.status,
              errorMessage: `Webhook responded with status ${response.status}`
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Webhook request failed";
          await this.repository.recordWatchlistNotificationDelivery({
            watchlistRunId: run.id,
            kind: "webhook",
            status: "failed",
            target: watchlist.webhookUrl,
            payload: this.buildPayload({
              watchlist,
              runId: run.id,
              verdict,
              olderCaptureId,
              newerCaptureId,
              changeDetected,
              changeSummary,
              comparison,
              proofBundleHashes: payload.proofBundleHashes,
              checkpointIds: payload.checkpointIds,
              captureHealth,
              extractionDriftDetected,
              screenshotPresent: payload.screenshotPresent,
              screenshotHash: payload.screenshotHash,
              eventType: "watchlist.delivery.failed",
              deliveryKind: "webhook",
              deliveryTarget: watchlist.webhookUrl,
              deliveryError: message,
              emittedAt: payload.emittedAt
            }),
            errorMessage: message
          });
        }
      }

      return this.enrichRun(completedRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown watchlist failure";
      const failedRun = await this.repository.failWatchlistRun({
        watchlistRunId: run.id,
        errorMessage: message
      });
      const payload = this.buildPayload({
        watchlist,
        runId: run.id,
        verdict: "failed",
        changeDetected: false,
        changeSummary: [message],
        proofBundleHashes: {},
        checkpointIds: {},
        captureHealth: "failed",
        eventType: "watchlist.run.failed"
      });

      await this.repository.recordWatchlistNotificationDelivery({
        watchlistRunId: run.id,
        kind: "local",
        status: "recorded",
        payload
      });

      if (watchlist.emitJson) {
        await this.repository.recordWatchlistNotificationDelivery({
          watchlistRunId: run.id,
          kind: "json",
          status: "recorded",
          payload
        });
      }

      if (watchlist.webhookUrl) {
        try {
          const response = await this.fetchImpl(watchlist.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (response.ok) {
            await this.repository.recordWatchlistNotificationDelivery({
              watchlistRunId: run.id,
              kind: "webhook",
              status: "sent",
              target: watchlist.webhookUrl,
              payload,
              responseStatus: response.status
            });
          } else {
            await this.repository.recordWatchlistNotificationDelivery({
              watchlistRunId: run.id,
              kind: "webhook",
              status: "failed",
              target: watchlist.webhookUrl,
              payload: this.buildPayload({
                watchlist,
                runId: run.id,
                verdict: "failed",
                changeDetected: false,
                changeSummary: [message],
                proofBundleHashes: {},
                checkpointIds: {},
                captureHealth: "failed",
                eventType: "watchlist.delivery.failed",
                deliveryKind: "webhook",
                deliveryTarget: watchlist.webhookUrl,
                deliveryError: `Webhook responded with status ${response.status}`,
                emittedAt: payload.emittedAt
              }),
              responseStatus: response.status,
              errorMessage: `Webhook responded with status ${response.status}`
            });
          }
        } catch (deliveryError) {
          const deliveryMessage = deliveryError instanceof Error ? deliveryError.message : "Webhook request failed";
          await this.repository.recordWatchlistNotificationDelivery({
            watchlistRunId: run.id,
            kind: "webhook",
            status: "failed",
            target: watchlist.webhookUrl,
            payload: this.buildPayload({
              watchlist,
              runId: run.id,
              verdict: "failed",
              changeDetected: false,
              changeSummary: [message],
              proofBundleHashes: {},
              checkpointIds: {},
              captureHealth: "failed",
              eventType: "watchlist.delivery.failed",
              deliveryKind: "webhook",
              deliveryTarget: watchlist.webhookUrl,
              deliveryError: deliveryMessage,
              emittedAt: payload.emittedAt
            }),
            errorMessage: deliveryMessage
          });
        }
      }

      return this.enrichRun(failedRun);
    }
  }

  async runWatchlistNow(id: string): Promise<WatchlistRun> {
    const watchlist = await this.repository.getWatchlist(id);
    if (!watchlist) {
      throw new Error(`Watchlist ${id} not found`);
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
