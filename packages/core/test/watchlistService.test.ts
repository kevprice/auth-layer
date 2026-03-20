import { newDb } from "pg-mem";
import { describe, expect, it, vi } from "vitest";

import { PostgresCaptureRepository, WatchlistService, runMigrations } from "../src/index.js";

const createResponse = (status: number, url: string, contentType = "text/html; charset=utf-8"): Response =>
  ({
    status,
    url,
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
    arrayBuffer: async () => Buffer.from("")
  } as unknown as Response);

describe("WatchlistService smart watchlists", () => {
  it("claims burst-mode watches using the burst cadence and expires old watches", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    await runMigrations(pool);
    const repository = new PostgresCaptureRepository(pool);

    const watch = await repository.createWatchlist({
      url: "https://example.com/story",
      intervalSeconds: 3600,
      burstConfig: { enabled: true }
    });

    await pool.query("UPDATE watchlists SET next_run_at = $2 WHERE id = $1", [watch.id, new Date("2026-03-20T10:00:00.000Z")]);
    const claimed = await repository.claimNextDueWatchlist("worker-1", "2026-03-20T10:05:00.000Z");
    expect(claimed?.intervalSeconds).toBe(3600);
    expect(claimed?.burstConfig?.enabled).toBe(true);
    expect(claimed?.nextRunAt).toBe("2026-03-20T10:10:00.000Z");

    const expiring = await repository.createWatchlist({
      url: "https://example.com/expired",
      intervalSeconds: 600,
      expiresAt: "2026-03-20T09:00:00.000Z"
    });
    await pool.query("UPDATE watchlists SET next_run_at = $2 WHERE id = $1", [expiring.id, new Date("2026-03-20T08:55:00.000Z")]);
    const skipped = await repository.claimNextDueWatchlist("worker-1", "2026-03-20T10:05:00.000Z");
    expect(skipped).toBeUndefined();
    const expiredWatch = await repository.getWatchlist(expiring.id);
    expect(expiredWatch?.status).toBe("expired");

    await repository.close?.();
  });

  it("records not found and missing-to-available transitions as first-class outcomes", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    await runMigrations(pool);
    const repository = new PostgresCaptureRepository(pool);

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(createResponse(404, "https://example.com/story"))
      .mockResolvedValueOnce(createResponse(200, "https://example.com/story", "text/plain; charset=utf-8"));

    const service = new WatchlistService(
      repository,
      {
        loadCaptureDetail: vi.fn(),
        compareCapturesForUrl: vi.fn(),
        processClaimedCapture: vi.fn()
      } as never,
      "readability-v1",
      fetchImpl as unknown as typeof fetch
    );

    const watch = await service.createWatchlist({
      url: "https://example.com/story",
      intervalSeconds: 300,
      emitJson: true
    });

    const firstRun = await service.runWatchlistNow(watch.id);
    expect(firstRun.outcome).toBe("not_found");
    expect(firstRun.httpStatus).toBe(404);
    expect(firstRun.status).toBe("completed");

    const secondRun = await service.runWatchlistNow(watch.id);
    expect(secondRun.outcome).toBe("content_type_changed");
    expect(secondRun.availabilityTransition).toBe("missing_to_available");
    expect(secondRun.status).toBe("completed");

    const refreshed = await service.getWatchlist(watch.id);
    expect(refreshed?.lastHttpStatus).toBe(200);
    expect(refreshed?.lastCheckedAt).toBeTruthy();
    expect(refreshed?.failureCount).toBe(0);

    await repository.close?.();
  });
});
