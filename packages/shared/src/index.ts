import type { AttestationBundle, AttestationSummary, ContentAttestationActor, ContentAttestationInput } from "./attestations.js";
import type { LineageBundle, LineageSummary } from "./lineage.js";

export type CaptureStatus =
  | "queued"
  | "fetching"
  | "extracting"
  | "hashing"
  | "timestamping"
  | "completed"
  | "failed";

export type CaptureEventType =
  | "queued"
  | "fetch_started"
  | "fetch_completed"
  | "extraction_completed"
  | "hashing_completed"
  | "timestamping_completed"
  | "approval_completed"
  | "failed";

export type PageKind = "article" | "generic" | "failed";
export type ContentExtractionStatus = "success" | "fallback" | "failed";
export type ArtifactKind = "raw-html" | "raw-pdf" | "raw-image" | "canonical-content" | "metadata" | "proof-bundle" | "screenshot" | "approval-receipt" | "attestation-bundle";
export type FieldSourceKind = "meta-tag" | "link-rel" | "document-title" | "readability" | "dom" | "fallback" | "not-found";
export type CanonicalBlockType = "heading" | "paragraph" | "blockquote" | "list-item";
export type SignatureAlgorithm = "ed25519";
export type TransparencyLogMode = "legacy-hash-chain" | "merkle-tree-v1";
export type TransparencyProofMode = "legacy-exact-entry" | "merkle-v1";
export type CaptureComparisonBasis = "capture-id" | "captured-at";
export type CaptureArtifactType = "url-capture" | "pdf-file" | "image-file" | "article-publish";
export type WatchlistStatus = "active" | "paused" | "expired" | "archived";
export type WatchlistRunStatus = "started" | "completed" | "failed";
export type WatchlistDeliveryKind = "local" | "webhook" | "json";
export type WatchlistDeliveryStatus = "recorded" | "sent" | "failed";
export type WatchlistCaptureHealth = "success" | "degraded" | "failed";
export type WatchlistFetchOutcome = "ok_unchanged" | "ok_changed" | "redirected" | "not_found" | "gone" | "blocked" | "server_error" | "network_error" | "timeout" | "content_type_changed";
export type WatchlistAvailabilityTransition = "available_to_missing" | "missing_to_available";
export type WatchlistEventType = "watchlist.run.completed" | "watchlist.change.detected" | "watchlist.run.failed" | "watchlist.delivery.failed";
export type WatchlistRunVerdict = "changed" | "unchanged" | "failed" | "baseline";
export type PdfApprovalScope = "file-hash" | "exported-artifact" | "publication-intent";
export type PdfApprovalMethod = "account-signature" | "passkey" | "external-signer";
export type EvidenceLayerId = "raw-snapshot" | "canonical-content" | "metadata" | "rendered-evidence" | "operator-observation" | "uploader-approval" | "attestations";

export type CreateCaptureRequest = {
  url: string;
};

export type WordPressApprovalPolicy = "none" | "passkey-on-publish" | "passkey-on-update" | "passkey-on-all";

export type WordPressArticlePayload = {
  schemaVersion?: number;
  siteIdentifier: string;
  siteUrl: string;
  postId: string;
  revisionId?: string;
  publishedUrl: string;
  canonicalUrl: string;
  title: string;
  bodyHtml: string;
  excerpt?: string;
  authorDisplayName?: string;
  publishedAt?: string;
  updatedAt?: string;
  categories?: string[];
  tags?: string[];
  featuredImageUrl?: string;
  language?: string;
};

export type WordPressArticleApprovalInput = {
  policy?: WordPressApprovalPolicy;
  actor?: ContentAttestationActor;
  notes?: string;
};

export type CreateWordPressArticleRequest = {
  article: WordPressArticlePayload;
  action?: "publish" | "update";
  approval?: WordPressArticleApprovalInput;
  attestations?: ContentAttestationInput[];
};

export type WordPressApprovalChallenge = {
  id: string;
  article: WordPressArticlePayload;
  action: "publish" | "update";
  requestedAt: string;
  actor?: ContentAttestationActor;
  policy: WordPressApprovalPolicy;
  attestations?: ContentAttestationInput[];
  notes?: string;
};

export type CompleteWordPressApprovalRequest = {
  challengeId: string;
  actor?: ContentAttestationActor;
  notes?: string;
};

export type ArticleDiscoveryManifest = {
  schemaVersion: number;
  manifestType: "auth-layer-article-discovery";
  siteIdentifier?: string;
  canonicalUrl: string;
  latestCaptureId: string;
  artifactType: CaptureArtifactType;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  updatedAt?: string;
  captureExportUrl: string;
  transparencyLogUrl: string;
};

export type CreateImageCaptureRequest = {
  fileName: string;
  mediaType: string;
  caption?: string;
  altText?: string;
  capturedAt?: string;
  publishedAt?: string;
  derivativeOfContentHash?: string;
  attestations?: ContentAttestationInput[];
};

export type CreatePdfCaptureRequest = {
  fileName: string;
  mediaType: string;
  approval?: {
    actorAccountId: string;
    approvalType?: string;
    approvalScope?: PdfApprovalScope;
    approvalMethod?: PdfApprovalMethod;
  };
};

export type WatchlistBurstConfig = {
  enabled: boolean;
  intervalSeconds?: number;
  durationSeconds?: number;
  burstUntil?: string;
};

export type CreateWatchlistRequest = {
  url: string;
  intervalMinutes?: number;
  intervalSeconds?: number;
  webhookUrl?: string;
  emitJson?: boolean;
  expiresAt?: string;
  burstConfig?: WatchlistBurstConfig;
};

export type UpdateWatchlistRequest = {
  intervalMinutes?: number;
  intervalSeconds?: number;
  webhookUrl?: string | null;
  emitJson?: boolean;
  expiresAt?: string | null;
  burstConfig?: WatchlistBurstConfig | null;
  status?: WatchlistStatus;
};

export type CaptureScope = {
  rawHttpBodyPreserved: boolean;
  rawFilePreserved?: boolean;
  canonicalContentExtracted: boolean;
  metadataExtracted: boolean;
  screenshotPreserved: boolean;
  renderedDomPreserved: boolean;
};

export type RenderViewport = {
  width: number;
  height: number;
  pixelRatio?: number;
};

export type RenderedEvidence = {
  screenshot?: {
    hash: string;
    format: string;
    mediaType?: string;
  };
  viewport?: RenderViewport;
  device?: {
    devicePreset?: string;
    userAgent?: string;
    userAgentLabel?: string;
  };
  screenshotHash?: string;
  userAgentLabel?: string;
};

export type ArticleObject = {
  type: "article";
  siteIdentifier: string;
  siteUrl: string;
  postId: string;
  revisionId?: string;
  publishedUrl: string;
  canonicalUrl: string;
  excerpt?: string;
  categories?: string[];
  tags?: string[];
  featuredImageUrl?: string;
  authorDisplayName?: string;
  publishedAt?: string;
  updatedAt?: string;
  language?: string;
};

export type ImageObject = {
  type: "image";
  mimeType: string;
  byteLength: number;
  contentHash: string;
  width?: number;
  height?: number;
  filename?: string;
  caption?: string;
  altText?: string;
  capturedAt?: string;
  publishedAt?: string;
  derivativeOfContentHash?: string;
};

export type RawSnapshot = {
  schemaVersion: number;
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  httpStatus: number;
  headers: Record<string, string>;
  contentType?: string;
  charset?: string;
  rawHtmlStorageKey: string;
};

export type CanonicalBlock = {
  order: number;
  type: CanonicalBlockType;
  text: string;
  level?: number;
};

export type ExtractionStats = {
  characterCount: number;
  wordCount: number;
  blockCount: number;
  paragraphCount: number;
  headingCount: number;
  imageCount: number;
};

export type ExtractionDiagnostics = {
  confidence: number;
  warnings: string[];
};

export type ExtractedFieldSource = {
  sourceKind: FieldSourceKind;
  strategy: string;
  selector?: string;
  attribute?: string;
  note?: string;
};

export type FieldProvenance = {
  title: ExtractedFieldSource;
  subtitle: ExtractedFieldSource;
  author: ExtractedFieldSource;
  publishedAtClaimed: ExtractedFieldSource;
  canonicalUrl: ExtractedFieldSource;
};

export type CanonicalContent = {
  schemaVersion: number;
  artifactType?: CaptureArtifactType;
  normalizationVersion: string;
  sourceUrl: string;
  sourceLabel?: string;
  fileName?: string;
  mediaType?: string;
  byteSize?: number;
  pageCount?: number;
  textAvailable?: boolean;
  canonicalUrl?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  publishedAtClaimed?: string;
  imageObject?: ImageObject;
  articleObject?: ArticleObject;
  blocks: CanonicalBlock[];
  bodyMarkdown: string;
  imageUrls?: string[];
  extractorVersion: string;
  stats: ExtractionStats;
  diagnostics: ExtractionDiagnostics;
};

export type CanonicalMetadata = {
  schemaVersion: number;
  artifactType?: CaptureArtifactType;
  normalizationVersion: string;
  sourceUrl: string;
  sourceLabel?: string;
  fileName?: string;
  mediaType?: string;
  byteSize?: number;
  pageCount?: number;
  textAvailable?: boolean;
  canonicalUrl?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  publishedAtClaimed?: string;
  imageObject?: ImageObject;
  articleObject?: ArticleObject;
  language?: string;
  extractorVersion: string;
  fieldProvenance: FieldProvenance;
};

export type PdfCanonicalContent = CanonicalContent & {
  artifactType: "pdf-file";
  fileName: string;
  mediaType: string;
  byteSize: number;
  textAvailable: boolean;
};

export type PdfCanonicalMetadata = CanonicalMetadata & {
  artifactType: "pdf-file";
  fileName: string;
  mediaType: string;
  byteSize: number;
  textAvailable: boolean;
};

export type ImageCanonicalContent = CanonicalContent & {
  artifactType: "image-file";
  fileName: string;
  mediaType: string;
  byteSize: number;
  imageObject: ImageObject;
};

export type ImageCanonicalMetadata = CanonicalMetadata & {
  artifactType: "image-file";
  fileName: string;
  mediaType: string;
  byteSize: number;
  imageObject: ImageObject;
};

export type ProofBundle = {
  schemaVersion: number;
  artifactType?: CaptureArtifactType;
  captureId: string;
  sourceLabel?: string;
  fileName?: string;
  mediaType?: string;
  byteSize?: number;
  requestedUrl: string;
  finalUrl: string;
  pageKind: PageKind;
  extractorVersion: string;
  normalizationVersion: string;
  hashAlgorithm: string;
  rawSnapshotSchemaVersion: number;
  canonicalContentSchemaVersion: number;
  metadataSchemaVersion: number;
  captureScope: CaptureScope;
  rawSnapshotHash: string;
  screenshotHash?: string;
  canonicalContentHash: string;
  metadataHash: string;
  lineageBundleHash?: string;
  attestationBundleHash?: string;
  createdAt: string;
  receiptId?: string;
};

export type OperatorPublicKey = {
  schemaVersion: number;
  operatorId: string;
  keyId: string;
  algorithm: SignatureAlgorithm;
  publicKeyPem: string;
  publicKeySha256: string;
  createdAt: string;
  supersededByKeyId?: string;
};

export type TransparencyLogEntry = {
  schemaVersion: number;
  logIndex: number;
  captureId: string;
  proofBundleHash: string;
  entryHash: string;
  previousEntryHash?: string;
  createdAt: string;
};

export type TransparencyMerkleProofStep = {
  direction: "left" | "right";
  hash: string;
};

export type TransparencyInclusionProof = {
  schemaVersion: number;
  mode: TransparencyProofMode;
  algorithm: "sha256-merkle-v1" | "legacy-exact-entry";
  checkpointId?: string;
  treeSize: number;
  leafIndex: number;
  logEntryHash: string;
  leafHash: string;
  rootHash: string;
  steps: TransparencyMerkleProofStep[];
};

export type TransparencyCheckpoint = {
  schemaVersion: number;
  checkpointId: string;
  treeSize: number;
  lastLogIndex: number;
  lastEntryHash: string;
  rootHash: string;
  issuedAt: string;
  operatorId: string;
  operatorKeyId: string;
  operatorPublicKeySha256: string;
  signatureAlgorithm: SignatureAlgorithm;
  logMode?: TransparencyLogMode;
  checkpointHash: string;
  previousCheckpointId?: string;
  previousCheckpointHash?: string;
  signature: string;
};

export type TransparencyReceipt = {
  id: string;
  proofBundleHash: string;
  receivedAt: string;
  provider: string;
  signature: string;
  logIndex?: number;
  merkleRoot?: string;
  anchorRef?: string;
  anchorTimestamp?: string;
  transparencyLogEntryHash?: string;
  transparencyCheckpointId?: string;
};

export type CaptureArtifacts = {
  rawHtmlStorageKey?: string;
  articleInputStorageKey?: string;
  rawPdfStorageKey?: string;
  rawImageStorageKey?: string;
  imageInputStorageKey?: string;
  canonicalContentStorageKey?: string;
  metadataStorageKey?: string;
  proofBundleStorageKey?: string;
  screenshotStorageKey?: string;
  approvalReceiptStorageKey?: string;
  attestationBundleStorageKey?: string;
};

export type PdfApprovalReceipt = {
  schemaVersion: number;
  receiptType: "pdf-upload-approval";
  id: string;
  captureId: string;
  actorAccountId: string;
  approvalType: string;
  approvalScope: PdfApprovalScope;
  approvalMethod: PdfApprovalMethod;
  rawPdfHash: string;
  approvedAt: string;
  issuerOperatorId: string;
  issuerKeyId: string;
  issuerPublicKeySha256: string;
  signatureAlgorithm: SignatureAlgorithm;
  signature: string;
};

export type CaptureRecord = {
  id: string;
  artifactType?: CaptureArtifactType;
  sourceLabel?: string;
  fileName?: string;
  mediaType?: string;
  byteSize?: number;
  requestedUrl: string;
  normalizedRequestedUrl: string;
  finalUrl?: string;
  fetchedAt?: string;
  capturedAt?: string;
  claimedPublishedAt?: string;
  httpStatus?: number;
  headers?: Record<string, string>;
  contentType?: string;
  charset?: string;
  rawSnapshotHash?: string;
  canonicalContentHash?: string;
  metadataHash?: string;
  proofBundleHash?: string;
  lineageBundleHash?: string;
  attestationBundleHash?: string;
  proofReceiptId?: string;
  screenshotHash?: string;
  extractorVersion: string;
  normalizationVersion?: string;
  hashAlgorithm?: string;
  canonicalContentSchemaVersion?: number;
  metadataSchemaVersion?: number;
  latestEventSequence?: number;
  latestCanonicalContentVersion?: number;
  latestMetadataVersion?: number;
  latestProofBundleVersion?: number;
  latestReceiptVersion?: number;
  comparedToCaptureId?: string;
  status: CaptureStatus;
  pageKind?: PageKind;
  contentExtractionStatus?: ContentExtractionStatus;
  metadataChangedFromPrevious?: boolean;
  contentChangedFromPrevious?: boolean;
  titleChangedFromPrevious?: boolean;
  authorChangedFromPrevious?: boolean;
  claimedPublishedAtChangedFromPrevious?: boolean;
  errorCode?: string;
  errorMessage?: string;
  actorAccountId?: string | null;
  approvalReceiptId?: string | null;
  approvalType?: string | null;
  approvalScope?: PdfApprovalScope | null;
  approvalMethod?: PdfApprovalMethod | null;
  renderedEvidence?: RenderedEvidence;
  artifacts: CaptureArtifacts;
  createdAt: string;
  updatedAt: string;
};

export type CaptureDetail = {
  capture: CaptureRecord;
  canonicalContent?: CanonicalContent;
  metadata?: CanonicalMetadata;
  proofBundle?: ProofBundle;
  receipt?: TransparencyReceipt;
  approvalReceipt?: PdfApprovalReceipt;
  attestationBundle?: AttestationBundle;
};

export type UrlCaptureHistoryItem = Pick<
  CaptureRecord,
  | "id"
  | "requestedUrl"
  | "normalizedRequestedUrl"
  | "status"
  | "capturedAt"
  | "claimedPublishedAt"
  | "contentChangedFromPrevious"
  | "metadataChangedFromPrevious"
  | "titleChangedFromPrevious"
  | "authorChangedFromPrevious"
  | "claimedPublishedAtChangedFromPrevious"
  | "pageKind"
>;

export type CaptureLifecycleEvent = {
  captureId: string;
  sequence: number;
  eventType: CaptureEventType;
  status: CaptureStatus;
  eventData: Record<string, unknown>;
  createdAt: string;
};

export type ArtifactReference = {
  captureId: string;
  kind: ArtifactKind;
  version: number;
  storageKey: string;
  contentHash: string;
  contentType?: string;
  byteSize?: number;
  createdAt: string;
};

export type CaptureComparisonSummary = {
  comparedToCaptureId?: string;
  semanticContentChanged?: boolean;
  metadataChanged?: boolean;
  titleChanged?: boolean;
  authorChanged?: boolean;
  claimedPublishedAtChanged?: boolean;
};

export type EvidenceLayerSummary = {
  id: EvidenceLayerId;
  label: string;
  available: boolean;
  proves: string;
  doesNotProve: string;
  hashReference?: string;
  exportReference?: string;
};

export type PdfQualityDiagnostics = {
  embeddedTextDetected: boolean;
  extractedCharacterCount: number;
  metadataExtracted: boolean;
  likelyScannedImageOnly: boolean;
};

export type CaptureComparisonFields = {
  canonicalContentHashChanged: boolean;
  metadataHashChanged: boolean;
  titleChanged: boolean;
  authorChanged: boolean;
  claimedPublishedAtChanged: boolean;
  pageKindChanged: boolean;
  extractorVersionChanged: boolean;
};

export type CaptureComparisonHeadingChange = {
  index: number;
  from?: string;
  to?: string;
};

export type CaptureComparisonBlockSummary = {
  paragraphsAdded: number;
  paragraphsRemoved: number;
  headingsChanged: number;
  addedParagraphSamples: string[];
  removedParagraphSamples: string[];
  changedHeadingSamples: CaptureComparisonHeadingChange[];
};

export type CaptureComparisonDiagnosticsSnapshot = {
  captureId: string;
  pageKind?: PageKind;
  extractionStatus?: ContentExtractionStatus;
  extractorVersion?: string;
  confidence?: number;
  warnings: string[];
};

export type CaptureComparisonDiagnostics = {
  older: CaptureComparisonDiagnosticsSnapshot;
  newer: CaptureComparisonDiagnosticsSnapshot;
  notes: string[];
};

export type CaptureComparisonSide = {
  capture: CaptureRecord;
  canonicalContent?: CanonicalContent;
  metadata?: CanonicalMetadata;
  proofBundle?: ProofBundle;
  receipt?: TransparencyReceipt;
  observedAt: string;
};

export type CaptureComparison = {
  schemaVersion: number;
  normalizedRequestedUrl: string;
  basis: CaptureComparisonBasis;
  older: CaptureComparisonSide;
  newer: CaptureComparisonSide;
  fields: CaptureComparisonFields;
  blockSummary: CaptureComparisonBlockSummary;
  diagnostics: CaptureComparisonDiagnostics;
  changeSummary: string[];
  observationStatement: string;
};

export type CaptureTransparencyExport = {
  schemaVersion: number;
  artifactType?: CaptureArtifactType;
  exportType: "capture-transparency-export";
  exportedAt: string;
  proofStatement: string;
  captureScope: CaptureScope;
  comparisonSummary: CaptureComparisonSummary;
  evidenceLayers: EvidenceLayerSummary[];
  pdfQualityDiagnostics?: PdfQualityDiagnostics;
  lineageSummary?: LineageSummary;
  attestationSummary?: AttestationSummary;
  capture: CaptureRecord;
  events: CaptureLifecycleEvent[];
  artifactReferences: ArtifactReference[];
  lineageBundle?: LineageBundle;
  attestationBundle?: AttestationBundle;
  canonicalContent?: CanonicalContent;
  metadata?: CanonicalMetadata;
  proofBundle?: ProofBundle;
  receipt?: TransparencyReceipt;
  approvalReceipt?: PdfApprovalReceipt;
  transparencyLogEntry?: TransparencyLogEntry;
  transparencyCheckpoint?: TransparencyCheckpoint;
  transparencyInclusionProof?: TransparencyInclusionProof;
};

export type ProofPackageManifestFile = {
  path: string;
  mediaType: string;
  optional?: boolean;
};

export type ProofPackageManifest = {
  schemaVersion: number;
  artifactType?: CaptureArtifactType;
  sourceLabel?: string;
  fileName?: string;
  mediaType?: string;
  byteSize?: number;
  packageType: "auth-layer-proof-package";
  exportedAt: string;
  captureId: string;
  requestedUrl: string;
  finalUrl?: string;
  proofBundleHash?: string;
  lineageBundleHash?: string;
  attestationBundleHash?: string;
  canonicalContentHash?: string;
  metadataHash?: string;
  rawSnapshotHash?: string;
  hashAlgorithm?: string;
  extractorVersion: string;
  normalizationVersion?: string;
  files: {
    manifest: ProofPackageManifestFile;
    rawSnapshot: ProofPackageManifestFile;
    rawHtml: ProofPackageManifestFile;
    rawPdf?: ProofPackageManifestFile;
    rawImage?: ProofPackageManifestFile;
    screenshot?: ProofPackageManifestFile;
    captureRecord: ProofPackageManifestFile;
    canonicalContent: ProofPackageManifestFile;
    metadata: ProofPackageManifestFile;
    diagnostics?: ProofPackageManifestFile;
    lineageBundle?: ProofPackageManifestFile;
    attestationBundle?: ProofPackageManifestFile;
    proofBundle: ProofPackageManifestFile;
    receipt: ProofPackageManifestFile;
    approvalReceipt?: ProofPackageManifestFile;
    transparencyExport: ProofPackageManifestFile;
    transparencyLogEntry: ProofPackageManifestFile;
    transparencyCheckpoint: ProofPackageManifestFile;
    transparencyInclusionProof: ProofPackageManifestFile;
    operatorPublicKey: ProofPackageManifestFile;
  };
};


export type ProofPackageDiagnostics = {
  schemaVersion: number;
  artifactType?: CaptureArtifactType;
  captureId: string;
  extractorVersion: string;
  normalizationVersion?: string;
  pageKind?: PageKind;
  contentExtractionStatus?: ContentExtractionStatus;
  canonicalContent?: {
    schemaVersion?: number;
    stats?: ExtractionStats;
    diagnostics?: ExtractionDiagnostics;
  };
  metadata?: {
    schemaVersion?: number;
    fieldProvenance?: FieldProvenance;
  };
  renderedEvidence?: {
    screenshot?: {
      hash?: string;
      format?: string;
      mediaType?: string;
    };
    viewport?: RenderViewport;
    device?: {
      devicePreset?: string;
      userAgent?: string;
      userAgentLabel?: string;
    };
  };
  approval?: {
    approvalReceiptId?: string | null;
    actorAccountId?: string | null;
    approvalType?: string | null;
    approvalScope?: PdfApprovalScope | null;
    approvalMethod?: PdfApprovalMethod | null;
  };
  transparency?: {
    logEntryHash?: string;
    checkpointId?: string;
    merkleRoot?: string;
  };
  evidenceLayers?: EvidenceLayerSummary[];
  pdfQualityDiagnostics?: PdfQualityDiagnostics;
  lineageSummary?: LineageSummary;
  attestationSummary?: AttestationSummary;
};
export type AttestationVerificationSummary = AttestationSummary & {
  verifiedCount: number;
  invalidCount: number;
  unverifiedCount: number;
  trustedKeyMaterialAvailable: boolean;
};

export type ProofPackageVerificationCheck = {
  name: string;
  ok: boolean;
  details: string;
};

export type ProofPackageVerificationReport = {
  ok: boolean;
  packagePath: string;
  captureId?: string;
  checks: ProofPackageVerificationCheck[];
  attestations?: AttestationVerificationSummary;
  lineage?: LineageSummary & {
    nodes?: LineageBundle["contentObjects"];
    edges?: LineageBundle["edges"];
  };
};






export type Watchlist = {
  id: string;
  requestedUrl: string;
  normalizedRequestedUrl: string;
  intervalMinutes: number;
  intervalSeconds: number;
  status: WatchlistStatus;
  webhookUrl?: string;
  emitJson: boolean;
  expiresAt?: string;
  burstConfig?: WatchlistBurstConfig;
  lastRunAt?: string;
  lastCheckedAt?: string;
  lastSuccessfulFetchAt?: string;
  lastStateChangeAt?: string;
  lastHttpStatus?: number;
  lastResolvedUrl?: string;
  failureCount: number;
  lastErrorCode?: string;
  nextRunAt: string;
  latestRunId?: string;
  latestRun?: WatchlistRun;
  latestRunVerdict?: WatchlistRunVerdict;
  latestCaptureHealth?: WatchlistCaptureHealth;
  lastCaptureAt?: string;
  lastChangeDetectedAt?: string;
  nextScheduledRunAt?: string;
  lastSuccessfulCaptureAt?: string;
  lastSuccessfulCheckpointId?: string;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistRun = {
  id: string;
  watchlistId: string;
  captureId?: string;
  previousCaptureId?: string;
  newerCaptureId?: string;
  normalizedRequestedUrl: string;
  status: WatchlistRunStatus;
  outcome?: WatchlistFetchOutcome;
  httpStatus?: number;
  resolvedUrl?: string;
  previousResolvedUrl?: string;
  stateChanged?: boolean;
  availabilityTransition?: WatchlistAvailabilityTransition;
  redirectChanged?: boolean;
  changeDetected?: boolean;
  changeSummary: string[];
  proofBundleHashes: {
    older?: string;
    newer?: string;
  };
  checkpointIds: {
    older?: string;
    newer?: string;
  };
  comparePath?: string;
  extractionDriftDetected?: boolean;
  captureHealth?: WatchlistCaptureHealth;
  notificationSummary?: {
    total: number;
    localRecorded: number;
    jsonRecorded: number;
    webhookSent: number;
    webhookFailed: number;
  };
  deliveries?: WatchlistNotificationDelivery[];
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
};

export type WatchlistNotificationDelivery = {
  id: string;
  watchlistRunId: string;
  kind: WatchlistDeliveryKind;
  status: WatchlistDeliveryStatus;
  target?: string;
  payload: WatchlistResultPayload;
  responseStatus?: number;
  errorMessage?: string;
  createdAt: string;
};

export type WatchlistResultPayload = {
  schemaVersion: number;
  eventType: WatchlistEventType;
  watchlistId: string;
  watchlistRunId: string;
  watchedUrl: string;
  normalizedRequestedUrl: string;
  runTimestamp: string;
  verdict: WatchlistRunVerdict;
  outcome?: WatchlistFetchOutcome;
  httpStatus?: number;
  resolvedUrl?: string;
  previousResolvedUrl?: string;
  stateChanged?: boolean;
  availabilityTransition?: WatchlistAvailabilityTransition;
  redirectChanged?: boolean;
  comparePath?: string;
  comparePermalink?: string;
  olderCaptureId?: string;
  newerCaptureId?: string;
  changeDetected: boolean;
  changedFields: {
    canonicalContentHashChanged: boolean;
    metadataHashChanged: boolean;
    titleChanged: boolean;
    authorChanged: boolean;
    claimedPublishedAtChanged: boolean;
    pageKindChanged: boolean;
    extractorVersionChanged: boolean;
  };
  conciseSummary: string;
  changeSummary: string[];
  proofBundleHashes: {
    older?: string;
    newer?: string;
  };
  checkpointIds: {
    older?: string;
    newer?: string;
  };
  latestCheckpointId?: string;
  captureHealth?: WatchlistCaptureHealth;
  extractionDriftDetected?: boolean;
  screenshotPresent?: boolean;
  screenshotHash?: string;
  deliveryKind?: WatchlistDeliveryKind;
  deliveryTarget?: string;
  deliveryError?: string;
  emittedAt: string;
};




export * from "./attestations.js";
export * from "./lineage.js";








