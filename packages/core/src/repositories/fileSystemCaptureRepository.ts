import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  ArtifactReference,
  CaptureLifecycleEvent,
  CaptureRecord,
  CreateWatchlistRequest,
  TransparencyCheckpoint,
  TransparencyLogEntry,
  TransparencyReceipt
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
import { mergeCaptureRecord } from "./captureRepository.js";

const delay = (durationMs: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));

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
    case "approval-receipt":
      return { ...artifacts, approvalReceiptStorageKey: storageKey };
    case "attestation-bundle":
      return { ...artifacts, attestationBundleStorageKey: storageKey };
    default:
      return artifacts;
  }
};

export class FileSystemCaptureRepository implements CaptureRepository {
  private readonly capturesDirectory: string;
  private readonly receiptsDirectory: string;
  private readonly eventsDirectory: string;
  private readonly artifactsDirectory: string;
  private readonly transparencyDirectory: string;
  private readonly checkpointsDirectory: string;
  private readonly lockDirectory: string;

  constructor(rootDirectory: string) {
    const resolvedRoot = resolve(rootDirectory);
    this.capturesDirectory = join(resolvedRoot, "captures");
    this.receiptsDirectory = join(resolvedRoot, "receipts");
    this.eventsDirectory = join(resolvedRoot, "events");
    this.artifactsDirectory = join(resolvedRoot, "artifact-references");
    this.transparencyDirectory = join(resolvedRoot, "transparency-log");
    this.checkpointsDirectory = join(resolvedRoot, "transparency-checkpoints");
    this.lockDirectory = join(resolvedRoot, ".lock");
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.capturesDirectory, { recursive: true }),
      mkdir(this.receiptsDirectory, { recursive: true }),
      mkdir(this.eventsDirectory, { recursive: true }),
      mkdir(this.artifactsDirectory, { recursive: true }),
      mkdir(this.transparencyDirectory, { recursive: true }),
      mkdir(this.checkpointsDirectory, { recursive: true })
    ]);
  }

  private capturePath(id: string): string {
    return join(this.capturesDirectory, `${id}.json`);
  }

  private receiptPath(id: string): string {
    return join(this.receiptsDirectory, `${id}.json`);
  }

  private eventsPath(id: string): string {
    return join(this.eventsDirectory, `${id}.json`);
  }

  private artifactsPath(id: string): string {
    return join(this.artifactsDirectory, `${id}.json`);
  }

  private transparencyLogPath(): string {
    return join(this.transparencyDirectory, `entries.json`);
  }

  private checkpointPath(id: string): string {
    return join(this.checkpointsDirectory, `${id}.json`);
  }

  private latestCheckpointPath(): string {
    return join(this.checkpointsDirectory, `latest.json`);
  }

  private async withLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureDirectories();

    while (true) {
      try {
        await mkdir(this.lockDirectory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        await delay(20);
      }
    }

    try {
      return await callback();
    } finally {
      await rm(this.lockDirectory, { recursive: true, force: true });
    }
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallback;
      }

      throw error;
    }
  }

  private async writeJsonFile(path: string, value: unknown): Promise<void> {
    await writeFile(path, JSON.stringify(value, null, 2));
  }

  private async readCapture(id: string): Promise<CaptureRecord | undefined> {
    return this.readJsonFile<CaptureRecord | undefined>(this.capturePath(id), undefined);
  }

  private async writeCapture(capture: CaptureRecord): Promise<void> {
    await this.writeJsonFile(this.capturePath(capture.id), capture);
  }

  private async readEvents(id: string): Promise<CaptureLifecycleEvent[]> {
    return this.readJsonFile<CaptureLifecycleEvent[]>(this.eventsPath(id), []);
  }

  private async writeEvents(id: string, events: CaptureLifecycleEvent[]): Promise<void> {
    await this.writeJsonFile(this.eventsPath(id), events);
  }

  private async appendEvent(
    id: string,
    eventType: CaptureLifecycleEvent["eventType"],
    status: CaptureLifecycleEvent["status"],
    eventData: Record<string, unknown>,
    createdAt: string
  ): Promise<CaptureLifecycleEvent> {
    const events = await this.readEvents(id);
    const event: CaptureLifecycleEvent = {
      captureId: id,
      sequence: events.length + 1,
      eventType,
      status,
      eventData,
      createdAt
    };
    events.push(event);
    await this.writeEvents(id, events);
    return event;
  }

  private async readArtifactReferences(id: string): Promise<ArtifactReference[]> {
    return this.readJsonFile<ArtifactReference[]>(this.artifactsPath(id), []);
  }

  private async appendArtifactReference(id: string, input: ArtifactReferenceInput, createdAt: string): Promise<ArtifactReference> {
    const references = await this.readArtifactReferences(id);
    const version = references.filter((reference) => reference.kind === input.kind).length + 1;
    const reference: ArtifactReference = {
      captureId: id,
      kind: input.kind,
      version,
      storageKey: input.storageKey,
      contentHash: input.contentHash,
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt
    };
    references.push(reference);
    await this.writeJsonFile(this.artifactsPath(id), references);
    return reference;
  }

  private async readTransparencyEntries(): Promise<TransparencyLogEntry[]> {
    return this.readJsonFile<TransparencyLogEntry[]>(this.transparencyLogPath(), []);
  }

  private async writeTransparencyEntries(entries: TransparencyLogEntry[]): Promise<void> {
    await this.writeJsonFile(this.transparencyLogPath(), entries);
  }

  private async listAllCaptures(): Promise<CaptureRecord[]> {
    await this.ensureDirectories();
    const entries = await readdir(this.capturesDirectory);
    const captures = await Promise.all(
      entries.map(async (entry) => JSON.parse(await readFile(join(this.capturesDirectory, entry), "utf8")) as CaptureRecord)
    );
    return captures.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createCapture(input: CreateCaptureInput): Promise<CaptureRecord> {
    return this.withLock(async () => {
      const timestamp = new Date().toISOString();
      const record: CaptureRecord = {
        id: createId(),
        requestedUrl: input.requestedUrl,
        normalizedRequestedUrl: input.normalizedRequestedUrl,
        extractorVersion: input.extractorVersion,
        status: "queued",
        latestEventSequence: 1,
        artifacts: {},
        createdAt: timestamp,
        updatedAt: timestamp,
        actorAccountId: null,
        approvalReceiptId: null,
        approvalType: null
      };

      await this.writeCapture(record);
      await this.writeEvents(record.id, [
        {
          captureId: record.id,
          sequence: 1,
          eventType: "queued",
          status: "queued",
          eventData: {
            extractorVersion: input.extractorVersion,
            normalizedRequestedUrl: input.normalizedRequestedUrl,
            requestedUrl: input.requestedUrl
          },
          createdAt: timestamp
        }
      ]);
      await this.writeJsonFile(this.artifactsPath(record.id), []);
      return record;
    });
  }

  async getCapture(id: string): Promise<CaptureRecord | undefined> {
    await this.ensureDirectories();
    return this.readCapture(id);
  }

  async getCaptureByReceiptId(receiptId: string): Promise<CaptureRecord | undefined> {
    const captures = await this.listAllCaptures();
    return captures.find((capture) => capture.proofReceiptId === receiptId);
  }

  async listCapturesForUrl(normalizedRequestedUrl: string): Promise<CaptureRecord[]> {
    const captures = await this.listAllCaptures();
    return captures.filter((capture) => capture.normalizedRequestedUrl === normalizedRequestedUrl);
  }

  async claimNextQueuedCapture(_workerId: string): Promise<CaptureRecord | undefined> {
    return this.withLock(async () => {
      const captures = await this.listAllCaptures();
      const nextQueuedCapture = captures
        .filter((capture) => capture.status === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

      if (!nextQueuedCapture) {
        return undefined;
      }

      const timestamp = new Date().toISOString();
      const event = await this.appendEvent(nextQueuedCapture.id, "fetch_started", "fetching", {}, timestamp);
      const claimed = mergeCaptureRecord(
        nextQueuedCapture,
        {
          status: "fetching",
          latestEventSequence: event.sequence,
          errorCode: undefined,
          errorMessage: undefined
        },
        timestamp
      );

      await this.writeCapture(claimed);
      return claimed;
    });
  }

  async recordFetchCompleted(input: FetchCompletedInput): Promise<CaptureRecord> {
    return this.withLock(async () => {
      const current = await this.readCapture(input.captureId);
      if (!current) {
        throw new Error(`Capture ${input.captureId} not found`);
      }

      await this.appendArtifactReference(input.captureId, input.rawSourceArtifact, input.fetchedAt);
      const event = await this.appendEvent(
        input.captureId,
        "fetch_completed",
        "extracting",
        {
          fetchedAt: input.fetchedAt,
          finalUrl: input.finalUrl,
          httpStatus: input.httpStatus,
          contentType: input.contentType ?? null,
          charset: input.charset ?? null,
          rawSnapshotHash: input.rawSnapshotHash
        },
        input.fetchedAt
      );
      const next = mergeCaptureRecord(
        current,
        {
          finalUrl: input.finalUrl,
          fetchedAt: input.fetchedAt,
          httpStatus: input.httpStatus,
          headers: input.headers,
          contentType: input.contentType,
          charset: input.charset,
          rawSnapshotHash: input.rawSnapshotHash,
          status: "extracting",
          latestEventSequence: event.sequence,
          artifacts: appendArtifactKey(current.artifacts, input.rawSourceArtifact.kind, input.rawSourceArtifact.storageKey),
          errorCode: undefined,
          errorMessage: undefined
        },
        input.fetchedAt
      );

      await this.writeCapture(next);
      return next;
    });
  }

  async recordDerivationCompleted(input: DerivationCompletedInput): Promise<CaptureRecord> {
    return this.withLock(async () => {
      const current = await this.readCapture(input.captureId);
      if (!current) {
        throw new Error(`Capture ${input.captureId} not found`);
      }

      const timestamp = new Date().toISOString();
      await this.appendArtifactReference(input.captureId, input.canonicalContentArtifact, timestamp);
      await this.appendArtifactReference(input.captureId, input.metadataArtifact, timestamp);
      await this.appendEvent(
        input.captureId,
        "extraction_completed",
        "hashing",
        {
          extractionStatus: input.extractionStatus,
          pageKind: input.pageKind,
          claimedPublishedAt: input.claimedPublishedAt ?? null,
          canonicalContentSchemaVersion: input.canonicalContent.schemaVersion,
          metadataSchemaVersion: input.metadata.schemaVersion,
          normalizationVersion: input.canonicalContent.normalizationVersion
        },
        timestamp
      );
      const hashingEvent = await this.appendEvent(
        input.captureId,
        "hashing_completed",
        "timestamping",
        {
          canonicalContentHash: input.canonicalContentHash,
          metadataHash: input.metadataHash
        },
        timestamp
      );

      const next = mergeCaptureRecord(
        current,
        {
          claimedPublishedAt: input.claimedPublishedAt,
          canonicalContentHash: input.canonicalContentHash,
          metadataHash: input.metadataHash,
          normalizationVersion: input.canonicalContent.normalizationVersion,
          canonicalContentSchemaVersion: input.canonicalContent.schemaVersion,
          metadataSchemaVersion: input.metadata.schemaVersion,
          latestCanonicalContentVersion: (current.latestCanonicalContentVersion ?? 0) + 1,
          latestMetadataVersion: (current.latestMetadataVersion ?? 0) + 1,
          latestEventSequence: hashingEvent.sequence,
          pageKind: input.pageKind,
          contentExtractionStatus: input.extractionStatus,
          status: "timestamping",
          artifacts: appendArtifactKey(
            appendArtifactKey(current.artifacts, input.canonicalContentArtifact.kind, input.canonicalContentArtifact.storageKey),
            input.metadataArtifact.kind,
            input.metadataArtifact.storageKey
          ),
          errorCode: undefined,
          errorMessage: undefined
        },
        timestamp
      );

      await this.writeCapture(next);
      return next;
    });
  }

  async recordTimestampCompleted(input: TimestampCompletedInput): Promise<CaptureRecord> {
    return this.withLock(async () => {
      const current = await this.readCapture(input.captureId);
      if (!current) {
        throw new Error(`Capture ${input.captureId} not found`);
      }

      await this.appendArtifactReference(input.captureId, input.proofBundleArtifact, input.capturedAt);
      const event = await this.appendEvent(
        input.captureId,
        "timestamping_completed",
        "completed",
        {
          proofBundleHash: input.proofBundleHash,
          receiptId: input.receipt.id,
          comparedToCaptureId: input.comparedToCaptureId ?? null,
          contentChangedFromPrevious: input.contentChangedFromPrevious ?? null,
          metadataChangedFromPrevious: input.metadataChangedFromPrevious ?? null,
          titleChangedFromPrevious: input.titleChangedFromPrevious ?? null,
          authorChangedFromPrevious: input.authorChangedFromPrevious ?? null,
          claimedPublishedAtChangedFromPrevious: input.claimedPublishedAtChangedFromPrevious ?? null
        },
        input.capturedAt
      );
      await this.writeJsonFile(this.receiptPath(input.receipt.id), input.receipt);

      const next = mergeCaptureRecord(
        current,
        {
          capturedAt: input.capturedAt,
          proofBundleHash: input.proofBundleHash,
          proofReceiptId: input.receipt.id,
          hashAlgorithm: input.proofBundle.hashAlgorithm,
          latestProofBundleVersion: (current.latestProofBundleVersion ?? 0) + 1,
          latestReceiptVersion: (current.latestReceiptVersion ?? 0) + 1,
          latestEventSequence: event.sequence,
          comparedToCaptureId: input.comparedToCaptureId,
          contentChangedFromPrevious: input.contentChangedFromPrevious,
          metadataChangedFromPrevious: input.metadataChangedFromPrevious,
          titleChangedFromPrevious: input.titleChangedFromPrevious,
          authorChangedFromPrevious: input.authorChangedFromPrevious,
          claimedPublishedAtChangedFromPrevious: input.claimedPublishedAtChangedFromPrevious,
          status: "completed",
          artifacts: appendArtifactKey(current.artifacts, input.proofBundleArtifact.kind, input.proofBundleArtifact.storageKey),
          errorCode: undefined,
          errorMessage: undefined
        },
        input.capturedAt
      );

      await this.writeCapture(next);
      return next;
    });
  }

  async recordFailure(input: FailureInput): Promise<CaptureRecord> {
    return this.withLock(async () => {
      const current = await this.readCapture(input.captureId);
      if (!current) {
        throw new Error(`Capture ${input.captureId} not found`);
      }

      const timestamp = new Date().toISOString();
      const event = await this.appendEvent(
        input.captureId,
        "failed",
        "failed",
        {
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          stageStatus: input.stageStatus
        },
        timestamp
      );
      const next = mergeCaptureRecord(
        current,
        {
          status: "failed",
          latestEventSequence: event.sequence,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage
        },
        timestamp
      );

      await this.writeCapture(next);
      return next;
    });
  }

  async getReceipt(id: string): Promise<TransparencyReceipt | undefined> {
    return this.readJsonFile<TransparencyReceipt | undefined>(this.receiptPath(id), undefined);
  }

  async listCaptureEvents(captureId: string): Promise<CaptureLifecycleEvent[]> {
    return this.readEvents(captureId);
  }

  async listArtifactReferences(captureId: string): Promise<ArtifactReference[]> {
    return this.readArtifactReferences(captureId);
  }

  async appendTransparencyLogEntry(input: { captureId: string; proofBundleHash: string }): Promise<TransparencyLogEntry> {
    return this.withLock(async () => {
      const entries = await this.readTransparencyEntries();
      const existing = entries.find((entry) => entry.captureId === input.captureId);
      if (existing) {
        return existing;
      }

      const latest = entries[entries.length - 1];
      const createdAt = new Date().toISOString();
      const nextEntry: TransparencyLogEntry = {
        schemaVersion: 1,
        logIndex: (latest?.logIndex ?? 0) + 1,
        captureId: input.captureId,
        proofBundleHash: input.proofBundleHash,
        previousEntryHash: latest?.entryHash,
        entryHash: "",
        createdAt
      };
      nextEntry.entryHash = hashStableValue({
        schemaVersion: nextEntry.schemaVersion,
        logIndex: nextEntry.logIndex,
        captureId: nextEntry.captureId,
        proofBundleHash: nextEntry.proofBundleHash,
        previousEntryHash: nextEntry.previousEntryHash ?? null,
        createdAt: nextEntry.createdAt
      });
      entries.push(nextEntry);
      await this.writeTransparencyEntries(entries);
      return nextEntry;
    });
  }

  async getTransparencyLogEntry(captureId: string): Promise<TransparencyLogEntry | undefined> {
    const entries = await this.readTransparencyEntries();
    return entries.find((entry) => entry.captureId === captureId);
  }

  async getLatestTransparencyLogEntry(): Promise<TransparencyLogEntry | undefined> {
    const entries = await this.readTransparencyEntries();
    return entries[entries.length - 1];
  }

  async listTransparencyLogEntries(options?: { uptoLogIndex?: number }): Promise<TransparencyLogEntry[]> {
    const entries = await this.readTransparencyEntries();
    const uptoLogIndex = options?.uptoLogIndex;
    return uptoLogIndex !== undefined ? entries.filter((entry) => entry.logIndex <= uptoLogIndex) : entries;
  }

  async saveTransparencyCheckpoint(checkpoint: TransparencyCheckpoint): Promise<TransparencyCheckpoint> {
    await this.ensureDirectories();
    await this.writeJsonFile(this.checkpointPath(checkpoint.checkpointId), checkpoint);
    await this.writeJsonFile(this.latestCheckpointPath(), checkpoint);
    return checkpoint;
  }

  async getTransparencyCheckpoint(checkpointId: string): Promise<TransparencyCheckpoint | undefined> {
    return this.readJsonFile<TransparencyCheckpoint | undefined>(this.checkpointPath(checkpointId), undefined);
  }

  async getLatestTransparencyCheckpoint(): Promise<TransparencyCheckpoint | undefined> {
    return this.readJsonFile<TransparencyCheckpoint | undefined>(this.latestCheckpointPath(), undefined);
  }

  async createArticleCapture(_input: import("./captureRepository.js").CreateArticleCaptureInput): Promise<CaptureRecord> {
    throw new Error("FileSystemCaptureRepository does not support article publish captures");
  }

  async createImageCapture(_input: import("./captureRepository.js").CreateImageCaptureInput): Promise<CaptureRecord> {
    throw new Error("FileSystemCaptureRepository does not support image captures");
  }

  async createPdfCapture(_input: CreatePdfCaptureInput): Promise<CaptureRecord> {
    throw new Error("FileSystemCaptureRepository does not support PDF captures");
  }

  async createWatchlist(_input: CreateWatchlistRequest): Promise<never> {
    throw new Error("FileSystemCaptureRepository does not support watchlists");
  }

  async listWatchlists(): Promise<[]> {
    return [];
  }

  async getWatchlist(_id: string): Promise<undefined> {
    return undefined;
  }

  async updateWatchlist(_id: string, _input: unknown): Promise<undefined> {
    return undefined;
  }

  async claimNextDueWatchlist(_workerId: string, _now: string): Promise<undefined> {
    return undefined;
  }

  async createWatchlistRun(_input: { watchlistId: string; normalizedRequestedUrl: string }): Promise<never> {
    throw new Error("FileSystemCaptureRepository does not support watchlist runs");
  }

  async completeWatchlistRun(_input: CompleteWatchlistRunInput): Promise<never> {
    throw new Error("FileSystemCaptureRepository does not support watchlist runs");
  }

  async failWatchlistRun(_input: FailWatchlistRunInput): Promise<never> {
    throw new Error("FileSystemCaptureRepository does not support watchlist runs");
  }

  async listWatchlistRuns(_watchlistId: string): Promise<[]> {
    return [];
  }

  async recordWatchlistNotificationDelivery(_input: WatchlistNotificationDeliveryInput): Promise<never> {
    throw new Error("FileSystemCaptureRepository does not support watchlist notification deliveries");
  }

  async listWatchlistNotificationDeliveries(_watchlistRunId: string): Promise<[]> {
    return [];
  }

  async recordAttestationBundle(): Promise<never> {
    throw new Error("FileSystemCaptureRepository does not support attestation bundles");
  }

  async recordApprovalReceipt(): Promise<never> {
    throw new Error("FileSystemCaptureRepository does not support approval receipts");
  }

  async getApprovalReceipt(): Promise<undefined> {
    return undefined;
  }
}



