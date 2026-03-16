import type { CaptureRecord } from "@auth-layer/shared";

import type { CaptureRepository } from "../repositories/captureRepository.js";
import { createId } from "../utils/id.js";
import type { CaptureProcessor } from "../services/captureProcessor.js";
import type { WatchlistService } from "../services/watchlistService.js";

export class PollingWorker {
  private intervalHandle: NodeJS.Timeout | undefined;
  private isRunning = false;
  private readonly workerId: string;

  constructor(
    private readonly repository: CaptureRepository,
    private readonly processor: CaptureProcessor,
    private readonly intervalMs = 1500,
    workerId?: string,
    private readonly watchlistService?: WatchlistService
  ) {
    this.workerId = workerId ?? createId();
  }

  async runOnce(): Promise<CaptureRecord | undefined> {
    if (this.isRunning) {
      return undefined;
    }

    this.isRunning = true;

    try {
      const watchlistRun = await this.watchlistService?.runDueWatchlist(this.workerId);
      if (watchlistRun) {
        return undefined;
      }

      const nextCapture = await this.repository.claimNextQueuedCapture(this.workerId);
      if (!nextCapture) {
        return undefined;
      }

      await this.processor.processClaimedCapture(nextCapture);
      return nextCapture;
    } finally {
      this.isRunning = false;
    }
  }

  start(): void {
    if (this.intervalHandle) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);

    void this.runOnce();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }
}
