import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/db/migrations.js";

describe("runMigrations", () => {
  it("bootstraps a fresh database and safely no-ops on a second run", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();

    const firstRun = await runMigrations(pool);
    expect(firstRun).toEqual([
      "001_postgres_primary_evidence_store.sql",
      "002_transparency_log_and_proof_packages.sql",
      "003_operator_signed_transparency_checkpoints.sql",
      "004_merkle_transparency_checkpoints.sql",
      "005_backfill_capture_projection_columns.sql",
      "006_watchlists_and_pdf_support.sql",
      "007_rendered_evidence_and_pdf_approvals.sql",
      "008_capture_approval_semantics.sql"
    ]);

    for (const tableName of [
      "approval_receipt_events",
      "artifact_references",
      "canonical_content_versions",
      "capture_events",
      "captures",
      "metadata_versions",
      "proof_bundle_versions",
      "receipt_events",
      "schema_migrations",
      "transparency_log_checkpoints",
      "transparency_log_entries",
      "watchlists",
      "watchlist_runs",
      "watchlist_notification_deliveries"
    ]) {
      await expect(pool.query(`SELECT * FROM ${tableName} LIMIT 0`)).resolves.toBeTruthy();
    }

    const secondRun = await runMigrations(pool);
    expect(secondRun).toEqual([]);

    await pool.end();
  });
});
