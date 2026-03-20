import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  ArtifactReference,
  CaptureLifecycleEvent,
  CaptureRecord,
  CreateWatchlistRequest,
  AttestationBundle,
  PdfApprovalReceipt,
  TransparencyCheckpoint,
  TransparencyLogEntry,
  TransparencyReceipt,
  UpdateWatchlistRequest,
  Watchlist,
  WatchlistNotificationDelivery,
  WatchlistResultPayload,
  WatchlistRun
} from "@auth-layer/shared";

import { hashStableValue } from "../utils/stableJson.js";
import { createId } from "../utils/id.js";
import type {
  ArtifactReferenceInput,
  CaptureRepository,
  CompleteWatchlistRunInput,
  CreateCaptureInput,
  CreatePdfCaptureInput,
  DerivationCompletedInput,
  FailWatchlistRunInput,
  FailureInput,
  FetchCompletedInput,
  TimestampCompletedInput,
  WatchlistNotificationDeliveryInput
} from "./captureRepository.js";

const asJson = (value: unknown): string => JSON.stringify(value);
const toIsoString = (value: Date | string | null | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const DEFAULT_WATCHLIST_INTERVAL_SECONDS = 3600;
const DEFAULT_BURST_INTERVAL_SECONDS = 300;
const DEFAULT_BURST_DURATION_SECONDS = 7200;
const WATCHLIST_SELECT_COLUMNS = "id, requested_url, normalized_requested_url, interval_minutes, interval_seconds, status, webhook_url, emit_json, expires_at, burst_config, last_run_at, last_checked_at, last_successful_fetch_at, last_state_change_at, last_http_status, last_resolved_url, failure_count, last_error_code, next_run_at, latest_run_id, created_at, updated_at";
const WATCHLIST_RUN_SELECT_COLUMNS = "id, watchlist_id, capture_id, previous_capture_id, newer_capture_id, normalized_requested_url, status, outcome, http_status, resolved_url, previous_resolved_url, state_changed, availability_transition, redirect_changed, change_detected, change_summary, proof_bundle_hashes, checkpoint_ids, created_at, completed_at, error_message";

const deriveWatchIntervalSeconds = (intervalSeconds?: number | null, intervalMinutes?: number | null): number => {
  const seconds = typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds)
    ? intervalSeconds
    : typeof intervalMinutes === "number" && Number.isFinite(intervalMinutes)
      ? intervalMinutes * 60
      : DEFAULT_WATCHLIST_INTERVAL_SECONDS;
  return Math.max(60, Math.floor(seconds));
};

const deriveWatchIntervalMinutes = (intervalSeconds: number): number => Math.max(1, Math.ceil(intervalSeconds / 60));

const normalizeBurstConfig = (burstConfig?: Watchlist["burstConfig"] | null, createdAt?: Date | string): Watchlist["burstConfig"] | undefined => {
  if (!burstConfig?.enabled) {
    return undefined;
  }
  const createdAtDate = createdAt ? new Date(createdAt) : new Date();
  const durationSeconds = Math.max(60, Math.floor(burstConfig.durationSeconds ?? DEFAULT_BURST_DURATION_SECONDS));
  const intervalSeconds = Math.max(60, Math.floor(burstConfig.intervalSeconds ?? DEFAULT_BURST_INTERVAL_SECONDS));
  const burstUntil = burstConfig.burstUntil ?? new Date(createdAtDate.getTime() + durationSeconds * 1000).toISOString();
  return {
    enabled: true,
    intervalSeconds,
    durationSeconds,
    burstUntil
  };
};

const getEffectiveWatchIntervalSeconds = (watchlist: Pick<Watchlist, "intervalSeconds" | "burstConfig" | "createdAt">, now: Date): number => {
  const burstConfig = normalizeBurstConfig(watchlist.burstConfig, watchlist.createdAt);
  if (burstConfig?.enabled && burstConfig.burstUntil && new Date(burstConfig.burstUntil).getTime() > now.getTime()) {
    return burstConfig.intervalSeconds ?? DEFAULT_BURST_INTERVAL_SECONDS;
  }
  return watchlist.intervalSeconds;
};

const appendArtifactKey = (
  artifacts: CaptureRecord["artifacts"],
  kind: ArtifactReferenceInput["kind"],
  storageKey: string
): CaptureRecord["artifacts"] => {
  switch (kind) {
    case "raw-html":
      return { ...artifacts, rawHtmlStorageKey: storageKey };
    case "raw-pdf":
      return { ...artifacts, rawPdfStorageKey: storageKey };
    case "raw-image":
      return { ...artifacts, rawImageStorageKey: storageKey };
    case "canonical-content":
      return { ...artifacts, canonicalContentStorageKey: storageKey };
    case "metadata":
      return { ...artifacts, metadataStorageKey: storageKey };
    case "proof-bundle":
      return { ...artifacts, proofBundleStorageKey: storageKey };
    case "screenshot":
      return { ...artifacts, screenshotStorageKey: storageKey };
    case "approval-receipt":
      return { ...artifacts, approvalReceiptStorageKey: storageKey };
    case "attestation-bundle":
      return { ...artifacts, attestationBundleStorageKey: storageKey };
    default:
      return artifacts;
  }
};

type CaptureRow = QueryResultRow & {
  id: string;
  artifact_type: string | null;
  source_label: string | null;
  file_name: string | null;
  media_type: string | null;
  byte_size: number | null;
  requested_url: string;
  normalized_requested_url: string;
  final_url: string | null;
  fetched_at: Date | null;
  captured_at: Date | null;
  claimed_published_at: string | null;
  http_status: number | null;
  headers: Record<string, string> | null;
  content_type: string | null;
  charset: string | null;
  raw_snapshot_hash: string | null;
  screenshot_hash: string | null;
  canonical_content_hash: string | null;
  metadata_hash: string | null;
  proof_bundle_hash: string | null;
  proof_receipt_id: string | null;
  extractor_version: string;
  normalization_version: string | null;
  hash_algorithm: string | null;
  canonical_content_schema_version: number | null;
  metadata_schema_version: number | null;
  latest_event_sequence: number;
  latest_canonical_content_version: number | null;
  latest_metadata_version: number | null;
  latest_proof_bundle_version: number | null;
  latest_receipt_version: number | null;
  compared_to_capture_id: string | null;
  status: CaptureRecord["status"];
  page_kind: CaptureRecord["pageKind"] | null;
  content_extraction_status: CaptureRecord["contentExtractionStatus"] | null;
  metadata_changed_from_previous: boolean | null;
  content_changed_from_previous: boolean | null;
  title_changed_from_previous: boolean | null;
  author_changed_from_previous: boolean | null;
  claimed_published_at_changed_from_previous: boolean | null;
  error_code: string | null;
  error_message: string | null;
  actor_account_id: string | null;
  approval_receipt_id: string | null;
  approval_type: string | null;
  approval_scope: string | null;
  approval_method: string | null;
  rendered_evidence: CaptureRecord["renderedEvidence"] | null;
  artifacts: CaptureRecord["artifacts"];
  created_at: Date;
  updated_at: Date;
};

type EventRow = QueryResultRow & {
  capture_id: string;
  sequence_no: number;
  event_type: CaptureLifecycleEvent["eventType"];
  status: CaptureLifecycleEvent["status"];
  event_data: Record<string, unknown>;
  created_at: Date;
};

type ArtifactRow = QueryResultRow & {
  capture_id: string;
  kind: ArtifactReference["kind"];
  version: number;
  storage_key: string;
  content_hash: string;
  content_type: string | null;
  byte_size: number | null;
  created_at: Date;
};

type ApprovalReceiptRow = QueryResultRow & {
  receipt: PdfApprovalReceipt;
};

type TransparencyLogEntryRow = QueryResultRow & {
  schema_version: number;
  log_index: number;
  capture_id: string;
  proof_bundle_hash: string;
  entry_hash: string;
  previous_entry_hash: string | null;
  created_at: Date;
};


type WatchlistRow = QueryResultRow & {
  id: string;
  requested_url: string;
  normalized_requested_url: string;
  interval_minutes: number;
  interval_seconds: number | null;
  status: Watchlist["status"];
  webhook_url: string | null;
  emit_json: boolean;
  expires_at: Date | null;
  burst_config: Watchlist["burstConfig"] | null;
  last_run_at: Date | null;
  last_checked_at: Date | null;
  last_successful_fetch_at: Date | null;
  last_state_change_at: Date | null;
  last_http_status: number | null;
  last_resolved_url: string | null;
  failure_count: number | null;
  last_error_code: string | null;
  next_run_at: Date;
  latest_run_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type WatchlistRunRow = QueryResultRow & {
  id: string;
  watchlist_id: string;
  capture_id: string | null;
  previous_capture_id: string | null;
  newer_capture_id: string | null;
  normalized_requested_url: string;
  status: WatchlistRun["status"];
  outcome: WatchlistRun["outcome"] | null;
  http_status: number | null;
  resolved_url: string | null;
  previous_resolved_url: string | null;
  state_changed: boolean | null;
  availability_transition: WatchlistRun["availabilityTransition"] | null;
  redirect_changed: boolean | null;
  change_detected: boolean | null;
  change_summary: string[] | null;
  proof_bundle_hashes: { older?: string; newer?: string } | null;
  checkpoint_ids: { older?: string; newer?: string } | null;
  created_at: Date;
  completed_at: Date | null;
  error_message: string | null;
};

type WatchlistNotificationDeliveryRow = QueryResultRow & {
  id: string;
  watchlist_run_id: string;
  kind: WatchlistNotificationDelivery["kind"];
  status: WatchlistNotificationDelivery["status"];
  target: string | null;
  payload: WatchlistResultPayload;
  response_status: number | null;
  error_message: string | null;
  created_at: Date;
};

type TransparencyCheckpointRow = QueryResultRow & {
  schema_version: number;
  checkpoint_id: string;
  tree_size: number;
  last_log_index: number;
  last_entry_hash: string;
  root_hash: string;
  issued_at: Date;
  operator_id: string;
  log_key_id: string;
  operator_public_key_sha256: string;
  signature_algorithm: string;
  log_mode: string | null;
  checkpoint_hash: string;
  previous_checkpoint_id: string | null;
  previous_checkpoint_hash: string | null;
  signature: string;
};

const mapCaptureRow = (row: CaptureRow): CaptureRecord => ({
  id: row.id,
  artifactType: (row.artifact_type as CaptureRecord["artifactType"]) ?? undefined,
  sourceLabel: row.source_label ?? undefined,
  fileName: row.file_name ?? undefined,
  mediaType: row.media_type ?? undefined,
  byteSize: row.byte_size ?? undefined,
  requestedUrl: row.requested_url,
  normalizedRequestedUrl: row.normalized_requested_url,
  finalUrl: row.final_url ?? undefined,
  fetchedAt: toIsoString(row.fetched_at),
  capturedAt: toIsoString(row.captured_at),
  claimedPublishedAt: row.claimed_published_at ?? undefined,
  httpStatus: row.http_status ?? undefined,
  headers: row.headers ?? undefined,
  contentType: row.content_type ?? undefined,
  charset: row.charset ?? undefined,
  rawSnapshotHash: row.raw_snapshot_hash ?? undefined,
  screenshotHash: row.screenshot_hash ?? undefined,
  canonicalContentHash: row.canonical_content_hash ?? undefined,
  metadataHash: row.metadata_hash ?? undefined,
  proofBundleHash: row.proof_bundle_hash ?? undefined,
  proofReceiptId: row.proof_receipt_id ?? undefined,
  extractorVersion: row.extractor_version,
  normalizationVersion: row.normalization_version ?? undefined,
  hashAlgorithm: row.hash_algorithm ?? undefined,
  canonicalContentSchemaVersion: row.canonical_content_schema_version ?? undefined,
  metadataSchemaVersion: row.metadata_schema_version ?? undefined,
  latestEventSequence: row.latest_event_sequence,
  latestCanonicalContentVersion: row.latest_canonical_content_version ?? undefined,
  latestMetadataVersion: row.latest_metadata_version ?? undefined,
  latestProofBundleVersion: row.latest_proof_bundle_version ?? undefined,
  latestReceiptVersion: row.latest_receipt_version ?? undefined,
  comparedToCaptureId: row.compared_to_capture_id ?? undefined,
  status: row.status,
  pageKind: row.page_kind ?? undefined,
  contentExtractionStatus: row.content_extraction_status ?? undefined,
  metadataChangedFromPrevious: row.metadata_changed_from_previous ?? undefined,
  contentChangedFromPrevious: row.content_changed_from_previous ?? undefined,
  titleChangedFromPrevious: row.title_changed_from_previous ?? undefined,
  authorChangedFromPrevious: row.author_changed_from_previous ?? undefined,
  claimedPublishedAtChangedFromPrevious: row.claimed_published_at_changed_from_previous ?? undefined,
  errorCode: row.error_code ?? undefined,
  errorMessage: row.error_message ?? undefined,
  actorAccountId: row.actor_account_id,
  approvalReceiptId: row.approval_receipt_id,
  approvalType: row.approval_type,
  approvalScope: (row.approval_scope as CaptureRecord["approvalScope"]) ?? undefined,
  approvalMethod: (row.approval_method as CaptureRecord["approvalMethod"]) ?? undefined,
  renderedEvidence: row.rendered_evidence ?? undefined,
  artifacts: row.artifacts ?? {},
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
  updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString()
});

const mapEventRow = (row: EventRow): CaptureLifecycleEvent => ({
  captureId: row.capture_id,
  sequence: row.sequence_no,
  eventType: row.event_type,
  status: row.status,
  eventData: row.event_data ?? {},
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString()
});

const mapArtifactRow = (row: ArtifactRow): ArtifactReference => ({
  captureId: row.capture_id,
  kind: row.kind,
  version: row.version,
  storageKey: row.storage_key,
  contentHash: row.content_hash,
  contentType: row.content_type ?? undefined,
  byteSize: row.byte_size ?? undefined,
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString()
});

const mapTransparencyLogEntryRow = (row: TransparencyLogEntryRow): TransparencyLogEntry => ({
  schemaVersion: row.schema_version,
  logIndex: row.log_index,
  captureId: row.capture_id,
  proofBundleHash: row.proof_bundle_hash,
  entryHash: row.entry_hash,
  previousEntryHash: row.previous_entry_hash ?? undefined,
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString()
});


const mapWatchlistRow = (row: WatchlistRow): Watchlist => ({
  id: row.id,
  requestedUrl: row.requested_url,
  normalizedRequestedUrl: row.normalized_requested_url,
  intervalMinutes: row.interval_minutes,
  intervalSeconds: row.interval_seconds ?? row.interval_minutes * 60,
  status: row.status,
  webhookUrl: row.webhook_url ?? undefined,
  emitJson: row.emit_json,
  expiresAt: toIsoString(row.expires_at),
  burstConfig: row.burst_config ?? undefined,
  lastRunAt: toIsoString(row.last_run_at),
  lastCheckedAt: toIsoString(row.last_checked_at),
  lastSuccessfulFetchAt: toIsoString(row.last_successful_fetch_at),
  lastStateChangeAt: toIsoString(row.last_state_change_at),
  lastHttpStatus: row.last_http_status ?? undefined,
  lastResolvedUrl: row.last_resolved_url ?? undefined,
  failureCount: row.failure_count ?? 0,
  lastErrorCode: row.last_error_code ?? undefined,
  nextRunAt: toIsoString(row.next_run_at) ?? new Date(0).toISOString(),
  latestRunId: row.latest_run_id ?? undefined,
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
  updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString()
});

const mapWatchlistRunRow = (row: WatchlistRunRow): WatchlistRun => ({
  id: row.id,
  watchlistId: row.watchlist_id,
  captureId: row.capture_id ?? undefined,
  previousCaptureId: row.previous_capture_id ?? undefined,
  newerCaptureId: row.newer_capture_id ?? undefined,
  normalizedRequestedUrl: row.normalized_requested_url,
  status: row.status,
  outcome: row.outcome ?? undefined,
  httpStatus: row.http_status ?? undefined,
  resolvedUrl: row.resolved_url ?? undefined,
  previousResolvedUrl: row.previous_resolved_url ?? undefined,
  stateChanged: row.state_changed ?? undefined,
  availabilityTransition: row.availability_transition ?? undefined,
  redirectChanged: row.redirect_changed ?? undefined,
  changeDetected: row.change_detected ?? undefined,
  changeSummary: row.change_summary ?? [],
  proofBundleHashes: row.proof_bundle_hashes ?? {},
  checkpointIds: row.checkpoint_ids ?? {},
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
  completedAt: toIsoString(row.completed_at),
  errorMessage: row.error_message ?? undefined
});

const mapWatchlistNotificationDeliveryRow = (row: WatchlistNotificationDeliveryRow): WatchlistNotificationDelivery => ({
  id: row.id,
  watchlistRunId: row.watchlist_run_id,
  kind: row.kind,
  status: row.status,
  target: row.target ?? undefined,
  payload: row.payload,
  responseStatus: row.response_status ?? undefined,
  errorMessage: row.error_message ?? undefined,
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString()
});

const mapTransparencyCheckpointRow = (row: TransparencyCheckpointRow): TransparencyCheckpoint => ({
  schemaVersion: row.schema_version,
  checkpointId: row.checkpoint_id,
  treeSize: row.tree_size,
  lastLogIndex: row.last_log_index,
  lastEntryHash: row.last_entry_hash,
  rootHash: row.root_hash,
  issuedAt: toIsoString(row.issued_at) ?? new Date(0).toISOString(),
  operatorId: row.operator_id,
  operatorKeyId: row.log_key_id,
  operatorPublicKeySha256: row.operator_public_key_sha256,
  signatureAlgorithm: row.signature_algorithm as "ed25519",
  logMode: (row.log_mode ?? "legacy-hash-chain") as "legacy-hash-chain" | "merkle-tree-v1",
  checkpointHash: row.checkpoint_hash,
  previousCheckpointId: row.previous_checkpoint_id ?? undefined,
  previousCheckpointHash: row.previous_checkpoint_hash ?? undefined,
  signature: row.signature
});

export class PostgresCaptureRepository implements CaptureRepository {
  constructor(private readonly pool: Pool) {}

  private async inTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async getCaptureRow(db: Pick<Pool, "query"> | PoolClient, id: string): Promise<CaptureRow> {
    const result = await db.query<CaptureRow>("SELECT * FROM captures WHERE id = $1", [id]);
    const row = result.rows[0];

    if (!row) {
      throw new Error(`Capture ${id} not found`);
    }

    return row;
  }

  private async nextArtifactVersion(client: PoolClient, captureId: string, kind: ArtifactReference["kind"]): Promise<number> {
    const result = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM artifact_references
       WHERE capture_id = $1 AND kind = $2`,
      [captureId, kind]
    );

    return Number(result.rows[0]?.next_version ?? 1);
  }

  private async insertEvent(
    client: PoolClient,
    input: {
      captureId: string;
      sequence: number;
      eventType: CaptureLifecycleEvent["eventType"];
      status: CaptureLifecycleEvent["status"];
      eventData?: Record<string, unknown>;
      createdAt: Date;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO capture_events (
        capture_id, sequence_no, event_type, status, event_data, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [input.captureId, input.sequence, input.eventType, input.status, asJson(input.eventData ?? {}), input.createdAt]
    );
  }

  private async insertArtifactReference(client: PoolClient, captureId: string, input: ArtifactReferenceInput, createdAt: Date): Promise<number> {
    const version = await this.nextArtifactVersion(client, captureId, input.kind);
    await client.query(
      `INSERT INTO artifact_references (
        capture_id, kind, version, storage_key, content_hash, content_type, byte_size, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [captureId, input.kind, version, input.storageKey, input.contentHash, input.contentType ?? null, input.byteSize ?? null, createdAt]
    );

    return version;
  }

  async createCapture(input: CreateCaptureInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const timestamp = new Date();
      const captureId = createId();

      await client.query(
        `INSERT INTO captures (
          id, artifact_type, source_label, requested_url, normalized_requested_url, extractor_version, latest_event_sequence,
          status, artifacts, actor_account_id, approval_receipt_id, approval_type, approval_scope, approval_method, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)`,
        [captureId, "url-capture", input.requestedUrl, input.requestedUrl, input.normalizedRequestedUrl, input.extractorVersion, 1, "queued", asJson({}), null, null, null, null, null, timestamp, timestamp]
      );

      await this.insertEvent(client, {
        captureId,
        sequence: 1,
        eventType: "queued",
        status: "queued",
        eventData: {
          artifactType: "url-capture",
          extractorVersion: input.extractorVersion,
          normalizedRequestedUrl: input.normalizedRequestedUrl,
          requestedUrl: input.requestedUrl
        },
        createdAt: timestamp
      });

      return mapCaptureRow(await this.getCaptureRow(client, captureId));
    });
  }


  async createArticleCapture(input: import("./captureRepository.js").CreateArticleCaptureInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const timestamp = new Date();
      const captureId = createId();
      const artifacts = {
        rawHtmlStorageKey: input.rawHtmlStorageKey,
        articleInputStorageKey: input.articleInputStorageKey
      };

      await client.query(
        `INSERT INTO captures (
          id, artifact_type, source_label, file_name, media_type, byte_size, requested_url, normalized_requested_url, extractor_version, raw_snapshot_hash, latest_event_sequence,
          status, artifacts, actor_account_id, approval_receipt_id, approval_type, approval_scope, approval_method, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20)`,
        [captureId, "article-publish", input.sourceLabel, input.fileName ?? null, input.mediaType, input.byteSize, input.requestedUrl, input.normalizedRequestedUrl, input.extractorVersion, input.rawSnapshotHash, 1, "queued", asJson(artifacts), null, null, null, null, null, timestamp, timestamp]
      );

      await this.insertArtifactReference(client, captureId, {
        kind: "raw-html",
        storageKey: input.rawHtmlStorageKey,
        contentHash: input.rawSnapshotHash,
        contentType: input.mediaType,
        byteSize: input.byteSize
      }, timestamp);

      await this.insertEvent(client, {
        captureId,
        sequence: 1,
        eventType: "queued",
        status: "queued",
        eventData: {
          artifactType: "article-publish",
          extractorVersion: input.extractorVersion,
          normalizedRequestedUrl: input.normalizedRequestedUrl,
          requestedUrl: input.requestedUrl,
          fileName: input.fileName ?? null,
          mediaType: input.mediaType,
          byteSize: input.byteSize,
          sourceLabel: input.sourceLabel
        },
        createdAt: timestamp
      });

      return mapCaptureRow(await this.getCaptureRow(client, captureId));
    });
  }
  async createImageCapture(input: import("./captureRepository.js").CreateImageCaptureInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const timestamp = new Date();
      const captureId = createId();
      const artifacts = {
        rawImageStorageKey: input.rawImageStorageKey,
        imageInputStorageKey: input.imageInputStorageKey
      };

      await client.query(
        `INSERT INTO captures (
          id, artifact_type, source_label, file_name, media_type, byte_size, requested_url, normalized_requested_url, extractor_version, raw_snapshot_hash, latest_event_sequence,
          status, artifacts, actor_account_id, approval_receipt_id, approval_type, approval_scope, approval_method, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20)`,
        [captureId, "image-file", input.sourceLabel, input.fileName, input.mediaType, input.byteSize, input.requestedUrl, input.normalizedRequestedUrl, input.extractorVersion, input.rawSnapshotHash, 1, "queued", asJson(artifacts), null, null, null, null, null, timestamp, timestamp]
      );

      await this.insertEvent(client, {
        captureId,
        sequence: 1,
        eventType: "queued",
        status: "queued",
        eventData: {
          artifactType: "image-file",
          extractorVersion: input.extractorVersion,
          normalizedRequestedUrl: input.normalizedRequestedUrl,
          requestedUrl: input.requestedUrl,
          fileName: input.fileName,
          mediaType: input.mediaType,
          byteSize: input.byteSize
        },
        createdAt: timestamp
      });

      return mapCaptureRow(await this.getCaptureRow(client, captureId));
    });
  }
  async createPdfCapture(input: CreatePdfCaptureInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const timestamp = new Date();
      const captureId = createId();
      const artifacts = { rawPdfStorageKey: input.rawPdfStorageKey };

      await client.query(
        `INSERT INTO captures (
          id, artifact_type, source_label, file_name, media_type, byte_size, requested_url, normalized_requested_url, extractor_version, raw_snapshot_hash, latest_event_sequence,
          status, artifacts, actor_account_id, approval_receipt_id, approval_type, approval_scope, approval_method, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20)`,
        [captureId, "pdf-file", input.sourceLabel, input.fileName, input.mediaType, input.byteSize, input.requestedUrl, input.normalizedRequestedUrl, input.extractorVersion, input.rawSnapshotHash, 1, "queued", asJson(artifacts), input.actorAccountId ?? null, null, input.approvalType ?? null, input.approvalScope ?? null, input.approvalMethod ?? null, timestamp, timestamp]
      );

      await this.insertArtifactReference(client, captureId, {
        kind: "raw-pdf",
        storageKey: input.rawPdfStorageKey,
        contentHash: input.rawSnapshotHash,
        contentType: input.mediaType,
        byteSize: input.byteSize
      }, timestamp);

      await this.insertEvent(client, {
        captureId,
        sequence: 1,
        eventType: "queued",
        status: "queued",
        eventData: {
          artifactType: "pdf-file",
          extractorVersion: input.extractorVersion,
          normalizedRequestedUrl: input.normalizedRequestedUrl,
          requestedUrl: input.requestedUrl,
          fileName: input.fileName,
          mediaType: input.mediaType,
          byteSize: input.byteSize,
          actorAccountId: input.actorAccountId ?? null,
          approvalType: input.approvalType ?? null,
          approvalScope: input.approvalScope ?? null,
          approvalMethod: input.approvalMethod ?? null
        },
        createdAt: timestamp
      });

      return mapCaptureRow(await this.getCaptureRow(client, captureId));
    });
  }

  async getCapture(id: string): Promise<CaptureRecord | undefined> {
    const result = await this.pool.query<CaptureRow>("SELECT * FROM captures WHERE id = $1", [id]);
    return result.rows[0] ? mapCaptureRow(result.rows[0]) : undefined;
  }

  async getCaptureByReceiptId(receiptId: string): Promise<CaptureRecord | undefined> {
    const result = await this.pool.query<CaptureRow>("SELECT * FROM captures WHERE proof_receipt_id = $1", [receiptId]);
    return result.rows[0] ? mapCaptureRow(result.rows[0]) : undefined;
  }

  async listCapturesForUrl(normalizedRequestedUrl: string): Promise<CaptureRecord[]> {
    const result = await this.pool.query<CaptureRow>(
      "SELECT * FROM captures WHERE normalized_requested_url = $1 ORDER BY created_at DESC",
      [normalizedRequestedUrl]
    );
    return result.rows.map(mapCaptureRow);
  }

  async claimNextQueuedCapture(workerId: string): Promise<CaptureRecord | undefined> {
    return this.inTransaction(async (client) => {
      const candidateResult = await client.query<CaptureRow>(
        "SELECT * FROM captures WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
      );
      const candidate = candidateResult.rows[0];

      if (!candidate) {
        return undefined;
      }

      const timestamp = new Date();
      const nextSequence = candidate.latest_event_sequence + 1;
      await this.insertEvent(client, {
        captureId: candidate.id,
        sequence: nextSequence,
        eventType: "fetch_started",
        status: "fetching",
        eventData: { workerId },
        createdAt: timestamp
      });

      await client.query(
        `UPDATE captures SET
          status = $2,
          latest_event_sequence = $3,
          error_code = NULL,
          error_message = NULL,
          updated_at = $4
        WHERE id = $1`,
        [candidate.id, "fetching", nextSequence, timestamp]
      );

      return mapCaptureRow(await this.getCaptureRow(client, candidate.id));
    });
  }

  async recordFetchCompleted(input: FetchCompletedInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const current = await this.getCaptureRow(client, input.captureId);
      const timestamp = new Date(input.fetchedAt);
      const nextSequence = current.latest_event_sequence + 1;
      const artifacts = appendArtifactKey(current.artifacts ?? {}, input.rawSourceArtifact.kind, input.rawSourceArtifact.storageKey);

      if (input.rawSourceArtifact.kind !== "raw-pdf") {
        await this.insertArtifactReference(client, input.captureId, input.rawSourceArtifact, timestamp);
      }
      await this.insertEvent(client, {
        captureId: input.captureId,
        sequence: nextSequence,
        eventType: "fetch_completed",
        status: "extracting",
        eventData: {
          fetchedAt: input.fetchedAt,
          finalUrl: input.finalUrl,
          httpStatus: input.httpStatus,
          contentType: input.contentType ?? null,
          charset: input.charset ?? null,
          rawSnapshotHash: input.rawSnapshotHash
        },
        createdAt: timestamp
      });

      await client.query(
        `UPDATE captures SET
          final_url = $2,
          fetched_at = $3,
          http_status = $4,
          headers = $5::jsonb,
          content_type = $6,
          charset = $7,
          raw_snapshot_hash = $8,
          latest_event_sequence = $9,
          status = $10,
          artifacts = $11::jsonb,
          error_code = NULL,
          error_message = NULL,
          updated_at = $12
        WHERE id = $1`,
        [
          input.captureId,
          input.finalUrl,
          timestamp,
          input.httpStatus,
          asJson(input.headers),
          input.contentType ?? null,
          input.charset ?? null,
          input.rawSnapshotHash,
          nextSequence,
          "extracting",
          asJson(artifacts),
          timestamp
        ]
      );

      return mapCaptureRow(await this.getCaptureRow(client, input.captureId));
    });
  }

  async recordDerivationCompleted(input: DerivationCompletedInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const current = await this.getCaptureRow(client, input.captureId);
      const timestamp = new Date();
      const canonicalVersion = (current.latest_canonical_content_version ?? 0) + 1;
      const metadataVersion = (current.latest_metadata_version ?? 0) + 1;
      const extractionSequence = current.latest_event_sequence + 1;
      const hashingSequence = extractionSequence + 1;
      const artifactsWithCanonical = appendArtifactKey(current.artifacts ?? {}, input.canonicalContentArtifact.kind, input.canonicalContentArtifact.storageKey);
      const artifactsWithMetadata = appendArtifactKey(artifactsWithCanonical, input.metadataArtifact.kind, input.metadataArtifact.storageKey);
      const artifacts = input.screenshotArtifact
        ? appendArtifactKey(artifactsWithMetadata, input.screenshotArtifact.kind, input.screenshotArtifact.storageKey)
        : artifactsWithMetadata;

      await client.query(
        `INSERT INTO canonical_content_versions (
          capture_id, version, schema_version, normalization_version, extractor_version,
          page_kind, content_hash, storage_key, title, subtitle, author, published_at_claimed,
          stats, diagnostics, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)`,
        [
          input.captureId,
          canonicalVersion,
          input.canonicalContent.schemaVersion,
          input.canonicalContent.normalizationVersion,
          input.canonicalContent.extractorVersion,
          input.pageKind,
          input.canonicalContentHash,
          input.canonicalContentArtifact.storageKey,
          input.canonicalContent.title ?? null,
          input.canonicalContent.subtitle ?? null,
          input.canonicalContent.author ?? null,
          input.canonicalContent.publishedAtClaimed ?? null,
          asJson(input.canonicalContent.stats),
          asJson(input.canonicalContent.diagnostics),
          timestamp
        ]
      );

      await client.query(
        `INSERT INTO metadata_versions (
          capture_id, version, schema_version, normalization_version, extractor_version,
          metadata_hash, canonical_url, title, subtitle, author, published_at_claimed,
          language, field_provenance, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
        [
          input.captureId,
          metadataVersion,
          input.metadata.schemaVersion,
          input.metadata.normalizationVersion,
          input.metadata.extractorVersion,
          input.metadataHash,
          input.metadata.canonicalUrl ?? null,
          input.metadata.title ?? null,
          input.metadata.subtitle ?? null,
          input.metadata.author ?? null,
          input.metadata.publishedAtClaimed ?? null,
          input.metadata.language ?? null,
          asJson(input.metadata.fieldProvenance),
          timestamp
        ]
      );

      await this.insertArtifactReference(client, input.captureId, input.canonicalContentArtifact, timestamp);
      await this.insertArtifactReference(client, input.captureId, input.metadataArtifact, timestamp);
      if (input.screenshotArtifact) {
        await this.insertArtifactReference(client, input.captureId, input.screenshotArtifact, timestamp);
      }
      await this.insertEvent(client, {
        captureId: input.captureId,
        sequence: extractionSequence,
        eventType: "extraction_completed",
        status: "hashing",
        eventData: {
          extractionStatus: input.extractionStatus,
          pageKind: input.pageKind,
          canonicalContentVersion: canonicalVersion,
          metadataVersion,
          claimedPublishedAt: input.claimedPublishedAt ?? null,
          canonicalContentSchemaVersion: input.canonicalContent.schemaVersion,
          metadataSchemaVersion: input.metadata.schemaVersion,
          normalizationVersion: input.canonicalContent.normalizationVersion,
          screenshotHash: input.renderedEvidence?.screenshot?.hash ?? input.renderedEvidence?.screenshotHash ?? null,
          viewport: input.renderedEvidence?.viewport ?? null,
          devicePreset: input.renderedEvidence?.device?.devicePreset ?? null,
          userAgent: input.renderedEvidence?.device?.userAgent ?? null,
          userAgentLabel: input.renderedEvidence?.device?.userAgentLabel ?? input.renderedEvidence?.userAgentLabel ?? null,
          screenshotFormat: input.renderedEvidence?.screenshot?.format ?? null
        },
        createdAt: timestamp
      });
      await this.insertEvent(client, {
        captureId: input.captureId,
        sequence: hashingSequence,
        eventType: "hashing_completed",
        status: "timestamping",
        eventData: {
          canonicalContentHash: input.canonicalContentHash,
          metadataHash: input.metadataHash
        },
        createdAt: timestamp
      });

      await client.query(
        `UPDATE captures SET
          claimed_published_at = $2,
          canonical_content_hash = $3,
          metadata_hash = $4,
          normalization_version = $5,
          screenshot_hash = $6,
          rendered_evidence = $7::jsonb,
          canonical_content_schema_version = $8,
          metadata_schema_version = $9,
          latest_canonical_content_version = $10,
          latest_metadata_version = $11,
          latest_event_sequence = $12,
          page_kind = $13,
          content_extraction_status = $14,
          status = $15,
          artifacts = $16::jsonb,
          error_code = NULL,
          error_message = NULL,
          updated_at = $17
        WHERE id = $1`,
        [
          input.captureId,
          input.claimedPublishedAt ?? null,
          input.canonicalContentHash,
          input.metadataHash,
          input.canonicalContent.normalizationVersion,
          input.renderedEvidence?.screenshot?.hash ?? input.renderedEvidence?.screenshotHash ?? null,
          asJson(input.renderedEvidence ?? null),
          input.canonicalContent.schemaVersion,
          input.metadata.schemaVersion,
          canonicalVersion,
          metadataVersion,
          hashingSequence,
          input.pageKind,
          input.extractionStatus,
          "timestamping",
          asJson(artifacts),
          timestamp
        ]
      );

      return mapCaptureRow(await this.getCaptureRow(client, input.captureId));
    });
  }

  async recordTimestampCompleted(input: TimestampCompletedInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const current = await this.getCaptureRow(client, input.captureId);
      const timestamp = new Date(input.capturedAt);
      const proofVersion = (current.latest_proof_bundle_version ?? 0) + 1;
      const receiptVersion = (current.latest_receipt_version ?? 0) + 1;
      const nextSequence = current.latest_event_sequence + 1;
      const artifacts = appendArtifactKey(current.artifacts ?? {}, input.proofBundleArtifact.kind, input.proofBundleArtifact.storageKey);

      await client.query(
        `INSERT INTO proof_bundle_versions (
          capture_id, version, schema_version, normalization_version, extractor_version,
          hash_algorithm, raw_snapshot_schema_version, canonical_content_schema_version,
          metadata_schema_version, capture_scope, proof_bundle_hash, receipt_id, bundle, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14)`,
        [
          input.captureId,
          proofVersion,
          input.proofBundle.schemaVersion,
          input.proofBundle.normalizationVersion,
          input.proofBundle.extractorVersion,
          input.proofBundle.hashAlgorithm,
          input.proofBundle.rawSnapshotSchemaVersion,
          input.proofBundle.canonicalContentSchemaVersion,
          input.proofBundle.metadataSchemaVersion,
          asJson(input.proofBundle.captureScope),
          input.proofBundleHash,
          input.receipt.id,
          asJson(input.proofBundle),
          timestamp
        ]
      );

      await client.query(
        `INSERT INTO receipt_events (
          capture_id, version, receipt_id, event_type, proof_bundle_hash, receipt, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [input.captureId, receiptVersion, input.receipt.id, "issued", input.proofBundleHash, asJson(input.receipt), timestamp]
      );

      await this.insertArtifactReference(client, input.captureId, input.proofBundleArtifact, timestamp);
      await this.insertEvent(client, {
        captureId: input.captureId,
        sequence: nextSequence,
        eventType: "timestamping_completed",
        status: "completed",
        eventData: {
          proofBundleHash: input.proofBundleHash,
          proofBundleVersion: proofVersion,
          receiptId: input.receipt.id,
          receiptVersion,
          comparedToCaptureId: input.comparedToCaptureId ?? null,
          contentChangedFromPrevious: input.contentChangedFromPrevious ?? null,
          metadataChangedFromPrevious: input.metadataChangedFromPrevious ?? null,
          titleChangedFromPrevious: input.titleChangedFromPrevious ?? null,
          authorChangedFromPrevious: input.authorChangedFromPrevious ?? null,
          claimedPublishedAtChangedFromPrevious: input.claimedPublishedAtChangedFromPrevious ?? null
        },
        createdAt: timestamp
      });

      await client.query(
        `UPDATE captures SET
          captured_at = $2,
          proof_bundle_hash = $3,
          proof_receipt_id = $4,
          hash_algorithm = $5,
          latest_proof_bundle_version = $6,
          latest_receipt_version = $7,
          latest_event_sequence = $8,
          compared_to_capture_id = $9,
          content_changed_from_previous = $10,
          metadata_changed_from_previous = $11,
          title_changed_from_previous = $12,
          author_changed_from_previous = $13,
          claimed_published_at_changed_from_previous = $14,
          status = $15,
          artifacts = $16::jsonb,
          error_code = NULL,
          error_message = NULL,
          updated_at = $17
        WHERE id = $1`,
        [
          input.captureId,
          timestamp,
          input.proofBundleHash,
          input.receipt.id,
          input.proofBundle.hashAlgorithm,
          proofVersion,
          receiptVersion,
          nextSequence,
          input.comparedToCaptureId ?? null,
          input.contentChangedFromPrevious ?? null,
          input.metadataChangedFromPrevious ?? null,
          input.titleChangedFromPrevious ?? null,
          input.authorChangedFromPrevious ?? null,
          input.claimedPublishedAtChangedFromPrevious ?? null,
          "completed",
          asJson(artifacts),
          timestamp
        ]
      );

      return mapCaptureRow(await this.getCaptureRow(client, input.captureId));
    });
  }

  async recordFailure(input: FailureInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const current = await this.getCaptureRow(client, input.captureId);
      const timestamp = new Date();
      const nextSequence = current.latest_event_sequence + 1;

      await this.insertEvent(client, {
        captureId: input.captureId,
        sequence: nextSequence,
        eventType: "failed",
        status: "failed",
        eventData: {
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          stageStatus: input.stageStatus
        },
        createdAt: timestamp
      });

      await client.query(
        `UPDATE captures SET
          status = $2,
          latest_event_sequence = $3,
          error_code = $4,
          error_message = $5,
          updated_at = $6
        WHERE id = $1`,
        [input.captureId, "failed", nextSequence, input.errorCode, input.errorMessage, timestamp]
      );

      return mapCaptureRow(await this.getCaptureRow(client, input.captureId));
    });
  }

  async recordAttestationBundle(input: import("./captureRepository.js").AttestationBundleInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const current = await this.getCaptureRow(client, input.captureId);
      const timestamp = new Date();
      const nextSequence = current.latest_event_sequence + 1;
      const artifacts = appendArtifactKey(current.artifacts ?? {}, input.artifact.kind, input.artifact.storageKey);

      await this.insertArtifactReference(client, input.captureId, input.artifact, timestamp);
      await this.insertEvent(client, {
        captureId: input.captureId,
        sequence: nextSequence,
        eventType: "approval_completed",
        status: "completed",
        eventData: {
          attestationCount: input.attestationBundle.attestations.length,
          attestationTypes: input.attestationBundle.attestations.map((attestation) => attestation.type)
        },
        createdAt: timestamp
      });

      await client.query(
        `UPDATE captures SET
          latest_event_sequence = $2,
          artifacts = $3::jsonb,
          updated_at = $4
        WHERE id = $1`,
        [input.captureId, nextSequence, asJson(artifacts), timestamp]
      );

      return mapCaptureRow(await this.getCaptureRow(client, input.captureId));
    });
  }
  async recordApprovalReceipt(input: import("./captureRepository.js").ApprovalReceiptInput): Promise<CaptureRecord> {
    return this.inTransaction(async (client) => {
      const current = await this.getCaptureRow(client, input.captureId);
      const timestamp = new Date(input.approvalReceipt.approvedAt);
      const receiptVersionResult = await client.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM approval_receipt_events WHERE capture_id = $1`,
        [input.captureId]
      );
      const receiptVersion = Number(receiptVersionResult.rows[0]?.next_version ?? 1);
      const nextSequence = current.latest_event_sequence + 1;
      const artifacts = appendArtifactKey(current.artifacts ?? {}, input.artifact.kind, input.artifact.storageKey);

      await client.query(
        `INSERT INTO approval_receipt_events (
          capture_id, version, receipt_id, actor_account_id, approval_type, raw_pdf_hash, receipt, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          input.captureId,
          receiptVersion,
          input.approvalReceipt.id,
          input.actorAccountId,
          input.approvalType,
          input.approvalReceipt.rawPdfHash,
          asJson(input.approvalReceipt),
          timestamp
        ]
      );

      await this.insertArtifactReference(client, input.captureId, input.artifact, timestamp);
      await this.insertEvent(client, {
        captureId: input.captureId,
        sequence: nextSequence,
        eventType: "approval_completed",
        status: "completed",
        eventData: {
          approvalReceiptId: input.approvalReceipt.id,
          actorAccountId: input.actorAccountId,
          approvalType: input.approvalType,
          approvalScope: input.approvalScope,
          approvalMethod: input.approvalMethod,
          rawPdfHash: input.approvalReceipt.rawPdfHash
        },
        createdAt: timestamp
      });

      await client.query(
        `UPDATE captures SET
          approval_receipt_id = $2,
          actor_account_id = $3,
          approval_type = $4,
          approval_scope = $5,
          approval_method = $6,
          latest_event_sequence = $7,
          artifacts = $8::jsonb,
          updated_at = $9
        WHERE id = $1`,
        [input.captureId, input.approvalReceipt.id, input.actorAccountId, input.approvalType, input.approvalScope, input.approvalMethod, nextSequence, asJson(artifacts), timestamp]
      );

      return mapCaptureRow(await this.getCaptureRow(client, input.captureId));
    });
  }

  async getApprovalReceipt(id: string): Promise<PdfApprovalReceipt | undefined> {
    const result = await this.pool.query<ApprovalReceiptRow>(
      `SELECT receipt
       FROM approval_receipt_events
       WHERE receipt_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [id]
    );

    return result.rows[0]?.receipt;
  }

  async getReceipt(id: string): Promise<TransparencyReceipt | undefined> {
    const result = await this.pool.query<QueryResultRow & { receipt: TransparencyReceipt }>(
      `SELECT receipt
       FROM receipt_events
       WHERE receipt_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [id]
    );

    return result.rows[0]?.receipt;
  }

  async listCaptureEvents(captureId: string): Promise<CaptureLifecycleEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT capture_id, sequence_no, event_type, status, event_data, created_at
       FROM capture_events
       WHERE capture_id = $1
       ORDER BY sequence_no ASC`,
      [captureId]
    );

    return result.rows.map(mapEventRow);
  }

  async listArtifactReferences(captureId: string): Promise<ArtifactReference[]> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT capture_id, kind, version, storage_key, content_hash, content_type, byte_size, created_at
       FROM artifact_references
       WHERE capture_id = $1
       ORDER BY created_at ASC, id ASC`,
      [captureId]
    );

    return result.rows.map(mapArtifactRow);
  }

  async appendTransparencyLogEntry(input: { captureId: string; proofBundleHash: string }): Promise<TransparencyLogEntry> {
    return this.inTransaction(async (client) => {
      const existingResult = await client.query<TransparencyLogEntryRow>(
        `SELECT schema_version, log_index, capture_id, proof_bundle_hash, entry_hash, previous_entry_hash, created_at
         FROM transparency_log_entries
         WHERE capture_id = $1`,
        [input.captureId]
      );
      const existing = existingResult.rows[0];
      if (existing) {
        return mapTransparencyLogEntryRow(existing);
      }

      const latestResult = await client.query<TransparencyLogEntryRow>(
        `SELECT schema_version, log_index, capture_id, proof_bundle_hash, entry_hash, previous_entry_hash, created_at
         FROM transparency_log_entries
         ORDER BY log_index DESC
         LIMIT 1`
      );
      const latest = latestResult.rows[0];
      const logIndex = (latest?.log_index ?? 0) + 1;
      const createdAt = new Date();
      const previousEntryHash = latest?.entry_hash ?? undefined;
      const entryHash = hashStableValue({
        schemaVersion: 1,
        logIndex,
        captureId: input.captureId,
        proofBundleHash: input.proofBundleHash,
        previousEntryHash: previousEntryHash ?? null,
        createdAt: createdAt.toISOString()
      });

      const inserted = await client.query<TransparencyLogEntryRow>(
        `INSERT INTO transparency_log_entries (
          schema_version, log_index, capture_id, proof_bundle_hash, entry_hash, previous_entry_hash, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING schema_version, log_index, capture_id, proof_bundle_hash, entry_hash, previous_entry_hash, created_at`,
        [1, logIndex, input.captureId, input.proofBundleHash, entryHash, previousEntryHash ?? null, createdAt]
      );

      const insertedRow = inserted.rows[0];
      if (!insertedRow) {
        throw new Error(`Failed to insert transparency log entry for capture ${input.captureId}`);
      }

      return mapTransparencyLogEntryRow(insertedRow);
    });
  }

  async getTransparencyLogEntry(captureId: string): Promise<TransparencyLogEntry | undefined> {
    const result = await this.pool.query<TransparencyLogEntryRow>(
      `SELECT schema_version, log_index, capture_id, proof_bundle_hash, entry_hash, previous_entry_hash, created_at
       FROM transparency_log_entries
       WHERE capture_id = $1`,
      [captureId]
    );
    return result.rows[0] ? mapTransparencyLogEntryRow(result.rows[0]) : undefined;
  }

  async getLatestTransparencyLogEntry(): Promise<TransparencyLogEntry | undefined> {
    const result = await this.pool.query<TransparencyLogEntryRow>(
      `SELECT schema_version, log_index, capture_id, proof_bundle_hash, entry_hash, previous_entry_hash, created_at
       FROM transparency_log_entries
       ORDER BY log_index DESC
       LIMIT 1`
    );
    return result.rows[0] ? mapTransparencyLogEntryRow(result.rows[0]) : undefined;
  }

  async listTransparencyLogEntries(options?: { uptoLogIndex?: number }): Promise<TransparencyLogEntry[]> {
    const clauses = options?.uptoLogIndex ? "WHERE log_index <= $1" : "";
    const params = options?.uptoLogIndex ? [options.uptoLogIndex] : [];
    const result = await this.pool.query<TransparencyLogEntryRow>(
      `SELECT schema_version, log_index, capture_id, proof_bundle_hash, entry_hash, previous_entry_hash, created_at
       FROM transparency_log_entries ${clauses}
       ORDER BY log_index ASC`,
      params
    );
    return result.rows.map(mapTransparencyLogEntryRow);
  }

  async saveTransparencyCheckpoint(checkpoint: TransparencyCheckpoint): Promise<TransparencyCheckpoint> {
    const result = await this.pool.query<TransparencyCheckpointRow>(
      `INSERT INTO transparency_log_checkpoints (
        schema_version, checkpoint_id, tree_size, last_log_index, last_entry_hash, root_hash, issued_at, operator_id, log_key_id, operator_public_key_sha256, signature_algorithm, log_mode, checkpoint_hash, previous_checkpoint_id, previous_checkpoint_hash, signature
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (checkpoint_id) DO UPDATE SET
        tree_size = EXCLUDED.tree_size,
        last_log_index = EXCLUDED.last_log_index,
        last_entry_hash = EXCLUDED.last_entry_hash,
        root_hash = EXCLUDED.root_hash,
        issued_at = EXCLUDED.issued_at,
        operator_id = EXCLUDED.operator_id,
        log_key_id = EXCLUDED.log_key_id,
        operator_public_key_sha256 = EXCLUDED.operator_public_key_sha256,
        signature_algorithm = EXCLUDED.signature_algorithm,
        log_mode = EXCLUDED.log_mode,
        checkpoint_hash = EXCLUDED.checkpoint_hash,
        previous_checkpoint_id = EXCLUDED.previous_checkpoint_id,
        previous_checkpoint_hash = EXCLUDED.previous_checkpoint_hash,
        signature = EXCLUDED.signature
      RETURNING schema_version, checkpoint_id, tree_size, last_log_index, last_entry_hash, root_hash, issued_at, operator_id, log_key_id, operator_public_key_sha256, signature_algorithm, log_mode, checkpoint_hash, previous_checkpoint_id, previous_checkpoint_hash, signature`,
      [
        checkpoint.schemaVersion,
        checkpoint.checkpointId,
        checkpoint.treeSize,
        checkpoint.lastLogIndex,
        checkpoint.lastEntryHash,
        checkpoint.rootHash,
        new Date(checkpoint.issuedAt),
        checkpoint.operatorId,
        checkpoint.operatorKeyId,
        checkpoint.operatorPublicKeySha256,
        checkpoint.signatureAlgorithm,
        checkpoint.logMode ?? "legacy-hash-chain",
        checkpoint.checkpointHash,
        checkpoint.previousCheckpointId ?? null,
        checkpoint.previousCheckpointHash ?? null,
        checkpoint.signature
      ]
    );

    const checkpointRow = result.rows[0];
    if (!checkpointRow) {
      throw new Error(`Failed to persist transparency checkpoint ${checkpoint.checkpointId}`);
    }

    return mapTransparencyCheckpointRow(checkpointRow);
  }

  async getTransparencyCheckpoint(checkpointId: string): Promise<TransparencyCheckpoint | undefined> {
    const result = await this.pool.query<TransparencyCheckpointRow>(
      `SELECT schema_version, checkpoint_id, tree_size, last_log_index, last_entry_hash, root_hash, issued_at, operator_id, log_key_id, operator_public_key_sha256, signature_algorithm, log_mode, checkpoint_hash, previous_checkpoint_id, previous_checkpoint_hash, signature
       FROM transparency_log_checkpoints
       WHERE checkpoint_id = $1`,
      [checkpointId]
    );
    return result.rows[0] ? mapTransparencyCheckpointRow(result.rows[0]) : undefined;
  }

  async getLatestTransparencyCheckpoint(): Promise<TransparencyCheckpoint | undefined> {
    const result = await this.pool.query<TransparencyCheckpointRow>(
      `SELECT schema_version, checkpoint_id, tree_size, last_log_index, last_entry_hash, root_hash, issued_at, operator_id, log_key_id, operator_public_key_sha256, signature_algorithm, log_mode, checkpoint_hash, previous_checkpoint_id, previous_checkpoint_hash, signature
       FROM transparency_log_checkpoints
       ORDER BY issued_at DESC
       LIMIT 1`
    );
    return result.rows[0] ? mapTransparencyCheckpointRow(result.rows[0]) : undefined;
  }


  async createWatchlist(input: CreateWatchlistRequest): Promise<Watchlist> {
    const now = new Date();
    const intervalSeconds = deriveWatchIntervalSeconds(input.intervalSeconds, input.intervalMinutes);
    const intervalMinutes = deriveWatchIntervalMinutes(intervalSeconds);
    const burstConfig = normalizeBurstConfig(input.burstConfig, now);
    const nextRunAt = new Date(now.getTime() + getEffectiveWatchIntervalSeconds({ intervalSeconds, burstConfig, createdAt: now.toISOString() }, now) * 1000);
    const id = createId();
    const result = await this.pool.query<WatchlistRow>(
            `INSERT INTO watchlists (
        id, requested_url, normalized_requested_url, interval_minutes, interval_seconds, status, webhook_url, emit_json, expires_at, burst_config, next_run_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
      RETURNING ${WATCHLIST_SELECT_COLUMNS}`,
      [
        id,
        input.url,
        input.url,
        intervalMinutes,
        intervalSeconds,
        "active",
        input.webhookUrl ?? null,
        input.emitJson ?? false,
        input.expiresAt ? new Date(input.expiresAt) : null,
        burstConfig ? asJson(burstConfig) : null,
        nextRunAt,
        now,
        now
      ]
    );
    const row = result.rows[0];
    if (!row) { throw new Error("Failed to create watchlist"); }
    return mapWatchlistRow(row);
  }

  async listWatchlists(): Promise<Watchlist[]> {
    const result = await this.pool.query<WatchlistRow>(
      `SELECT ${WATCHLIST_SELECT_COLUMNS}
       FROM watchlists
       ORDER BY created_at DESC`
    );
    return result.rows.map(mapWatchlistRow);
  }

  async getWatchlist(id: string): Promise<Watchlist | undefined> {
    const result = await this.pool.query<WatchlistRow>(
      `SELECT ${WATCHLIST_SELECT_COLUMNS}
       FROM watchlists WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapWatchlistRow(result.rows[0]) : undefined;
  }

  async updateWatchlist(id: string, input: UpdateWatchlistRequest): Promise<Watchlist | undefined> {
    const current = await this.getWatchlist(id);
    if (!current) {
      return undefined;
    }
    const now = new Date();
    const intervalSeconds = deriveWatchIntervalSeconds(input.intervalSeconds ?? current.intervalSeconds, input.intervalMinutes ?? current.intervalMinutes);
    const intervalMinutes = deriveWatchIntervalMinutes(intervalSeconds);
    let status = input.status ?? current.status;
    const webhookUrl = input.webhookUrl === null ? null : (input.webhookUrl ?? current.webhookUrl ?? null);
    const emitJson = input.emitJson ?? current.emitJson;
    const expiresAtValue = input.expiresAt === null ? null : (input.expiresAt ?? current.expiresAt ?? null);
    const burstConfigInput = input.burstConfig === null ? null : normalizeBurstConfig(input.burstConfig ?? current.burstConfig, current.createdAt);
    if (status === "active" && expiresAtValue && new Date(expiresAtValue).getTime() <= now.getTime()) {
      status = "expired";
    }
    const nextRunAt = status === "active"
      ? new Date(now.getTime() + getEffectiveWatchIntervalSeconds({ intervalSeconds, burstConfig: burstConfigInput ?? undefined, createdAt: current.createdAt }, now) * 1000)
      : new Date(current.nextRunAt);

    const result = await this.pool.query<WatchlistRow>(
      `UPDATE watchlists SET interval_minutes = $2, interval_seconds = $3, status = $4, webhook_url = $5, emit_json = $6, expires_at = $7, burst_config = $8::jsonb, next_run_at = $9, updated_at = $10
       WHERE id = $1
       RETURNING ${WATCHLIST_SELECT_COLUMNS}`,
      [id, intervalMinutes, intervalSeconds, status, webhookUrl, emitJson, expiresAtValue ? new Date(expiresAtValue) : null, burstConfigInput ? asJson(burstConfigInput) : null, nextRunAt, now]
    );
    return result.rows[0] ? mapWatchlistRow(result.rows[0]) : undefined;
  }

  async claimNextDueWatchlist(_workerId: string, now: string): Promise<Watchlist | undefined> {
    return this.inTransaction(async (client) => {
      const nowDate = new Date(now);
      await client.query(
        `UPDATE watchlists
         SET status = 'expired', updated_at = $1
         WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1`,
        [nowDate]
      );
      const result = await client.query<WatchlistRow>(
        `SELECT ${WATCHLIST_SELECT_COLUMNS}
         FROM watchlists
         WHERE status = 'active' AND next_run_at <= $1 AND (expires_at IS NULL OR expires_at > $1)
         ORDER BY next_run_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [nowDate]
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }
      const watchlist = mapWatchlistRow(row);
      const nextRunAt = new Date(nowDate.getTime() + getEffectiveWatchIntervalSeconds(watchlist, nowDate) * 1000);
      const updated = await client.query<WatchlistRow>(
        `UPDATE watchlists SET next_run_at = $2, updated_at = $3
         WHERE id = $1
         RETURNING ${WATCHLIST_SELECT_COLUMNS}`,
        [row.id, nextRunAt, nowDate]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new Error(`Failed to claim due watchlist ${row.id}`);
      }
      return mapWatchlistRow(updatedRow);
    });
  }

  async createWatchlistRun(input: { watchlistId: string; normalizedRequestedUrl: string }): Promise<WatchlistRun> {
    const now = new Date();
    const id = createId();
    const result = await this.pool.query<WatchlistRunRow>(
      `INSERT INTO watchlist_runs (
        id, watchlist_id, normalized_requested_url, status, outcome, change_summary, proof_bundle_hashes, checkpoint_ids, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
      RETURNING ${WATCHLIST_RUN_SELECT_COLUMNS}`,
      [id, input.watchlistId, input.normalizedRequestedUrl, "started", null, asJson([]), asJson({}), asJson({}), now]
    );
    const row = result.rows[0];
    if (!row) { throw new Error("Failed to create watchlist run"); }
    return mapWatchlistRunRow(row);
  }

  async completeWatchlistRun(input: CompleteWatchlistRunInput): Promise<WatchlistRun> {
    return this.inTransaction(async (client) => {
      const completedAt = new Date(input.completedAt);
      const updated = await client.query<WatchlistRunRow>(
        `UPDATE watchlist_runs SET capture_id = $2, previous_capture_id = $3, newer_capture_id = $4, status = $5, outcome = $6, http_status = $7, resolved_url = $8, previous_resolved_url = $9, state_changed = $10, availability_transition = $11, redirect_changed = $12, change_detected = $13, change_summary = $14::jsonb, proof_bundle_hashes = $15::jsonb, checkpoint_ids = $16::jsonb, completed_at = $17
         WHERE id = $1
         RETURNING ${WATCHLIST_RUN_SELECT_COLUMNS}`,
        [input.watchlistRunId, input.captureId ?? input.newerCaptureId ?? null, input.previousCaptureId ?? null, input.newerCaptureId ?? null, "completed", input.outcome ?? null, input.httpStatus ?? null, input.resolvedUrl ?? null, input.previousResolvedUrl ?? null, input.stateChanged ?? null, input.availabilityTransition ?? null, input.redirectChanged ?? null, input.changeDetected, asJson(input.changeSummary), asJson(input.proofBundleHashes), asJson(input.checkpointIds), completedAt]
      );
      const run = updated.rows[0];
      if (!run) { throw new Error(`Failed to complete watchlist run ${input.watchlistRunId}`); }
      await client.query(
        `UPDATE watchlists SET last_run_at = $2, last_checked_at = COALESCE($3, last_checked_at), last_successful_fetch_at = COALESCE($4, last_successful_fetch_at), last_state_change_at = COALESCE($5, last_state_change_at), last_http_status = COALESCE($6, last_http_status), last_resolved_url = COALESCE($7, last_resolved_url), failure_count = COALESCE($8, failure_count), last_error_code = $9, latest_run_id = $10, status = COALESCE($11, status), updated_at = $2 WHERE id = $1`,
        [run.watchlist_id, completedAt, input.lastCheckedAt ? new Date(input.lastCheckedAt) : completedAt, input.lastSuccessfulFetchAt ? new Date(input.lastSuccessfulFetchAt) : null, input.lastStateChangeAt ? new Date(input.lastStateChangeAt) : null, input.lastHttpStatus ?? null, input.lastResolvedUrl ?? null, input.failureCount ?? null, input.lastErrorCode ?? null, input.watchlistRunId, input.watchStatus ?? null]
      );
      return mapWatchlistRunRow(run);
    });
  }

  async failWatchlistRun(input: FailWatchlistRunInput): Promise<WatchlistRun> {
    return this.inTransaction(async (client) => {
      const completedAt = new Date(input.completedAt ?? new Date().toISOString());
      const updated = await client.query<WatchlistRunRow>(
        `UPDATE watchlist_runs SET status = $2, outcome = $3, http_status = $4, resolved_url = $5, previous_resolved_url = $6, state_changed = $7, availability_transition = $8, redirect_changed = $9, error_message = $10, completed_at = $11 WHERE id = $1
         RETURNING ${WATCHLIST_RUN_SELECT_COLUMNS}`,
        [input.watchlistRunId, "failed", input.outcome ?? null, input.httpStatus ?? null, input.resolvedUrl ?? null, input.previousResolvedUrl ?? null, input.stateChanged ?? null, input.availabilityTransition ?? null, input.redirectChanged ?? null, input.errorMessage, completedAt]
      );
      const run = updated.rows[0];
      if (!run) { throw new Error(`Failed to fail watchlist run ${input.watchlistRunId}`); }
      await client.query(
        `UPDATE watchlists SET last_run_at = $2, last_checked_at = COALESCE($3, last_checked_at), last_state_change_at = COALESCE($4, last_state_change_at), last_http_status = COALESCE($5, last_http_status), last_resolved_url = COALESCE($6, last_resolved_url), failure_count = COALESCE($7, failure_count), last_error_code = COALESCE($8, last_error_code), latest_run_id = $9, status = COALESCE($10, status), updated_at = $2 WHERE id = $1`,
        [run.watchlist_id, completedAt, input.lastCheckedAt ? new Date(input.lastCheckedAt) : completedAt, input.lastStateChangeAt ? new Date(input.lastStateChangeAt) : null, input.lastHttpStatus ?? null, input.lastResolvedUrl ?? null, input.failureCount ?? null, input.lastErrorCode ?? null, input.watchlistRunId, input.watchStatus ?? null]
      );
      return mapWatchlistRunRow(run);
    });
  }

  async listWatchlistRuns(watchlistId: string): Promise<WatchlistRun[]> {
    const result = await this.pool.query<WatchlistRunRow>(
      `SELECT ${WATCHLIST_RUN_SELECT_COLUMNS}
       FROM watchlist_runs WHERE watchlist_id = $1 ORDER BY created_at DESC`,
      [watchlistId]
    );
    return result.rows.map(mapWatchlistRunRow);
  }

  async recordWatchlistNotificationDelivery(input: WatchlistNotificationDeliveryInput): Promise<WatchlistNotificationDelivery> {
    const now = new Date();
    const id = createId();
    const result = await this.pool.query<WatchlistNotificationDeliveryRow>(
      `INSERT INTO watchlist_notification_deliveries (
        id, watchlist_run_id, kind, status, target, payload, response_status, error_message, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
      RETURNING id, watchlist_run_id, kind, status, target, payload, response_status, error_message, created_at`,
      [id, input.watchlistRunId, input.kind, input.status, input.target ?? null, asJson(input.payload), input.responseStatus ?? null, input.errorMessage ?? null, now]
    );
    const row = result.rows[0];
    if (!row) { throw new Error("Failed to record watchlist notification delivery"); }
    return mapWatchlistNotificationDeliveryRow(row);
  }

  async listWatchlistNotificationDeliveries(watchlistRunId: string): Promise<WatchlistNotificationDelivery[]> {
    const result = await this.pool.query<WatchlistNotificationDeliveryRow>(
      `SELECT id, watchlist_run_id, kind, status, target, payload, response_status, error_message, created_at
       FROM watchlist_notification_deliveries WHERE watchlist_run_id = $1 ORDER BY created_at ASC`,
      [watchlistRunId]
    );
    return result.rows.map(mapWatchlistNotificationDeliveryRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

















