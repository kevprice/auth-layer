import type {
  ArtifactKind,
  ArtifactReference,
  CanonicalContent,
  CanonicalMetadata,
  CaptureLifecycleEvent,
  CaptureRecord,
  ContentExtractionStatus,
  CreateWatchlistRequest,
  PageKind,
  AttestationBundle,
  PdfApprovalMethod,
  PdfApprovalReceipt,
  PdfApprovalScope,
  ProofBundle,
  RenderedEvidence,
  TransparencyCheckpoint,
  TransparencyLogEntry,
  TransparencyReceipt,
  UpdateWatchlistRequest,
  Watchlist,
  WatchlistNotificationDelivery,
  WatchlistResultPayload,
  WatchlistRun
} from "@auth-layer/shared";

export type CreateCaptureInput = {
  requestedUrl: string;
  normalizedRequestedUrl: string;
  extractorVersion: string;
};

export type CreateArticleCaptureInput = {
  requestedUrl: string;
  normalizedRequestedUrl: string;
  extractorVersion: string;
  sourceLabel: string;
  fileName?: string;
  mediaType: string;
  byteSize: number;
  rawHtmlStorageKey: string;
  rawSnapshotHash: string;
  articleInputStorageKey: string;
};

export type CreateImageCaptureInput = {
  requestedUrl: string;
  normalizedRequestedUrl: string;
  extractorVersion: string;
  sourceLabel: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  rawImageStorageKey: string;
  rawSnapshotHash: string;
  imageInputStorageKey?: string;
};

export type CreatePdfCaptureInput = {
  requestedUrl: string;
  normalizedRequestedUrl: string;
  extractorVersion: string;
  sourceLabel: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  rawPdfStorageKey: string;
  rawSnapshotHash: string;
  actorAccountId?: string | null;
  approvalType?: string | null;
  approvalScope?: PdfApprovalScope | null;
  approvalMethod?: PdfApprovalMethod | null;
};

export type ArtifactReferenceInput = {
  kind: ArtifactKind;
  storageKey: string;
  contentHash: string;
  contentType?: string;
  byteSize?: number;
};

export type FetchCompletedInput = {
  captureId: string;
  finalUrl: string;
  fetchedAt: string;
  httpStatus: number;
  headers: Record<string, string>;
  contentType?: string;
  charset?: string;
  rawSnapshotHash: string;
  rawSourceArtifact: ArtifactReferenceInput;
};

export type DerivationCompletedInput = {
  captureId: string;
  pageKind: PageKind;
  extractionStatus: ContentExtractionStatus;
  claimedPublishedAt?: string;
  canonicalContent: CanonicalContent;
  metadata: CanonicalMetadata;
  canonicalContentHash: string;
  metadataHash: string;
  canonicalContentArtifact: ArtifactReferenceInput;
  metadataArtifact: ArtifactReferenceInput;
  screenshotArtifact?: ArtifactReferenceInput;
  renderedEvidence?: RenderedEvidence;
};

export type TimestampCompletedInput = {
  captureId: string;
  capturedAt: string;
  proofBundle: ProofBundle;
  proofBundleHash: string;
  receipt: TransparencyReceipt;
  proofBundleArtifact: ArtifactReferenceInput;
  comparedToCaptureId?: string;
  contentChangedFromPrevious?: boolean;
  metadataChangedFromPrevious?: boolean;
  titleChangedFromPrevious?: boolean;
  authorChangedFromPrevious?: boolean;
  claimedPublishedAtChangedFromPrevious?: boolean;
};

export type FailureInput = {
  captureId: string;
  stageStatus: CaptureRecord["status"];
  errorCode: string;
  errorMessage: string;
};

export type CompleteWatchlistRunInput = {
  watchlistRunId: string;
  captureId?: string;
  previousCaptureId?: string;
  newerCaptureId?: string;
  outcome?: WatchlistRun["outcome"];
  httpStatus?: number;
  resolvedUrl?: string;
  previousResolvedUrl?: string;
  stateChanged?: boolean;
  availabilityTransition?: WatchlistRun["availabilityTransition"];
  redirectChanged?: boolean;
  changeDetected: boolean;
  changeSummary: string[];
  proofBundleHashes: { older?: string; newer?: string };
  checkpointIds: { older?: string; newer?: string };
  completedAt: string;
  lastCheckedAt?: string;
  lastSuccessfulFetchAt?: string;
  lastStateChangeAt?: string;
  lastHttpStatus?: number;
  lastResolvedUrl?: string;
  failureCount?: number;
  lastErrorCode?: string;
  watchStatus?: Watchlist["status"];
};

export type FailWatchlistRunInput = {
  watchlistRunId: string;
  errorMessage: string;
  outcome?: WatchlistRun["outcome"];
  httpStatus?: number;
  resolvedUrl?: string;
  previousResolvedUrl?: string;
  stateChanged?: boolean;
  availabilityTransition?: WatchlistRun["availabilityTransition"];
  redirectChanged?: boolean;
  completedAt?: string;
  lastCheckedAt?: string;
  lastStateChangeAt?: string;
  lastHttpStatus?: number;
  lastResolvedUrl?: string;
  failureCount?: number;
  lastErrorCode?: string;
  watchStatus?: Watchlist["status"];
};

export type WatchlistNotificationDeliveryInput = {
  watchlistRunId: string;
  kind: WatchlistNotificationDelivery["kind"];
  status: WatchlistNotificationDelivery["status"];
  target?: string;
  payload: WatchlistResultPayload;
  responseStatus?: number;
  errorMessage?: string;
};

export type AttestationBundleInput = {
  captureId: string;
  attestationBundle: AttestationBundle;
  artifact: ArtifactReferenceInput;
};

export type ApprovalReceiptInput = {
  captureId: string;
  approvalReceipt: PdfApprovalReceipt;
  artifact: ArtifactReferenceInput;
  actorAccountId: string;
  approvalType: string;
  approvalScope: PdfApprovalScope;
  approvalMethod: PdfApprovalMethod;
};

export interface CaptureRepository {
  createCapture(input: CreateCaptureInput): Promise<CaptureRecord>;
  createArticleCapture(input: CreateArticleCaptureInput): Promise<CaptureRecord>;
  createPdfCapture(input: CreatePdfCaptureInput): Promise<CaptureRecord>;
  createImageCapture(input: CreateImageCaptureInput): Promise<CaptureRecord>;
  getCapture(id: string): Promise<CaptureRecord | undefined>;
  getCaptureByReceiptId(receiptId: string): Promise<CaptureRecord | undefined>;
  listCapturesForUrl(normalizedRequestedUrl: string): Promise<CaptureRecord[]>;
  claimNextQueuedCapture(workerId: string): Promise<CaptureRecord | undefined>;
  createWatchlist(input: CreateWatchlistRequest): Promise<Watchlist>;
  listWatchlists(): Promise<Watchlist[]>;
  getWatchlist(id: string): Promise<Watchlist | undefined>;
  updateWatchlist(id: string, input: UpdateWatchlistRequest): Promise<Watchlist | undefined>;
  claimNextDueWatchlist(workerId: string, now: string): Promise<Watchlist | undefined>;
  createWatchlistRun(input: { watchlistId: string; normalizedRequestedUrl: string }): Promise<WatchlistRun>;
  completeWatchlistRun(input: CompleteWatchlistRunInput): Promise<WatchlistRun>;
  failWatchlistRun(input: FailWatchlistRunInput): Promise<WatchlistRun>;
  listWatchlistRuns(watchlistId: string): Promise<WatchlistRun[]>;
  recordWatchlistNotificationDelivery(input: WatchlistNotificationDeliveryInput): Promise<WatchlistNotificationDelivery>;
  recordApprovalReceipt(input: ApprovalReceiptInput): Promise<CaptureRecord>;
  recordAttestationBundle(input: AttestationBundleInput): Promise<CaptureRecord>;
  getApprovalReceipt(id: string): Promise<PdfApprovalReceipt | undefined>;
  listWatchlistNotificationDeliveries(watchlistRunId: string): Promise<WatchlistNotificationDelivery[]>;
  recordFetchCompleted(input: FetchCompletedInput): Promise<CaptureRecord>;
  recordDerivationCompleted(input: DerivationCompletedInput): Promise<CaptureRecord>;
  recordTimestampCompleted(input: TimestampCompletedInput): Promise<CaptureRecord>;
  recordFailure(input: FailureInput): Promise<CaptureRecord>;
  getReceipt(id: string): Promise<TransparencyReceipt | undefined>;
  listCaptureEvents(captureId: string): Promise<CaptureLifecycleEvent[]>;
  listArtifactReferences(captureId: string): Promise<ArtifactReference[]>;
  appendTransparencyLogEntry(input: { captureId: string; proofBundleHash: string }): Promise<TransparencyLogEntry>;
  getTransparencyLogEntry(captureId: string): Promise<TransparencyLogEntry | undefined>;
  getLatestTransparencyLogEntry(): Promise<TransparencyLogEntry | undefined>;
  listTransparencyLogEntries(options?: { uptoLogIndex?: number }): Promise<TransparencyLogEntry[]>;
  saveTransparencyCheckpoint(checkpoint: TransparencyCheckpoint): Promise<TransparencyCheckpoint>;
  getTransparencyCheckpoint(checkpointId: string): Promise<TransparencyCheckpoint | undefined>;
  getLatestTransparencyCheckpoint(): Promise<TransparencyCheckpoint | undefined>;
  close?(): Promise<void>;
}

export const mergeCaptureRecord = (
  current: CaptureRecord,
  patch: Partial<CaptureRecord>,
  updatedAt = new Date().toISOString()
): CaptureRecord => ({
  ...current,
  ...patch,
  artifacts: {
    ...current.artifacts,
    ...patch.artifacts
  },
  updatedAt
});



