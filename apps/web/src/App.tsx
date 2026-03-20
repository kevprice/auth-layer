
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";

import type {
  CanonicalBlock,
  CaptureArtifactType,
  CaptureComparison,
  CaptureDetail,
  CaptureRecord,
  CaptureScope,
  EvidenceLayerSummary,
  ExtractedFieldSource,
  FieldProvenance,
  OperatorPublicKey,
  PdfQualityDiagnostics,
  RenderedEvidence,
  Watchlist,
  WatchlistNotificationDelivery,
  WatchlistResultPayload,
  WatchlistRun
} from "@auth-layer/shared";

import { artifactUrl, createCapture, createImageCapture, createPdfCapture, createWatchlist, getCapture, getCaptureComparison, getCaptureHistory, getOperatorPublicKey, getWatchlistRuns, listWatchlists, retryWatchlist, testWatchlistWebhook, updateWatchlist } from "./api";
import { VerifierView } from "./VerifierView";

type Route =
  | { kind: "home" }
  | { kind: "verify" }
  | { kind: "capture"; id: string }
  | { kind: "history"; url: string }
  | { kind: "compare"; url: string; fromCaptureId: string; toCaptureId: string }
  | { kind: "watchlists" }
  | { kind: "watchlist"; id: string };

type ScopeRow = {
  label: string;
  value: string;
};

type ComparisonBadge = {
  label: string;
  changed: boolean | undefined;
};
type VerificationAppendixSubject = {
  captureId: string;
  observedAt: string;
  artifactType?: CaptureArtifactType;
  screenshotCaptured: boolean;
  screenshotHash?: string;
  screenshotFormat?: string;
  viewport: string;
  devicePreset: string;
  userAgent: string;
  pdfQualityDiagnostics?: PdfQualityDiagnostics;
  proofBundleHash?: string;
  transparencyCheckpointId?: string;
  transparencyLogEntryHash?: string;
  merkleRoot?: string;
};

type ComparisonReport = {
  schemaVersion: number;
  reportType: "capture-comparison-report";
  generatedAt: string;
  normalizedRequestedUrl: string;
  permalink: string;
  comparison: CaptureComparison;
  whatThisProves: string[];
  whatThisDoesNotProve: string[];
  evidenceLayers: EvidenceLayerSummary[];
  verificationAppendix: {
    verificationOrder: string[];
    older: VerificationAppendixSubject;
    newer: VerificationAppendixSubject;
  };
  operatorKey?: Pick<OperatorPublicKey, "operatorId" | "keyId" | "publicKeySha256" | "algorithm">;
  verificationFooter: {
    older: {
      captureId: string;
      observedAt: string;
      proofBundleHash?: string;
      transparencyCheckpointId?: string;
      transparencyLogEntryHash?: string;
      merkleRoot?: string;
    };
    newer: {
      captureId: string;
      observedAt: string;
      proofBundleHash?: string;
      transparencyCheckpointId?: string;
      transparencyLogEntryHash?: string;
      merkleRoot?: string;
    };
  };
};

const parseRoute = (hash: string): Route => {
  const cleanedHash = hash.replace(/^#/, "");
  const parts = cleanedHash.split("/").filter(Boolean);

  if (parts[0] === "verify") {
    return { kind: "verify" };
  }

  if (parts[0] === "captures" && parts[1]) {
    return { kind: "capture", id: parts[1] };
  }

  if (parts[0] === "history" && parts[1]) {
    return { kind: "history", url: decodeURIComponent(parts[1]) };
  }

  if (parts[0] === "watchlists" && parts[1]) {
    return { kind: "watchlist", id: parts[1] };
  }

  if (parts[0] === "watchlists") {
    return { kind: "watchlists" };
  }

  if (parts[0] === "compare" && parts[1] && parts[2] && parts[3]) {
    return {
      kind: "compare",
      url: decodeURIComponent(parts[1]),
      fromCaptureId: parts[2],
      toCaptureId: parts[3]
    };
  }

  return { kind: "home" };
};

const formatTimestamp = (value?: string): string => {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
};

const formatPercent = (value?: number): string => {
  if (value === undefined) {
    return "Pending";
  }

  return `${Math.round(value * 100)}%`;
};

const statusLabel = (status: CaptureRecord["status"]): string =>
  ({
    queued: "Queued",
    fetching: "Fetching",
    extracting: "Extracting",
    hashing: "Hashing",
    timestamping: "Timestamping",
    completed: "Completed",
    failed: "Failed"
  })[status];

const renderChangeLabel = (value: boolean | undefined, positiveLabel: string, stableLabel: string): string => {
  if (value === undefined) {
    return "Baseline capture";
  }

  return value ? positiveLabel : stableLabel;
};

const sourceLabel = (source: ExtractedFieldSource | undefined): string => {
  if (!source) {
    return "Pending";
  }

  return `${source.sourceKind} - ${source.strategy}`;
};

const toYesNo = (value: boolean): string => (value ? "Yes" : "No");

const renderedEvidenceScreenshotHash = (renderedEvidence?: CaptureDetail["capture"]["renderedEvidence"] | CaptureRecord["renderedEvidence"]): string | undefined =>
  renderedEvidence?.screenshot?.hash ?? renderedEvidence?.screenshotHash;

const renderedEvidenceScreenshotFormat = (renderedEvidence?: CaptureDetail["capture"]["renderedEvidence"] | CaptureRecord["renderedEvidence"]): string =>
  renderedEvidence?.screenshot?.format?.toUpperCase() ?? "PNG";

const renderedEvidenceDevicePreset = (renderedEvidence?: CaptureDetail["capture"]["renderedEvidence"] | CaptureRecord["renderedEvidence"]): string =>
  renderedEvidence?.device?.devicePreset ?? "Not recorded";

const renderedEvidenceUserAgent = (renderedEvidence?: CaptureDetail["capture"]["renderedEvidence"] | CaptureRecord["renderedEvidence"]): string =>
  renderedEvidence?.device?.userAgent ?? renderedEvidence?.device?.userAgentLabel ?? renderedEvidence?.userAgentLabel ?? "Not recorded";

const renderedEvidenceUserAgentLabel = (renderedEvidence?: CaptureDetail["capture"]["renderedEvidence"] | CaptureRecord["renderedEvidence"]): string =>
  renderedEvidence?.device?.userAgentLabel ?? renderedEvidence?.userAgentLabel ?? "Not recorded";

const formatViewport = (renderedEvidence?: CaptureDetail["capture"]["renderedEvidence"] | CaptureRecord["renderedEvidence"]): string => {
  if (!renderedEvidence?.viewport) {
    return "Not recorded";
  }

  const ratio = renderedEvidence.viewport.pixelRatio ? ` @ ${renderedEvidence.viewport.pixelRatio}x` : "";
  return `${renderedEvidence.viewport.width} x ${renderedEvidence.viewport.height}${ratio}`;
};

const documentDateLabel = (artifactType?: CaptureArtifactType): string =>
  artifactType === "pdf-file" ? "Document creation date (PDF metadata)" : "Claimed published at (page metadata)";

const pageKindLabel = (artifactType?: CaptureArtifactType, pageKind?: string): string => {
  if (artifactType === "pdf-file") {
    return pageKind === "failed" ? "Failed" : "pdf-document";
  }

  return pageKind ?? "Pending";
};

const hasLowQualityPdfText = (canonicalContent?: CaptureDetail["canonicalContent"], diagnostics?: PdfQualityDiagnostics): boolean => {
  if (!canonicalContent || canonicalContent.artifactType !== "pdf-file") {
    return false;
  }

  const body = canonicalContent.bodyMarkdown ?? "";
  const suspiciousCharacters = (body.match(/[^\x20-\x7E\n\r\t]/g) ?? []).length;
  return Boolean(diagnostics?.likelyScannedImageOnly) || body.trim().length < 80 || suspiciousCharacters > Math.max(4, Math.floor(body.length * 0.08));
};

const canonicalSummaryText = (capture: CaptureRecord, canonicalContent?: CaptureDetail["canonicalContent"], diagnostics?: PdfQualityDiagnostics): string => {
  if (!canonicalContent) {
    return "Canonical content is not available yet.";
  }

  if (capture.artifactType === "image-file") {
    return canonicalContent.imageObject?.caption ?? canonicalContent.imageObject?.altText ?? "This image capture preserves exact file integrity and any packaged image metadata.";
  }

  if (capture.artifactType === "pdf-file" && hasLowQualityPdfText(canonicalContent, diagnostics)) {
    return "Extracted text is sparse or low-quality. This PDF may be scanned, image-based, or contain minimal readable embedded text.";
  }

  return formatBlockPreview(canonicalContent.blocks);
};



const verificationOrder = [
  "Verify proof package integrity.",
  "Verify the Merkle inclusion proof.",
  "Verify the signed checkpoint against a trusted operator key.",
  "Optionally verify the PDF approval receipt when present."
];

const derivePdfQualityDiagnostics = (input: {
  artifactType?: CaptureArtifactType;
  canonicalContent?: CaptureDetail["canonicalContent"] | CaptureComparison["older"]["canonicalContent"];
  metadata?: CaptureDetail["metadata"] | CaptureComparison["older"]["metadata"];
}): PdfQualityDiagnostics | undefined => {
  if (input.artifactType !== "pdf-file") {
    return undefined;
  }

  const textAvailable = input.canonicalContent?.textAvailable ?? input.metadata?.textAvailable ?? false;
  const extractedCharacterCount = input.canonicalContent?.stats.characterCount ?? input.canonicalContent?.bodyMarkdown.trim().length ?? 0;

  return {
    embeddedTextDetected: textAvailable,
    extractedCharacterCount,
    metadataExtracted: Boolean(input.metadata),
    likelyScannedImageOnly: !textAvailable || extractedCharacterCount <= 32
  };
};

const buildEvidenceLayers = (input: {
  artifactType?: CaptureArtifactType;
  rawSnapshotHash?: string;
  canonicalContentHash?: string;
  metadataHash?: string;
  proofBundleHash?: string;
  renderedEvidence?: RenderedEvidence;
  screenshotStorageKey?: string;
  approvalReceiptId?: string | null;
}): EvidenceLayerSummary[] => {
  const isPdf = input.artifactType === "pdf-file";
  const screenshotHash = renderedEvidenceScreenshotHash(input.renderedEvidence);

  return [
    {
      id: "raw-snapshot",
      label: "Raw snapshot",
      available: Boolean(input.rawSnapshotHash),
      proves: isPdf
        ? "The exact uploaded PDF bytes were preserved as observed by the operator."
        : "The exact fetched response body was preserved as observed by the operator.",
      doesNotProve: isPdf
        ? "It does not prove who originally created the document or when it was first authored."
        : "It does not prove when the publisher originally created the page or what changed before capture.",
      hashReference: input.rawSnapshotHash,
      exportReference: isPdf ? "raw-snapshot.json + source-file.pdf" : "raw-snapshot.json + raw-snapshot.html"
    },
    {
      id: "canonical-content",
      label: "Canonical content",
      available: Boolean(input.canonicalContentHash),
      proves: "Deterministic extracted content can be compared across captures without relying on full-page HTML equality.",
      doesNotProve: "It does not prove publisher intent, authorship, or the truth of extracted statements.",
      hashReference: input.canonicalContentHash,
      exportReference: "canonical-content.json"
    },
    {
      id: "metadata",
      label: "Metadata",
      available: Boolean(input.metadataHash),
      proves: "Normalized citation-like fields such as title, author, and claimed publication date were extracted and hashed separately.",
      doesNotProve: "It does not independently validate the truth of claimed author or claimed publication date fields.",
      hashReference: input.metadataHash,
      exportReference: "metadata.json"
    },
    {
      id: "rendered-evidence",
      label: "Rendered evidence",
      available: Boolean(input.renderedEvidence || input.screenshotStorageKey),
      proves: "When present, the screenshot records what the operator-rendered page looked like under the recorded viewport and device settings.",
      doesNotProve: "It does not replace raw snapshot or canonical content proof, and screenshot equality is not expected across captures.",
      hashReference: screenshotHash,
      exportReference: input.screenshotStorageKey ? "rendered-screenshot.png" : undefined
    },
    {
      id: "operator-observation",
      label: "Operator observation",
      available: Boolean(input.proofBundleHash),
      proves: "The operator observed, hashed, and packaged this capture and linked it to a transparency checkpoint.",
      doesNotProve: "It does not prove original publisher intent, original creation time, or uploader approval.",
      hashReference: input.proofBundleHash,
      exportReference: "proof-bundle.json + transparency-export.json"
    },
    {
      id: "uploader-approval",
      label: "Uploader approval",
      available: Boolean(input.approvalReceiptId),
      proves: "When present, the uploader approved the exact PDF hash recorded in the approval receipt.",
      doesNotProve: "It is optional provenance and is not required to verify the operator observation.",
      exportReference: input.approvalReceiptId ? "approval-receipt.json" : undefined
    }
  ];
};

const buildVerificationAppendixSubject = (input: CaptureComparison["older"] | CaptureComparison["newer"]): VerificationAppendixSubject => ({
  captureId: input.capture.id,
  observedAt: input.observedAt,
  artifactType: input.capture.artifactType,
  screenshotCaptured: Boolean(input.capture.renderedEvidence || input.capture.artifacts.screenshotStorageKey),
  screenshotHash: renderedEvidenceScreenshotHash(input.capture.renderedEvidence),
  screenshotFormat: input.capture.renderedEvidence?.screenshot?.format?.toUpperCase(),
  viewport: formatViewport(input.capture.renderedEvidence),
  devicePreset: renderedEvidenceDevicePreset(input.capture.renderedEvidence),
  userAgent: renderedEvidenceUserAgent(input.capture.renderedEvidence),
  pdfQualityDiagnostics: derivePdfQualityDiagnostics({
    artifactType: input.capture.artifactType,
    canonicalContent: input.canonicalContent,
    metadata: input.metadata
  }),
  proofBundleHash: input.capture.proofBundleHash,
  transparencyCheckpointId: input.receipt?.transparencyCheckpointId,
  transparencyLogEntryHash: input.receipt?.transparencyLogEntryHash,
  merkleRoot: input.receipt?.merkleRoot
});

const scopeToRows = (scope: CaptureScope): ScopeRow[] => [
  { label: "Raw HTTP body preserved", value: toYesNo(scope.rawHttpBodyPreserved) },
  ...(scope.rawFilePreserved !== undefined ? [{ label: "Raw file preserved", value: toYesNo(scope.rawFilePreserved) }] : []),
  { label: "Canonical content extracted", value: toYesNo(scope.canonicalContentExtracted) },
  { label: "Metadata extracted", value: toYesNo(scope.metadataExtracted) },
  { label: "Screenshot preserved", value: toYesNo(scope.screenshotPreserved) },
  { label: "JS-rendered DOM preserved", value: toYesNo(scope.renderedDomPreserved) }
];

const buildCaptureScope = (detail: CaptureDetail): ScopeRow[] =>
  scopeToRows(
    detail.proofBundle?.captureScope ?? {
      rawHttpBodyPreserved: Boolean(detail.capture.artifacts.rawHtmlStorageKey),
      canonicalContentExtracted: Boolean(detail.capture.artifacts.canonicalContentStorageKey),
      metadataExtracted: Boolean(detail.capture.artifacts.metadataStorageKey),
      rawFilePreserved: Boolean(detail.capture.artifacts.rawPdfStorageKey),
      screenshotPreserved: Boolean(detail.capture.artifacts.screenshotStorageKey),
      renderedDomPreserved: false
    }
  );

const buildComparisonBadges = (capture: CaptureRecord): ComparisonBadge[] => {
  if (!capture.comparedToCaptureId) {
    return [];
  }

  return [
    {
      label: renderChangeLabel(capture.contentChangedFromPrevious, "Semantic content changed", "Semantic content stable"),
      changed: capture.contentChangedFromPrevious
    },
    {
      label: renderChangeLabel(capture.metadataChangedFromPrevious, "Metadata changed", "Metadata stable"),
      changed: capture.metadataChangedFromPrevious
    },
    {
      label: renderChangeLabel(capture.titleChangedFromPrevious, "Title changed", "Title stable"),
      changed: capture.titleChangedFromPrevious
    },
    {
      label: renderChangeLabel(capture.authorChangedFromPrevious, "Author changed", "Author stable"),
      changed: capture.authorChangedFromPrevious
    },
    {
      label: renderChangeLabel(
        capture.claimedPublishedAtChangedFromPrevious,
        "Claimed publish date changed",
        "Claimed publish date stable"
      ),
      changed: capture.claimedPublishedAtChangedFromPrevious
    }
  ];
};

const comparisonFieldRows = (comparison: CaptureComparison): ScopeRow[] => {
  const artifactType = comparison.newer.capture.artifactType ?? comparison.older.capture.artifactType;

  return [
    { label: "Canonical content hash changed", value: toYesNo(comparison.fields.canonicalContentHashChanged) },
    { label: "Metadata hash changed", value: toYesNo(comparison.fields.metadataHashChanged) },
    { label: "Title changed", value: toYesNo(comparison.fields.titleChanged) },
    { label: "Author changed", value: toYesNo(comparison.fields.authorChanged) },
    { label: documentDateLabel(artifactType) + " changed", value: toYesNo(comparison.fields.claimedPublishedAtChanged) },
    { label: (artifactType === "pdf-file" ? "Document kind" : "Page kind") + " changed", value: toYesNo(comparison.fields.pageKindChanged) },
    { label: "Extractor version changed", value: toYesNo(comparison.fields.extractorVersionChanged) }
  ];
};

const formatComparisonValue = (value?: string): string => (value && value.trim().length > 0 ? value : "Not detected");

const comparisonValueRows = (
  comparison: CaptureComparison
): Array<{ label: string; older: string; newer: string }> => [
  {
    label: "Title",
    older: formatComparisonValue(comparison.older.metadata?.title ?? comparison.older.canonicalContent?.title),
    newer: formatComparisonValue(comparison.newer.metadata?.title ?? comparison.newer.canonicalContent?.title)
  },
  {
    label: "Author",
    older: formatComparisonValue(comparison.older.metadata?.author ?? comparison.older.canonicalContent?.author),
    newer: formatComparisonValue(comparison.newer.metadata?.author ?? comparison.newer.canonicalContent?.author)
  },
  {
    label: documentDateLabel(comparison.newer.capture.artifactType ?? comparison.older.capture.artifactType),
    older: formatTimestamp(
      comparison.older.metadata?.publishedAtClaimed ?? comparison.older.canonicalContent?.publishedAtClaimed ?? comparison.older.capture.claimedPublishedAt
    ),
    newer: formatTimestamp(
      comparison.newer.metadata?.publishedAtClaimed ?? comparison.newer.canonicalContent?.publishedAtClaimed ?? comparison.newer.capture.claimedPublishedAt
    )
  },
  {
    label: (comparison.newer.capture.artifactType ?? comparison.older.capture.artifactType) === "pdf-file" ? "Document kind" : "Page kind",
    older: pageKindLabel(comparison.older.capture.artifactType, comparison.older.capture.pageKind),
    newer: pageKindLabel(comparison.newer.capture.artifactType, comparison.newer.capture.pageKind)
  },
  {
    label: "Extractor version",
    older: formatComparisonValue(comparison.older.canonicalContent?.extractorVersion ?? comparison.older.capture.extractorVersion),
    newer: formatComparisonValue(comparison.newer.canonicalContent?.extractorVersion ?? comparison.newer.capture.extractorVersion)
  }
];

const watchlistVerdictLabel = (verdict?: Watchlist["latestRunVerdict"]): string =>
  verdict === "changed"
    ? "Change detected"
    : verdict === "failed"
      ? "Run failed"
      : verdict === "baseline"
        ? "Baseline observation"
        : verdict === "unchanged"
          ? "No change detected"
          : "Awaiting runs";

const watchlistHealthLabel = (health?: Watchlist["latestCaptureHealth"] | WatchlistRun["captureHealth"]): string =>
  health === "success"
    ? "Healthy extraction"
    : health === "degraded"
      ? "Degraded extraction"
      : health === "failed"
        ? "Failed extraction"
        : "Health pending";

const watchlistEventLabel = (eventType?: WatchlistNotificationDelivery["payload"]["eventType"]): string =>
  eventType === "watchlist.change.detected"
    ? "Change detected event"
    : eventType === "watchlist.run.failed"
      ? "Run failed event"
      : eventType === "watchlist.delivery.failed"
        ? "Delivery failed event"
        : eventType === "watchlist.run.completed"
          ? "Run completed event"
          : "Watchlist event";

const watchlistOutcomeLabel = (outcome?: WatchlistRun["outcome"] | WatchlistResultPayload["outcome"]): string =>
  outcome === "ok_changed"
    ? "Content changed"
    : outcome === "ok_unchanged"
      ? "Content unchanged"
      : outcome === "redirected"
        ? "Redirect observed"
        : outcome === "not_found"
          ? "404 not found"
          : outcome === "gone"
            ? "410 gone"
            : outcome === "blocked"
              ? "Blocked"
              : outcome === "server_error"
                ? "Server error"
                : outcome === "network_error"
                  ? "Network error"
                  : outcome === "timeout"
                    ? "Timed out"
                    : outcome === "content_type_changed"
                      ? "Content type changed"
                      : "Outcome pending";

const formatBlockPreview = (blocks: CanonicalBlock[] | undefined): string => {
  if (!blocks || blocks.length === 0) {
    return "Canonical content is not available yet.";
  }

  return blocks
    .slice(0, 3)
    .map((block) => block.text)
    .join("\n\n");
};

const comparisonWhatThisProves = [
  "These two captures refer to the same normalized URL and were observed by this system at the recorded times.",
  "The reported differences come from stored canonical content, metadata artifacts, and recorded hashes for those two captures.",
  "The proof bundle hashes and transparency references shown in the footer can be checked against the stored evidence for each capture."
];

const comparisonWhatThisDoesNotProve = [
  "Why the publisher changed the page.",
  "When the publisher originally created the page or any individual paragraph.",
  "That the page had the same content before the older observed capture.",
  "That any claimed author or claimed publication date is true."
];

const comparisonPermalink = (comparison: CaptureComparison, normalizedUrl?: string): string => {
  const path = `#/compare/${encodeURIComponent(normalizedUrl ?? comparison.normalizedRequestedUrl)}/${comparison.older.capture.id}/${comparison.newer.capture.id}`;
  return `${window.location.origin}${window.location.pathname}${path}`;
};

const buildComparisonReport = (
  comparison: CaptureComparison,
  normalizedUrl: string | undefined,
  operatorKey?: OperatorPublicKey
): ComparisonReport => ({
  schemaVersion: 1,
  reportType: "capture-comparison-report",
  generatedAt: new Date().toISOString(),
  normalizedRequestedUrl: normalizedUrl ?? comparison.normalizedRequestedUrl,
  permalink: comparisonPermalink(comparison, normalizedUrl),
  comparison,
  whatThisProves: comparisonWhatThisProves,
  whatThisDoesNotProve: comparisonWhatThisDoesNotProve,
  evidenceLayers: buildEvidenceLayers({
    artifactType: comparison.newer.capture.artifactType ?? comparison.older.capture.artifactType,
    rawSnapshotHash: comparison.newer.capture.rawSnapshotHash ?? comparison.older.capture.rawSnapshotHash,
    canonicalContentHash: comparison.newer.capture.canonicalContentHash ?? comparison.older.capture.canonicalContentHash,
    metadataHash: comparison.newer.capture.metadataHash ?? comparison.older.capture.metadataHash,
    proofBundleHash: comparison.newer.capture.proofBundleHash ?? comparison.older.capture.proofBundleHash,
    renderedEvidence: comparison.newer.capture.renderedEvidence ?? comparison.older.capture.renderedEvidence,
    screenshotStorageKey: comparison.newer.capture.artifacts.screenshotStorageKey ?? comparison.older.capture.artifacts.screenshotStorageKey,
    approvalReceiptId: comparison.newer.capture.approvalReceiptId ?? comparison.older.capture.approvalReceiptId
  }),
  verificationAppendix: {
    verificationOrder,
    older: buildVerificationAppendixSubject(comparison.older),
    newer: buildVerificationAppendixSubject(comparison.newer)
  },
  operatorKey: operatorKey
    ? {
        operatorId: operatorKey.operatorId,
        keyId: operatorKey.keyId,
        publicKeySha256: operatorKey.publicKeySha256,
        algorithm: operatorKey.algorithm
      }
    : undefined,
  verificationFooter: {
    older: {
      captureId: comparison.older.capture.id,
      observedAt: comparison.older.observedAt,
      proofBundleHash: comparison.older.capture.proofBundleHash,
      transparencyCheckpointId: comparison.older.receipt?.transparencyCheckpointId,
      transparencyLogEntryHash: comparison.older.receipt?.transparencyLogEntryHash,
      merkleRoot: comparison.older.receipt?.merkleRoot
    },
    newer: {
      captureId: comparison.newer.capture.id,
      observedAt: comparison.newer.observedAt,
      proofBundleHash: comparison.newer.capture.proofBundleHash,
      transparencyCheckpointId: comparison.newer.receipt?.transparencyCheckpointId,
      transparencyLogEntryHash: comparison.newer.receipt?.transparencyLogEntryHash,
      merkleRoot: comparison.newer.receipt?.merkleRoot
    }
  }
});

const comparisonSummaryText = (report: ComparisonReport): string => {
  const comparison = report.comparison;
  const trackedChangeCount = Object.values(comparison.fields).filter(Boolean).length;
  const hasBlockChanges =
    comparison.blockSummary.paragraphsAdded > 0 ||
    comparison.blockSummary.paragraphsRemoved > 0 ||
    comparison.blockSummary.headingsChanged > 0;
  const hasExtractionDrift = comparison.diagnostics.notes.length > 0;

  if (trackedChangeCount === 0 && !hasBlockChanges && !hasExtractionDrift) {
    return [
      `Compared captures from ${formatTimestamp(comparison.older.observedAt)} and ${formatTimestamp(comparison.newer.observedAt)} for ${report.normalizedRequestedUrl}.`,
      "No tracked differences were detected in semantic content, metadata, title, author, claimed published date (page metadata), page kind, or extractor version.",
      "No block changes or extraction-drift notes were generated.",
      `Permalink: ${report.permalink}`
    ].join(" ");
  }

  return [
    `Compared captures from ${formatTimestamp(comparison.older.observedAt)} and ${formatTimestamp(comparison.newer.observedAt)} for ${report.normalizedRequestedUrl}.`,
    `Detected changes in ${trackedChangeCount} of 7 tracked fields.`,
    ...comparison.changeSummary,
    `Permalink: ${report.permalink}`
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
};

const comparisonFileStem = (report: ComparisonReport): string =>
  `comparison-report-${report.comparison.older.capture.id}-${report.comparison.newer.capture.id}`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const buildComparisonReportHtml = (report: ComparisonReport): string => {
  const bulletList = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const summaryList = report.comparison.changeSummary.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const evidenceLayerBlocks = report.evidenceLayers
    .map(
      (layer) => `
        <section class="card">
          <h3>${escapeHtml(layer.label)}</h3>
          <p><strong>Availability:</strong> ${escapeHtml(layer.available ? "Available" : "Not captured")}</p>
          <p><strong>What this proves:</strong> ${escapeHtml(layer.proves)}</p>
          <p><strong>What this does not prove:</strong> ${escapeHtml(layer.doesNotProve)}</p>
          <p><strong>Hash reference:</strong> ${escapeHtml(layer.hashReference ?? "Not applicable")}</p>
          <p><strong>Exported as:</strong> ${escapeHtml(layer.exportReference ?? "Not exported separately")}</p>
        </section>`
    )
    .join("");
  const appendixBlock = (label: string, appendix: VerificationAppendixSubject) => `
    <section>
      <h3>${escapeHtml(label)}</h3>
      <dl>
        <dt>Capture ID</dt><dd>${escapeHtml(appendix.captureId)}</dd>
        <dt>Observed at</dt><dd>${escapeHtml(formatTimestamp(appendix.observedAt))}</dd>
        <dt>Screenshot captured</dt><dd>${escapeHtml(appendix.screenshotCaptured ? "Yes" : "No")}</dd>
        <dt>Screenshot hash</dt><dd>${escapeHtml(appendix.screenshotHash ?? "Not recorded")}</dd>
        <dt>Screenshot format</dt><dd>${escapeHtml(appendix.screenshotFormat ?? "Not recorded")}</dd>
        <dt>Viewport</dt><dd>${escapeHtml(appendix.viewport)}</dd>
        <dt>Device preset</dt><dd>${escapeHtml(appendix.devicePreset)}</dd>
        <dt>User agent</dt><dd>${escapeHtml(appendix.userAgent)}</dd>
        <dt>PDF embedded text detected</dt><dd>${escapeHtml(appendix.pdfQualityDiagnostics ? (appendix.pdfQualityDiagnostics.embeddedTextDetected ? "Yes" : "No") : "Not applicable")}</dd>
        <dt>PDF extracted characters</dt><dd>${escapeHtml(appendix.pdfQualityDiagnostics ? String(appendix.pdfQualityDiagnostics.extractedCharacterCount) : "Not applicable")}</dd>
        <dt>PDF metadata extracted</dt><dd>${escapeHtml(appendix.pdfQualityDiagnostics ? (appendix.pdfQualityDiagnostics.metadataExtracted ? "Yes" : "No") : "Not applicable")}</dd>
        <dt>Likely scanned or image-only</dt><dd>${escapeHtml(appendix.pdfQualityDiagnostics ? (appendix.pdfQualityDiagnostics.likelyScannedImageOnly ? "Yes" : "No") : "Not applicable")}</dd>
        <dt>Proof bundle hash</dt><dd>${escapeHtml(appendix.proofBundleHash ?? "Not available")}</dd>
        <dt>Checkpoint</dt><dd>${escapeHtml(appendix.transparencyCheckpointId ?? "Not available")}</dd>
        <dt>Log entry</dt><dd>${escapeHtml(appendix.transparencyLogEntryHash ?? "Not available")}</dd>
        <dt>Merkle root</dt><dd>${escapeHtml(appendix.merkleRoot ?? "Not available")}</dd>
      </dl>
    </section>`;
  const footerBlock = (label: string, footer: ComparisonReport["verificationFooter"]["older"]) => `
    <section>
      <h3>${escapeHtml(label)}</h3>
      <dl>
        <dt>Capture ID</dt><dd>${escapeHtml(footer.captureId)}</dd>
        <dt>Observed at</dt><dd>${escapeHtml(formatTimestamp(footer.observedAt))}</dd>
        <dt>Proof bundle hash</dt><dd>${escapeHtml(footer.proofBundleHash ?? "Not available")}</dd>
        <dt>Checkpoint</dt><dd>${escapeHtml(footer.transparencyCheckpointId ?? "Not available")}</dd>
        <dt>Log entry</dt><dd>${escapeHtml(footer.transparencyLogEntryHash ?? "Not available")}</dd>
        <dt>Merkle root</dt><dd>${escapeHtml(footer.merkleRoot ?? "Not available")}</dd>
      </dl>
    </section>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(report.normalizedRequestedUrl)} comparison report</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; color: #16202f; margin: 2rem auto; max-width: 960px; line-height: 1.6; }
      h1, h2, h3 { margin-bottom: 0.4rem; }
      .card { border: 1px solid #d9dee4; border-radius: 16px; padding: 1rem 1.2rem; margin-bottom: 1rem; }
      .muted { color: #556577; }
      ul, ol { padding-left: 1.2rem; }
      code, pre, dd { word-break: break-word; }
      dl { display: grid; grid-template-columns: 220px 1fr; gap: 0.4rem 1rem; }
      dt { font-weight: 700; }
      pre { white-space: pre-wrap; background: #f7f3ea; padding: 1rem; border-radius: 12px; }
    </style>
  </head>
  <body>
    <header class="card">
      <p class="muted">Shareable comparison report</p>
      <h1>${escapeHtml(report.normalizedRequestedUrl)}</h1>
      <p>${escapeHtml(report.comparison.observationStatement)}</p>
      <p class="muted">Generated at ${escapeHtml(formatTimestamp(report.generatedAt))}</p>
    </header>
    <section class="card">
      <h2>Report view</h2>
      <p>${escapeHtml(comparisonSummaryText(report))}</p>
    </section>
    <section class="card">
      <h2>What this proves</h2>
      <ul>${bulletList(report.whatThisProves)}</ul>
    </section>
    <section class="card">
      <h2>What this does not prove</h2>
      <ul>${bulletList(report.whatThisDoesNotProve)}</ul>
    </section>
    <section class="card">
      <h2>Evidence layers</h2>
      ${evidenceLayerBlocks}
    </section>
    <section class="card">
      <h2>Change summary</h2>
      <ul>${summaryList}</ul>
    </section>
    <section class="card">
      <h2>Detailed diff</h2>
      <h3>Older canonical preview</h3>
      <pre>${escapeHtml(formatBlockPreview(report.comparison.older.canonicalContent?.blocks))}</pre>
      <h3>Newer canonical preview</h3>
      <pre>${escapeHtml(formatBlockPreview(report.comparison.newer.canonicalContent?.blocks))}</pre>
    </section>
    <section class="card">
      <h2>Verification appendix</h2>
      <ol>${bulletList(report.verificationAppendix.verificationOrder)}</ol>
      ${appendixBlock("Older observed capture", report.verificationAppendix.older)}
      ${appendixBlock("Newer observed capture", report.verificationAppendix.newer)}
    </section>
    <section class="card">
      <h2>Verification footer</h2>
      ${footerBlock("Older capture", report.verificationFooter.older)}
      ${footerBlock("Newer capture", report.verificationFooter.newer)}
      <section>
        <h3>Operator key</h3>
        <dl>
          <dt>Operator ID</dt><dd>${escapeHtml(report.operatorKey?.operatorId ?? "Not available")}</dd>
          <dt>Key ID</dt><dd>${escapeHtml(report.operatorKey?.keyId ?? "Not available")}</dd>
          <dt>Fingerprint</dt><dd>${escapeHtml(report.operatorKey?.publicKeySha256 ?? "Not available")}</dd>
          <dt>Algorithm</dt><dd>${escapeHtml(report.operatorKey?.algorithm ?? "Not available")}</dd>
        </dl>
      </section>
    </section>
  </body>
</html>`;
};
const downloadTextFile = (filename: string, content: string, mediaType: string): void => {
  const blob = new Blob([content], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
};
const FieldSourceList = ({ provenance, artifactType }: { provenance?: FieldProvenance; artifactType?: CaptureArtifactType }) => {
  const entries: Array<[string, ExtractedFieldSource | undefined]> = [
    ["Title", provenance?.title],
    ["Subtitle", provenance?.subtitle],
    ["Author", provenance?.author],
    [artifactType === "pdf-file" ? "Document creation date (PDF metadata)" : "Claimed published at (page metadata)", provenance?.publishedAtClaimed],
    ["Canonical URL", provenance?.canonicalUrl]
  ];

  return (
    <div className="field-grid">
      {entries.map(([label, source]) => (
        <div key={label} className="field-grid__row">
          <span>{label}</span>
          <strong>{sourceLabel(source)}</strong>
        </div>
      ))}
    </div>
  );
};


const EvidenceLayersSection = ({ layers }: { layers: EvidenceLayerSummary[] }) => (
  <div className="warning-stack">
    {layers.map((layer) => (
      <div key={layer.id} className="details-card">
        <div className="field-grid">
          <div className="field-grid__row">
            <span>{layer.label}</span>
            <strong>{layer.available ? "Available" : "Not captured"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Hash reference</span>
            <strong>{layer.hashReference ?? "Not applicable"}</strong>
          </div>
          <div className="field-grid__row field-grid__row--wide">
            <span>What this proves</span>
            <strong>{layer.proves}</strong>
          </div>
          <div className="field-grid__row field-grid__row--wide">
            <span>What this does not prove</span>
            <strong>{layer.doesNotProve}</strong>
          </div>
          <div className="field-grid__row field-grid__row--wide">
            <span>Exported as</span>
            <strong>{layer.exportReference ?? "Not exported separately"}</strong>
          </div>
        </div>
      </div>
    ))}
  </div>
);

const PdfQualityDiagnosticsSection = ({ diagnostics }: { diagnostics?: PdfQualityDiagnostics }) => {
  if (!diagnostics) {
    return <p className="notice">No PDF extraction-quality diagnostics apply to this capture.</p>;
  }

  return (
    <>
      <div className="field-grid">
        <div className="field-grid__row">
          <span>Embedded text detected</span>
          <strong>{toYesNo(diagnostics.embeddedTextDetected)}</strong>
        </div>
        <div className="field-grid__row">
          <span>Extracted text character count</span>
          <strong>{diagnostics.extractedCharacterCount}</strong>
        </div>
        <div className="field-grid__row">
          <span>Metadata extracted</span>
          <strong>{toYesNo(diagnostics.metadataExtracted)}</strong>
        </div>
        <div className="field-grid__row">
          <span>Likely scanned or image-only</span>
          <strong>{toYesNo(diagnostics.likelyScannedImageOnly)}</strong>
        </div>
      </div>
      <p className="notice">These quality signals describe extracted text availability only. Sparse or missing text can limit readability or comparison quality without weakening the underlying file-integrity proof.</p>
      {diagnostics.embeddedTextDetected && diagnostics.likelyScannedImageOnly ? (
        <p className="notice">Some PDFs contain minimal or low-quality embedded text while still behaving like scanned or image-heavy documents for extraction purposes.</p>
      ) : null}
    </>
  );
};

const VerificationOrderSection = ({ title = "Verification order" }: { title?: string }) => (
  <>
    <p className="notice">Verification stays anchored to the same offline workflow even when screenshots or uploader approval receipts are present.</p>
    <ol className="evidence-list">
      {verificationOrder.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  </>
);

const useRoute = (): [Route, (route: Route) => void] => {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const handleHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const navigate = (nextRoute: Route) => {
    const nextHash =
      nextRoute.kind === "home"
        ? "#/"
        : nextRoute.kind === "verify"
          ? "#/verify"
          : nextRoute.kind === "capture"
            ? `#/captures/${nextRoute.id}`
          : nextRoute.kind === "history"
            ? `#/history/${encodeURIComponent(nextRoute.url)}`
            : nextRoute.kind === "watchlists"
              ? "#/watchlists"
              : nextRoute.kind === "watchlist"
                ? `#/watchlists/${nextRoute.id}`
                : `#/compare/${encodeURIComponent(nextRoute.url)}/${nextRoute.fromCaptureId}/${nextRoute.toCaptureId}`;
    window.location.hash = nextHash;
    setRoute(nextRoute);
  };

  return [route, navigate];
};

const useCaptureDetail = (captureId: string | undefined) => {
  const [detail, setDetail] = useState<CaptureDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!captureId) {
      return;
    }

    let isCancelled = false;
    let intervalHandle: number | undefined;

    const load = async () => {
      try {
        setIsLoading(true);
        const nextDetail = await getCapture(captureId);
        if (isCancelled) {
          return;
        }
        setDetail(nextDetail);
        setError(undefined);

        if (nextDetail.capture.status === "completed" || nextDetail.capture.status === "failed") {
          if (intervalHandle) {
            window.clearInterval(intervalHandle);
          }
        }
      } catch (nextError) {
        if (!isCancelled) {
          setError(nextError instanceof Error ? nextError.message : "Unable to load capture");
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    intervalHandle = window.setInterval(() => {
      void load();
    }, 1500);

    return () => {
      isCancelled = true;
      if (intervalHandle) {
        window.clearInterval(intervalHandle);
      }
    };
  }, [captureId]);

  return { detail, error, isLoading };
};

const useHistory = (url: string | undefined) => {
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [normalizedUrl, setNormalizedUrl] = useState<string | undefined>(url);

  useEffect(() => {
    if (!url) {
      return;
    }

    void getCaptureHistory(url)
      .then((response) => {
        setCaptures(response.captures);
        setNormalizedUrl(response.normalizedRequestedUrl);
        setError(undefined);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : "Unable to load history");
      });
  }, [url]);

  return { captures, error, normalizedUrl };
};

const useComparison = (route: Extract<Route, { kind: "compare" }> | undefined) => {
  const [comparison, setComparison] = useState<CaptureComparison | undefined>();
  const [normalizedUrl, setNormalizedUrl] = useState<string | undefined>(route?.url);
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!route) {
      return;
    }

    let isCancelled = false;
    setIsLoading(true);

    void getCaptureComparison({
      url: route.url,
      fromCaptureId: route.fromCaptureId,
      toCaptureId: route.toCaptureId
    })
      .then((response) => {
        if (isCancelled) {
          return;
        }
        setComparison(response.comparison);
        setNormalizedUrl(response.normalizedRequestedUrl);
        setError(undefined);
      })
      .catch((nextError) => {
        if (!isCancelled) {
          setError(nextError instanceof Error ? nextError.message : "Unable to load comparison");
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [route]);

  return { comparison, normalizedUrl, error, isLoading };
};


const useWatchlists = () => {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void listWatchlists()
      .then((nextWatchlists) => {
        setWatchlists(nextWatchlists);
        setError(undefined);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : "Unable to load watchlists");
      });
  }, []);

  return { watchlists, error, refresh: () => listWatchlists().then(setWatchlists) };
};

const useWatchlistRuns = (watchlistId: string | undefined) => {
  const [watchlist, setWatchlist] = useState<Watchlist | undefined>();
  const [runs, setRuns] = useState<WatchlistRun[]>([]);
  const [error, setError] = useState<string | undefined>();

  const refresh = () => {
    if (!watchlistId) {
      return Promise.resolve();
    }

    return getWatchlistRuns(watchlistId)
      .then((response) => {
        setWatchlist(response.watchlist);
        setRuns(response.runs);
        setError(undefined);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : "Unable to load watchlist runs");
      });
  };

  useEffect(() => {
    void refresh();
  }, [watchlistId]);

  return { watchlist, runs, error, refresh };
};

const useOperatorKey = (enabled: boolean) => {
  const [operatorKey, setOperatorKey] = useState<OperatorPublicKey | undefined>();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let isCancelled = false;
    void getOperatorPublicKey()
      .then((nextOperatorKey) => {
        if (!isCancelled) {
          setOperatorKey(nextOperatorKey);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setOperatorKey(undefined);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [enabled]);

  return operatorKey;
};

const SummaryCard = ({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "accent" }) => (
  <div className={`summary-card summary-card--${tone}`}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="panel">
    <div className="panel__header">
      <h2>{title}</h2>
    </div>
    {children}
  </section>
);

const HomeView = ({ onCreated, navigate }: { onCreated: (capture: CaptureRecord) => void; navigate: (route: Route) => void }) => {
  const [url, setUrl] = useState("");
  const [watchUrl, setWatchUrl] = useState("");
  const [watchIntervalMinutes, setWatchIntervalMinutes] = useState("60");
  const [watchExpiresAt, setWatchExpiresAt] = useState("");
  const [watchBurstEnabled, setWatchBurstEnabled] = useState(false);
  const [watchWebhookUrl, setWatchWebhookUrl] = useState("");
  const [watchEmitJson, setWatchEmitJson] = useState(true);
  const [selectedPdf, setSelectedPdf] = useState<File | undefined>();
  const [selectedImage, setSelectedImage] = useState<File | undefined>();
  const [imageCaption, setImageCaption] = useState("");
  const [imageAltText, setImageAltText] = useState("");
  const [imagePublishedAt, setImagePublishedAt] = useState("");
  const [imageDerivativeHash, setImageDerivativeHash] = useState("");
  const [imageAttestUpload, setImageAttestUpload] = useState(false);
  const [imageActorId, setImageActorId] = useState("");
  const [imageActorName, setImageActorName] = useState("");
  const [pdfApproveUpload, setPdfApproveUpload] = useState(false);
  const [pdfActorAccountId, setPdfActorAccountId] = useState("");
  const [pdfApprovalType, setPdfApprovalType] = useState("pdf-upload-approval-v1");
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      const capture = await createCapture({ url });
      onCreated(capture);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to create capture");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWatchlistSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await createWatchlist({
        url: watchUrl,
        intervalMinutes: Number(watchIntervalMinutes),
        webhookUrl: watchWebhookUrl.trim() || undefined,
        emitJson: watchEmitJson
      });
      setActionNotice("Watchlist created.");
      navigate({ kind: "watchlists" });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to create watchlist");
    }
  };

  const handlePdfSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setSelectedPdf(file ?? undefined);
  };

  const handleImageSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setSelectedImage(file ?? undefined);
  };


  const handleImageSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedImage) {
      return;
    }

    try {
      const capture = await createImageCapture({
        file: selectedImage,
        caption: imageCaption.trim() || undefined,
        altText: imageAltText.trim() || undefined,
        publishedAt: imagePublishedAt.trim() || undefined,
        derivativeOfContentHash: imageDerivativeHash.trim() || undefined,
        attestations:
          imageAttestUpload && imageActorId.trim()
            ? [
                {
                  type: "upload",
                  actor: {
                    id: imageActorId.trim(),
                    displayName: imageActorName.trim() || undefined,
                    role: "uploader"
                  },
                  auth: {
                    method: "session",
                    level: "standard"
                  },
                  notes: "Uploader identity claim recorded as attested metadata."
                }
              ]
            : undefined
      });
      onCreated(capture);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to upload image");
    }
  };
  const handlePdfSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPdf) {
      return;
    }

    try {
      const capture = await createPdfCapture({
        file: selectedPdf,
        approval:
          pdfApproveUpload && pdfActorAccountId.trim()
            ? {
                actorAccountId: pdfActorAccountId.trim(),
                approvalType: pdfApprovalType.trim() || "pdf-upload-approval-v1",
                approvalScope: "file-hash",
                approvalMethod: "account-signature"
              }
            : undefined
      });
      onCreated(capture);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to upload PDF");
    }
  };

  return (
    <div className="hero-layout hero-layout--stacked">
      <section className="hero-card">
        <p className="eyebrow">Verifier-first authenticity infrastructure</p>
        <h1>Capture evidence. Verify offline. Trust the proof package, not the server.</h1>
        <p className="hero-copy">
          This system preserves observed web pages and PDF files, derives deterministic artifacts, binds them to Merkle-backed transparency checkpoints,
          and lets third parties verify the package offline with a trusted operator key.
        </p>
        <div className="detail-header">
          <button className="ghost-button" onClick={() => navigate({ kind: "verify" })}>
            Verify a proof package
          </button>
          <button className="ghost-button" onClick={() => navigate({ kind: "watchlists" })}>
            View watchlists
          </button>
          <a className="ghost-button" href={`${artifactUrl("transparency", "operator-key")}`.replace('/api/captures/transparency/artifacts/operator-key', '/api/transparency/operator-key')} target="_blank" rel="noreferrer">
            Export operator key
          </a>
        </div>
      </section>
      <section className="panel">
        <div className="panel__header">
          <h2>Capture and package evidence</h2>
        </div>
        <form className="capture-form" onSubmit={submit}>
          <label htmlFor="capture-url">Paste a URL to audit</label>
          <div className="capture-form__row">
            <input id="capture-url" name="capture-url" placeholder="https://example.com/article" value={url} onChange={(event) => setUrl(event.target.value)} />
            <button type="submit" disabled={isSubmitting || !url.trim()}>{isSubmitting ? "Queueing..." : "Create proof"}</button>
          </div>
        </form>
        <form className="capture-form" onSubmit={handlePdfSubmit}>
          <label htmlFor="capture-pdf">Upload a PDF file to prove exact file integrity</label>
          <div className="capture-form__row">
            <input id="capture-pdf" name="capture-pdf" type="file" accept="application/pdf" onChange={handlePdfSelection} />
            <button type="submit" disabled={!selectedPdf || (pdfApproveUpload && !pdfActorAccountId.trim())}>Create PDF proof</button>
          </div>
          <label className="hero-copy"><input type="checkbox" checked={pdfApproveUpload} onChange={(event) => setPdfApproveUpload(event.target.checked)} /> Approve and sign this PDF upload as the uploader</label>
          {pdfApproveUpload ? (
            <div className="field-grid">
              <div className="field-grid__row">
                <span>Uploader account ID</span>
                <input value={pdfActorAccountId} onChange={(event) => setPdfActorAccountId(event.target.value)} placeholder="editor@example.com" />
              </div>
              <div className="field-grid__row">
                <span>Approval type</span>
                <input value={pdfApprovalType} onChange={(event) => setPdfApprovalType(event.target.value)} />
              </div>
            </div>
          ) : null}
        </form>
        <form className="capture-form" onSubmit={handleImageSubmit}>
          <label htmlFor="capture-image">Upload an image file to package exact file integrity and optional identity claims</label>
          <div className="capture-form__row">
            <input id="capture-image" name="capture-image" type="file" accept="image/*" onChange={handleImageSelection} />
            <button type="submit" disabled={!selectedImage || (imageAttestUpload && !imageActorId.trim())}>Create image proof</button>
          </div>
          <div className="field-grid">
            <div className="field-grid__row">
              <span>Caption (optional)</span>
              <input value={imageCaption} onChange={(event) => setImageCaption(event.target.value)} placeholder="Image caption" />
            </div>
            <div className="field-grid__row">
              <span>Alt text (optional)</span>
              <input value={imageAltText} onChange={(event) => setImageAltText(event.target.value)} placeholder="Alt text" />
            </div>
            <div className="field-grid__row">
              <span>Published at (optional)</span>
              <input value={imagePublishedAt} onChange={(event) => setImagePublishedAt(event.target.value)} placeholder="2026-03-20T10:30:00Z" />
            </div>
            <div className="field-grid__row">
              <span>Derivative of content hash (optional)</span>
              <input value={imageDerivativeHash} onChange={(event) => setImageDerivativeHash(event.target.value)} placeholder="sha256:..." />
            </div>
          </div>
          <label className="hero-copy"><input type="checkbox" checked={imageAttestUpload} onChange={(event) => setImageAttestUpload(event.target.checked)} /> Add uploader attestation metadata to the proof package</label>
          {imageAttestUpload ? (
            <div className="field-grid">
              <div className="field-grid__row">
                <span>Actor ID</span>
                <input value={imageActorId} onChange={(event) => setImageActorId(event.target.value)} placeholder="photographer@example.com" />
              </div>
              <div className="field-grid__row">
                <span>Display name</span>
                <input value={imageActorName} onChange={(event) => setImageActorName(event.target.value)} placeholder="Photo desk" />
              </div>
            </div>
          ) : null}
        </form>
      </section>
      <section className="promise-card">
        <h2>What this proves</h2>
        <ul>
          <li>The system observed the captured URL or PDF file by the recorded time.</li>
          <li>The stored raw artifact and derived canonical artifact hashes are reproducible.</li>
          <li>The proof package can be checked offline against a signed Merkle checkpoint and trusted operator key.</li>
        </ul>
      </section>
      <section className="promise-card">
        <h2>What this does not prove</h2>
        <ul>
          <li>Original publisher or author intent.</li>
          <li>Original creation time before the recorded observation.</li>
          <li>That claimed metadata fields are true just because they appear in the source.</li>
        </ul>
      </section>
      <section className="panel">
        <div className="panel__header"><h2>Evidence layers</h2></div>
        <ul className="evidence-list">
          <li><strong>Raw snapshot</strong>: exact fetched bytes or uploaded file preserved by the operator.</li>
          <li><strong>Canonical content</strong>: normalized extracted content used for semantic comparison.</li>
          <li><strong>Metadata</strong>: extracted title, author, and claimed-date style fields hashed separately.</li>
          <li><strong>Rendered evidence</strong>: optional screenshot-based visual evidence under recorded render settings.</li>
          <li><strong>Operator observation</strong>: the operator witnessed and packaged the artifact.</li>
          <li><strong>Uploader approval</strong>: optional additive provenance for the exact uploaded PDF hash.</li>
        </ul>
      </section>

      <section className="panel">
      <section className="panel">
        <div className="panel__header"><h2>Verify a proof package</h2></div>
        <p className="hero-copy">Verification runs on exported artifacts. User-supplied checkpoint and operator key files provide stronger independent trust than package-provided materials.</p>
        <div className="detail-header">
          <button className="ghost-button" onClick={() => navigate({ kind: "verify" })}>Open browser verifier</button>
        </div>
        <pre>{`npm run proof:verify -- <package-directory> --checkpoint <checkpoint.json> --operator-key <operator-public-key.json>`}</pre>
      </section>
        <div className="panel__header"><h2>Transparency checkpoints</h2></div>
        <pre>{`URL capture or PDF upload -> hashes -> proof package -> transparency log entry -> Merkle checkpoint -> operator signature -> offline verifier`}</pre>
      </section>
      <section className="panel panel--full-span">
        <div className="panel__header"><h2>Run your own operator</h2></div>
        <p className="hero-copy">Use Postgres as the evidence store, publish checkpoints, distribute operator public keys independently, and verify exported packages without depending on this UI staying online.</p>
        <form className="capture-form" onSubmit={handleWatchlistSubmit}>
          <label htmlFor="watch-url">Create a self-hosted watchlist</label>
          <div className="field-grid">
            <div className="field-grid__row field-grid__row--wide">
              <span>URL</span>
              <input id="watch-url" value={watchUrl} onChange={(event) => setWatchUrl(event.target.value)} placeholder="https://example.com/article" />
            </div>
            <div className="field-grid__row">
              <span>Interval (minutes)</span>
              <input value={watchIntervalMinutes} onChange={(event) => setWatchIntervalMinutes(event.target.value)} />
            </div>
            <div className="field-grid__row">
              <span>Webhook URL (optional)</span>
              <input value={watchWebhookUrl} onChange={(event) => setWatchWebhookUrl(event.target.value)} placeholder="https://endpoint.example/webhook" />
            </div>
          </div>
          <label className="hero-copy"><input type="checkbox" checked={watchEmitJson} onChange={(event) => setWatchEmitJson(event.target.checked)} /> Record JSON notification output</label>
          <div className="detail-header">
            <button type="submit" disabled={!watchUrl.trim() || !watchIntervalMinutes.trim()}>Create watchlist</button>
          </div>
        </form>
      </section>
      {error ? <p className="form-error">{error}</p> : null}
      {actionNotice ? <p className="notice">{actionNotice}</p> : null}
    </div>
  );
};
const CaptureDetailView = ({
  detail,
  isLoading,
  error,
  navigate
}: {
  detail?: CaptureDetail;
  isLoading: boolean;
  error?: string;
  navigate: (route: Route) => void;
}) => {
  if (error) {
    return <p className="notice notice--error">{error}</p>;
  }

  if (!detail) {
    return <p className="notice">{isLoading ? "Loading capture..." : "Capture not found."}</p>;
  }

  const { capture, canonicalContent, metadata, proofBundle, receipt } = detail;
  const verificationCopy =
    capture.status === "completed"
      ? "Observed by our system at the capture time shown below. This does not prove when the publisher originally created it."
      : "Processing is still in progress. The system timestamp will only be final once the capture completes.";
  const scopeRows = buildCaptureScope(detail);
  const comparisonBadges = buildComparisonBadges(capture);
  const evidenceLayers = buildEvidenceLayers({
    artifactType: capture.artifactType,
    rawSnapshotHash: capture.rawSnapshotHash,
    canonicalContentHash: capture.canonicalContentHash,
    metadataHash: capture.metadataHash,
    proofBundleHash: capture.proofBundleHash,
    renderedEvidence: capture.renderedEvidence,
    screenshotStorageKey: capture.artifacts.screenshotStorageKey,
    approvalReceiptId: capture.approvalReceiptId
  });
  const pdfQualityDiagnostics = derivePdfQualityDiagnostics({
    artifactType: capture.artifactType,
    canonicalContent,
    metadata
  });

  return (
    <div className="detail-layout">
      <div className="detail-header">
        <button className="ghost-button" onClick={() => navigate({ kind: "home" })}>
          New capture
        </button>
        <button className="ghost-button" onClick={() => navigate({ kind: "watchlists" })}>
          View watchlists
        </button>
        {capture.artifactType !== "pdf-file" ? (
          <>
            <button className="ghost-button" onClick={() => navigate({ kind: "history", url: capture.normalizedRequestedUrl })}>
              View URL history
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                void createWatchlist({ url: capture.normalizedRequestedUrl, intervalMinutes: 60, emitJson: true }).then(() => navigate({ kind: "watchlists" }));
              }}
            >
              Watch this URL hourly
            </button>
          </>
        ) : null}
        {capture.comparedToCaptureId ? (
          <button
            className="ghost-button"
            onClick={() =>
              navigate({
                kind: "compare",
                url: capture.normalizedRequestedUrl,
                fromCaptureId: capture.comparedToCaptureId!,
                toCaptureId: capture.id
              })
            }
          >
            Compare with previous
          </button>
        ) : null}
      </div>

      <section className="headline-card">
        <div>
          <p className="eyebrow">Capture record</p>
          <h1>{metadata?.title ?? canonicalContent?.title ?? capture.requestedUrl}</h1>
          <p className="hero-copy">{verificationCopy}</p>
        </div>
        <div className={`status-pill status-pill--${capture.status}`}>{statusLabel(capture.status)}</div>
      </section>

      <div className="summary-grid">
        <SummaryCard label="Captured at" value={formatTimestamp(capture.capturedAt)} tone="accent" />
        <SummaryCard label={documentDateLabel(capture.artifactType)} value={formatTimestamp(capture.claimedPublishedAt)} />
        <SummaryCard label={capture.artifactType === "pdf-file" ? "Document kind" : "Page kind"} value={pageKindLabel(capture.artifactType, capture.pageKind)} />
        <SummaryCard label="Extraction" value={capture.contentExtractionStatus ?? "Pending"} />
      </div>

      {capture.errorMessage ? <p className="notice notice--error">{capture.errorMessage}</p> : null}

      <Section title="What This Proves">
        <ul className="evidence-list">
          {capture.artifactType === "pdf-file" ? (
            <>
              <li>This PDF file was observed by our system at the recorded capture time.</li>
              <li>This exact source file was preserved and hashed.</li>
              <li>Any extracted canonical content or metadata was derived from that observed file.</li>
              <li>These stored artifacts can be rechecked against the recorded hashes.</li>
            </>
          ) : (
            <>
              <li>This URL was fetched by our system at the recorded capture time.</li>
              <li>This exact raw snapshot was preserved and hashed.</li>
              <li>This canonical block structure was extracted from that fetched snapshot.</li>
              <li>These stored artifacts can be rechecked against the recorded hashes.</li>
            </>
          )}
        </ul>
      </Section>

      <Section title="What This Does Not Prove">
        <ul className="evidence-list">
          {capture.artifactType === "pdf-file" ? (
            <>
              <li>Who originally created the PDF or when it was first authored.</li>
              <li>Whether PDF metadata dates or author claims are true.</li>
              <li>Whether uploader approval exists unless a separate approval receipt is shown.</li>
              <li>That the document had the same contents before capture.</li>
            </>
          ) : (
            <>
              <li>When the publisher originally created the page.</li>
              <li>Whether the claimed publication date is true.</li>
              <li>Whether the displayed author field is genuine.</li>
              <li>That the page had the same content before capture.</li>
            </>
          )}
        </ul>
      </Section>

      <Section title="Evidence Layers">
        <EvidenceLayersSection layers={evidenceLayers} />
      </Section>

      <Section title="Capture Scope">
        <div className="field-grid">
          {scopeRows.map((row) => (
            <div key={row.label} className="field-grid__row">
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      </Section>

      {capture.artifactType === "image-file" ? (
        <Section title="Image Preview">
          <p className="notice">This preview is for human inspection. The trust anchor remains the preserved source image hash in the proof package.</p>
          {capture.artifacts.rawImageStorageKey ? (
            <div className="evidence-preview">
              <img className="evidence-preview__image" src={artifactUrl(capture.id, "raw-image")} alt={capture.sourceLabel ?? "Captured image"} />
            </div>
          ) : (
            <p className="notice">No source image artifact is available to preview.</p>
          )}
        </Section>
      ) : capture.artifactType !== "pdf-file" ? (
        <Section title="Rendered Evidence">
          <div className="field-grid">
            <div className="field-grid__row">
              <span>Screenshot captured</span>
              <strong>{toYesNo(Boolean(capture.renderedEvidence || capture.artifacts.screenshotStorageKey))}</strong>
            </div>
            <div className="field-grid__row">
              <span>Screenshot hash</span>
              <strong>{renderedEvidenceScreenshotHash(capture.renderedEvidence) ?? "Not recorded"}</strong>
            </div>
            <div className="field-grid__row">
              <span>Screenshot format</span>
              <strong>{capture.renderedEvidence ? renderedEvidenceScreenshotFormat(capture.renderedEvidence) : "Not recorded"}</strong>
            </div>
            <div className="field-grid__row">
              <span>Viewport</span>
              <strong>{formatViewport(capture.renderedEvidence)}</strong>
            </div>
            <div className="field-grid__row">
              <span>Device preset</span>
              <strong>{renderedEvidenceDevicePreset(capture.renderedEvidence)}</strong>
            </div>
            <div className="field-grid__row">
              <span>User agent label</span>
              <strong>{renderedEvidenceUserAgentLabel(capture.renderedEvidence)}</strong>
            </div>
            <div className="field-grid__row field-grid__row--wide">
              <span>User agent</span>
              <strong>{renderedEvidenceUserAgent(capture.renderedEvidence)}</strong>
            </div>
          </div>
          <p className="notice">Rendered screenshots are visual evidence of the operator-rendered page under the recorded viewport and device settings. They are not canonical content and are not expected to remain pixel-identical across captures.</p>
          {capture.artifacts.screenshotStorageKey ? (
            <div className="evidence-preview">
              <img className="evidence-preview__image" src={artifactUrl(capture.id, "screenshot")} alt="Rendered evidence screenshot" />
            </div>
          ) : (
            <p className="notice">No screenshot was captured for this observation. The rest of the proof package and verification flow remain valid without rendered evidence.</p>
          )}
        </Section>
      ) : null}

      <Section title="Comparison Summary">
        {capture.comparedToCaptureId ? (
          <>
            <div className="history-row__badges">
              {comparisonBadges.map((badge, index) => (
                <span key={`${capture.id}-comparison-${index}`} className={`change-badge ${badge.changed ? "change-badge--changed" : ""}`}>
                  {badge.label}
                </span>
              ))}
            </div>
            <div className="field-grid">
              <div className="field-grid__row">
                <span>Compared to previous capture</span>
                <strong>{capture.comparedToCaptureId}</strong>
              </div>
            </div>
          </>
        ) : (
          <p className="notice">{capture.artifactType === "pdf-file" ? "No previous comparable capture is available yet. This is the first observed capture for this PDF or source." : "No previous comparable capture is available yet. This is the first observed capture for this URL."}</p>
        )}
      </Section>

      <Section title="Semantic Content">
        <div className="field-grid">
          <div className="field-grid__row">
            <span>Source URL</span>
            <strong>{capture.requestedUrl}</strong>
          </div>
          <div className="field-grid__row">
            <span>Final URL</span>
            <strong>{capture.finalUrl ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Author</span>
            <strong>{metadata?.author ?? "Not detected"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Extractor version</span>
            <strong>{canonicalContent?.extractorVersion ?? capture.extractorVersion}</strong>
          </div>
          <div className="field-grid__row">
            <span>Normalization version</span>
            <strong>{canonicalContent?.normalizationVersion ?? capture.normalizationVersion ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Canonical schema version</span>
            <strong>{canonicalContent?.schemaVersion ?? capture.canonicalContentSchemaVersion ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Metadata schema version</span>
            <strong>{metadata?.schemaVersion ?? capture.metadataSchemaVersion ?? "Pending"}</strong>
          </div>
        </div>

        <details className="details-card" open>
          <summary>Canonical content summary</summary>
          <p className="notice">{canonicalSummaryText(capture, canonicalContent, pdfQualityDiagnostics)}</p>
        </details>

        <details className="details-card">
          <summary>{capture.artifactType === "pdf-file" ? "View raw extracted text" : "View full canonical content"}</summary>
          <pre>{canonicalContent?.bodyMarkdown ?? "Canonical content is not available yet."}</pre>
        </details>

        <details className="details-card">
          <summary>View canonical blocks</summary>
          <pre>{canonicalContent ? JSON.stringify(canonicalContent.blocks, null, 2) : "Canonical blocks are not available yet."}</pre>
        </details>
      </Section>

      <Section title="Extraction Diagnostics">
        <div className="field-grid">
          <div className="field-grid__row">
            <span>Extraction confidence</span>
            <strong>{formatPercent(canonicalContent?.diagnostics.confidence)}</strong>
          </div>
          <div className="field-grid__row">
            <span>Character count</span>
            <strong>{canonicalContent?.stats.characterCount ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Word count</span>
            <strong>{canonicalContent?.stats.wordCount ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Block count</span>
            <strong>{canonicalContent?.stats.blockCount ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Paragraph count</span>
            <strong>{canonicalContent?.stats.paragraphCount ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Heading count</span>
            <strong>{canonicalContent?.stats.headingCount ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Image count</span>
            <strong>{canonicalContent?.stats.imageCount ?? "Pending"}</strong>
          </div>
        </div>

        {canonicalContent?.diagnostics.warnings?.length ? (
          <div className="warning-stack">
            {canonicalContent.diagnostics.warnings.map((warning) => (
              <p key={warning} className="notice notice--warning">
                {warning}
              </p>
            ))}
          </div>
        ) : (
          <p className="notice">No extraction warnings recorded.</p>
        )}
      </Section>

      <Section title="Field Provenance">
        <FieldSourceList provenance={metadata?.fieldProvenance} artifactType={capture.artifactType} />
      </Section>

      {capture.artifactType === "pdf-file" ? (
        <Section title="PDF Quality Diagnostics">
          <PdfQualityDiagnosticsSection diagnostics={pdfQualityDiagnostics} />
        </Section>
      ) : null}

      <Section title="Verification Appendix">
        <VerificationOrderSection />
      </Section>

      <Section title="Integrity Hashes">
        <div className="field-grid">
          <div className="field-grid__row">
            <span>Raw snapshot hash</span>
            <strong>{capture.rawSnapshotHash ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Canonical content hash</span>
            <strong>{capture.canonicalContentHash ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Metadata hash</span>
            <strong>{capture.metadataHash ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Proof bundle hash</span>
            <strong>{capture.proofBundleHash ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Hash algorithm</span>
            <strong>{proofBundle?.hashAlgorithm ?? capture.hashAlgorithm ?? "Pending"}</strong>
          </div>
        </div>
      </Section>

      {capture.artifactType === "pdf-file" ? (
        <Section title="Observed by Operator">
          <p className="notice">This PDF was observed, hashed, and packaged by the operator. Operator observation is sufficient for capture verification even if no uploader approval exists.</p>
          <div className="field-grid">
            <div className="field-grid__row">
              <span>Observed file hash</span>
              <strong>{capture.rawSnapshotHash ?? "Pending"}</strong>
            </div>
            <div className="field-grid__row">
              <span>Observed at</span>
              <strong>{formatTimestamp(capture.capturedAt)}</strong>
            </div>
          </div>
        </Section>
      ) : null}

      {detail.approvalReceipt ? (
        <Section title="Approved by Uploader">
          <p className="notice">Uploader approval is a separate provenance receipt for the exact uploaded PDF hash. It adds provenance context, but it is not required to verify the operator observation.</p>
          <div className="field-grid">
            <div className="field-grid__row">
              <span>Approved by uploader</span>
              <strong>{detail.approvalReceipt.actorAccountId}</strong>
            </div>
            <div className="field-grid__row">
              <span>Approval type</span>
              <strong>{detail.approvalReceipt.approvalType}</strong>
            </div>
            <div className="field-grid__row">
              <span>Approval scope</span>
              <strong>{detail.approvalReceipt.approvalScope}</strong>
            </div>
            <div className="field-grid__row">
              <span>Approval method</span>
              <strong>{detail.approvalReceipt.approvalMethod}</strong>
            </div>
            <div className="field-grid__row">
              <span>Approved at</span>
              <strong>{formatTimestamp(detail.approvalReceipt.approvedAt)}</strong>
            </div>
            <div className="field-grid__row">
              <span>Approved PDF hash</span>
              <strong>{detail.approvalReceipt.rawPdfHash}</strong>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="Transparency Proof">
        <div className="field-grid">
          <div className="field-grid__row">
            <span>Timestamp receipt</span>
            <strong>{receipt?.id ?? capture.proofReceiptId ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Receipt provider</span>
            <strong>{receipt?.provider ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Receipt time</span>
            <strong>{formatTimestamp(receipt?.receivedAt)}</strong>
          </div>
          <div className="field-grid__row">
            <span>Transparency checkpoint</span>
            <strong>{receipt?.transparencyCheckpointId ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Transparency log entry</span>
            <strong>{receipt?.transparencyLogEntryHash ?? "Pending"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Merkle root</span>
            <strong>{receipt?.merkleRoot ?? "Pending"}</strong>
          </div>
        </div>
        <p className="notice">
          This links the proof bundle to the stored timestamp receipt and transparency-log context for this observed capture.
        </p>
      </Section>

      <Section title="Artifacts">
        {capture.artifactType === "pdf-file" ? <p className="notice"><strong>Primary artifact</strong>: Source PDF. <strong>Derived artifacts</strong>: canonical JSON, metadata JSON, proof bundle JSON, and approval receipt JSON when present.</p> : capture.artifactType === "image-file" ? <p className="notice"><strong>Primary artifact</strong>: Source image file. <strong>Derived artifacts</strong>: canonical JSON, metadata JSON, proof bundle JSON, and attestations JSON when present.</p> : null}
        <div className="artifact-links">
          {capture.artifacts.rawHtmlStorageKey ? (
            <a href={artifactUrl(capture.id, "raw-html")} target="_blank" rel="noreferrer">
              Raw HTML
            </a>
          ) : null}
          {capture.artifacts.rawPdfStorageKey ? (
            <a href={artifactUrl(capture.id, "raw-pdf")} target="_blank" rel="noreferrer">
              Source PDF
            </a>
          ) : null}
          {capture.artifacts.screenshotStorageKey ? (
            <a href={artifactUrl(capture.id, "screenshot")} target="_blank" rel="noreferrer">
              Screenshot PNG
            </a>
          ) : null}
          <a href={artifactUrl(capture.id, "canonical-content")} target="_blank" rel="noreferrer">
            Canonical JSON
          </a>
          <a href={artifactUrl(capture.id, "metadata")} target="_blank" rel="noreferrer">
            Metadata JSON
          </a>
          <a href={artifactUrl(capture.id, "proof-bundle")} target="_blank" rel="noreferrer">
            Proof bundle JSON
          </a>
          {capture.artifacts.approvalReceiptStorageKey ? (
            <a href={artifactUrl(capture.id, "approval-receipt")} target="_blank" rel="noreferrer">
              Approval receipt JSON
            </a>
          ) : null}
        </div>
      </Section>

      <Section title="Advanced JSON">
        <details className="details-card">
          <summary>Proof bundle JSON</summary>
          <pre>{proofBundle ? JSON.stringify(proofBundle, null, 2) : "Proof bundle is not available yet."}</pre>
        </details>

        <details className="details-card">
          <summary>Receipt JSON</summary>
          <pre>{receipt ? JSON.stringify(receipt, null, 2) : "Receipt is not available yet."}</pre>
        </details>

        <details className="details-card">
          <summary>Capture record JSON</summary>
          <pre>{JSON.stringify(capture, null, 2)}</pre>
        </details>
      </Section>
    </div>
  );
};
const HistoryView = ({ url, navigate }: { url: string; navigate: (route: Route) => void }) => {
  const { captures, error, normalizedUrl } = useHistory(url);
  const title = normalizedUrl ?? url;
  const latestOlderCapture = captures.length >= 2 ? captures[1] : undefined;
  const latestNewerCapture = captures.length >= 2 ? captures[0] : undefined;
  const oldestCapture = captures.length >= 2 ? captures[captures.length - 1] : undefined;

  return (
    <div className="detail-layout">
      <div className="detail-header">
        <button className="ghost-button" onClick={() => navigate({ kind: "home" })}>
          New capture
        </button>
        <button className="ghost-button" onClick={() => navigate({ kind: "watchlists" })}>
          View watchlists
        </button>
        <button className="ghost-button" onClick={() => { void createWatchlist({ url: title, intervalMinutes: 60, emitJson: true }).then(() => navigate({ kind: "watchlists" })); }}>
          Watch this URL hourly
        </button>
        {latestOlderCapture && latestNewerCapture ? (
          <>
            <button
              className="ghost-button"
              onClick={() =>
                navigate({
                  kind: "compare",
                  url: title,
                  fromCaptureId: latestOlderCapture.id,
                  toCaptureId: latestNewerCapture.id
                })
              }
            >
              Compare latest two
            </button>
            {oldestCapture && oldestCapture.id !== latestNewerCapture.id ? (
              <button
                className="ghost-button"
                onClick={() =>
                  navigate({
                    kind: "compare",
                    url: title,
                    fromCaptureId: oldestCapture.id,
                    toCaptureId: latestNewerCapture.id
                  })
                }
              >
                Compare oldest vs newest
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <section className="headline-card headline-card--url">
        <div>
          <p className="eyebrow">URL history</p>
          <h1>{title}</h1>
          <p className="hero-copy">
            Comparison badges show whether semantic content, normalized metadata, title, author, or claimed publish date
            changed from the prior successful capture.
          </p>
        </div>
      </section>
      {error ? <p className="notice notice--error">{error}</p> : null}
      <div className="history-list history-list--timeline">
        {captures.map((capture, index) => {
          const compareTargetId = capture.comparedToCaptureId ?? captures[index + 1]?.id;
          return (
            <article key={capture.id} className="history-row">
              <div className="history-row__time">
                <span className="history-row__dot" aria-hidden="true" />
                <div>
                  <strong>{formatTimestamp(capture.capturedAt ?? capture.createdAt)}</strong>
                  <p>{statusLabel(capture.status)}</p>
                </div>
              </div>
              <div className="history-row__badges">
                {buildComparisonBadges(capture).map((badge, badgeIndex) => (
                  <span key={`${capture.id}-comparison-${badgeIndex}`} className={`change-badge ${badge.changed ? "change-badge--changed" : ""}`}>
                    {badge.label}
                  </span>
                ))}
              </div>
              <div className="history-row__actions">
                <button className="ghost-button" onClick={() => navigate({ kind: "capture", id: capture.id })}>
                  View capture
                </button>
                {compareTargetId ? (
                  <button
                    className="ghost-button"
                    onClick={() =>
                      navigate({
                        kind: "compare",
                        url: title,
                        fromCaptureId: compareTargetId,
                        toCaptureId: capture.id
                      })
                    }
                  >
                    Compare
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {captures.length === 0 ? <p className="notice">No captures yet for this URL.</p> : null}
      </div>
    </div>
  );
};

const WatchlistsView = ({ navigate }: { navigate: (route: Route) => void }) => {
  const { watchlists, error, refresh } = useWatchlists();
  const [actionMessage, setActionMessage] = useState<string | undefined>();

  const toggleWatchlist = async (watchlist: Watchlist) => {
    const nextStatus = watchlist.status === "active" ? "paused" : "active";
    await updateWatchlist(watchlist.id, { status: nextStatus });
    await refresh();
    setActionMessage(`Watchlist ${nextStatus}.`);
  };

  const triggerRetry = async (watchlist: Watchlist) => {
    await retryWatchlist(watchlist.id);
    await refresh();
    setActionMessage("Watchlist recapture started.");
  };

  const sendWebhookTest = async (watchlist: Watchlist) => {
    const result = await testWatchlistWebhook(watchlist.id);
    setActionMessage(result.ok ? `Webhook test returned ${result.status ?? 200}.` : result.error ?? "Webhook test failed.");
  };

  return (
    <div className="detail-layout">
      <div className="detail-header">
        <button className="ghost-button" onClick={() => navigate({ kind: "home" })}>Home</button>
      </div>
      <section className="headline-card">
        <div>
          <p className="eyebrow">Open monitoring</p>
          <h1>Watchlists</h1>
          <p className="hero-copy">Scheduled recaptures compare the latest successful observation against the previous successful observation for the same normalized URL.</p>
        </div>
      </section>
      {error ? <p className="notice notice--error">{error}</p> : null}
      {actionMessage ? <p className="notice">{actionMessage}</p> : null}
      <div className="history-list">
        {watchlists.map((watchlist) => (
          <article key={watchlist.id} className="history-row">
            <div className="history-row__time">
              <span className="history-row__dot" aria-hidden="true" />
              <div>
                <strong>{watchlist.requestedUrl}</strong>
                <p>{watchlist.status}</p>
              </div>
            </div>
            <div className="history-row__badges">
              <span className={`change-badge ${watchlist.latestRunVerdict === "changed" || watchlist.latestRunVerdict === "failed" ? "change-badge--changed" : ""}`}>{watchlistVerdictLabel(watchlist.latestRunVerdict)}</span>
              <span className="change-badge">Every {watchlist.intervalMinutes} minutes</span>
              {watchlist.latestRun?.outcome ? <span className="change-badge">{watchlistOutcomeLabel(watchlist.latestRun.outcome)}</span> : null}
              <span className="change-badge">Next run {formatTimestamp(watchlist.nextScheduledRunAt ?? watchlist.nextRunAt)}</span>
              {watchlist.expiresAt ? <span className="change-badge">Expires {formatTimestamp(watchlist.expiresAt)}</span> : null}
              {watchlist.burstConfig?.enabled ? <span className="change-badge">Burst mode enabled</span> : null}
              {watchlist.lastCheckedAt ? <span className="change-badge">Last checked {formatTimestamp(watchlist.lastCheckedAt)}</span> : null}
              {watchlist.lastSuccessfulFetchAt ? <span className="change-badge">Last successful fetch {formatTimestamp(watchlist.lastSuccessfulFetchAt)}</span> : null}
              {watchlist.lastResolvedUrl ? <span className="change-badge">Resolved URL {watchlist.lastResolvedUrl}</span> : null}
              {watchlist.lastHttpStatus ? <span className="change-badge">HTTP {watchlist.lastHttpStatus}</span> : null}
              <span className="change-badge">Failures {watchlist.failureCount}</span>
              {watchlist.lastCaptureAt ? <span className="change-badge">Last capture {formatTimestamp(watchlist.lastCaptureAt)}</span> : null}
              {watchlist.lastChangeDetectedAt ? <span className="change-badge">Last change {formatTimestamp(watchlist.lastChangeDetectedAt)}</span> : null}
              {watchlist.latestCaptureHealth ? <span className={`change-badge ${watchlist.latestCaptureHealth !== "success" ? "change-badge--changed" : ""}`}>{watchlistHealthLabel(watchlist.latestCaptureHealth)}</span> : null}
              {watchlist.lastSuccessfulCheckpointId ? <span className="change-badge">Checkpoint {watchlist.lastSuccessfulCheckpointId}</span> : null}
              {watchlist.latestRun?.deliveries?.[0]?.payload?.conciseSummary ? <span className="change-badge">{watchlist.latestRun.deliveries[0].payload.conciseSummary}</span> : watchlist.latestRun?.changeSummary?.[0] ? <span className="change-badge">{watchlist.latestRun.changeSummary[0]}</span> : null}
            </div>
            <div className="history-row__actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "watchlist", id: watchlist.id })}>View runs</button>
              <button className="ghost-button" onClick={() => void triggerRetry(watchlist)}>Retry now</button>
              <button className="ghost-button" onClick={() => void toggleWatchlist(watchlist)}>{watchlist.status === "active" ? "Pause" : "Resume"}</button>
              {watchlist.webhookUrl ? <button className="ghost-button" onClick={() => void sendWebhookTest(watchlist)}>Test webhook</button> : null}
            </div>
          </article>
        ))}
        {watchlists.length === 0 ? <p className="notice">No watchlists yet.</p> : null}
      </div>
    </div>
  );
};

const WatchlistRunsView = ({ watchlistId, navigate }: { watchlistId: string; navigate: (route: Route) => void }) => {
  const { watchlist, runs, error, refresh } = useWatchlistRuns(watchlistId);
  const [actionMessage, setActionMessage] = useState<string | undefined>();

  if (error) {
    return <p className="notice notice--error">{error}</p>;
  }

  return (
    <div className="detail-layout">
      <div className="detail-header">
        <button className="ghost-button" onClick={() => navigate({ kind: "watchlists" })}>Back to watchlists</button>
        {watchlist ? <button className="ghost-button" onClick={() => void retryWatchlist(watchlist.id).then(async () => { setActionMessage("Watchlist recapture started."); await refresh(); })}>Retry now</button> : null}
        {watchlist ? <button className="ghost-button" onClick={() => void updateWatchlist(watchlist.id, { status: watchlist.status === "active" ? "paused" : "active" }).then(async () => { setActionMessage(`Watchlist ${watchlist.status === "active" ? "paused" : "active"}.`); await refresh(); })}>{watchlist?.status === "active" ? "Pause" : "Resume"}</button> : null}
      </div>
      <section className="headline-card headline-card--url">
        <div>
          <p className="eyebrow">Watchlist history</p>
          <h1>{watchlist?.requestedUrl ?? "Loading watchlist..."}</h1>
          <p className="hero-copy">These runs are projections over stored captures and comparisons. They describe observed changes only.</p>
        </div>
      </section>
      {actionMessage ? <p className="notice">{actionMessage}</p> : null}
      <div className="history-list history-list--timeline">
        {runs.map((run) => (
          <article key={run.id} className="history-row">
            <div className="history-row__time">
              <span className="history-row__dot" aria-hidden="true" />
              <div>
                <strong>{formatTimestamp(run.createdAt)}</strong>
                <p>{run.status}</p>
              </div>
            </div>
            <div className="history-row__badges">
              <span className={`change-badge ${run.status === "failed" || run.changeDetected || run.stateChanged ? "change-badge--changed" : ""}`}>{run.status === "failed" ? "Failed" : run.previousCaptureId || run.stateChanged ? (run.changeDetected || run.stateChanged ? "Change detected" : "No change detected") : "Baseline"}</span>
              {run.outcome ? <span className="change-badge">{watchlistOutcomeLabel(run.outcome)}</span> : null}
              {run.captureHealth ? <span className={`change-badge ${run.captureHealth !== "success" ? "change-badge--changed" : ""}`}>{watchlistHealthLabel(run.captureHealth)}</span> : null}
              {run.extractionDriftDetected ? <span className="change-badge change-badge--changed">Extraction drift note</span> : null}
              {run.deliveries?.[0]?.payload?.eventType ? <span className="change-badge">{watchlistEventLabel(run.deliveries[0].payload.eventType)}</span> : null}
              {run.notificationSummary ? <span className="change-badge">Deliveries {run.notificationSummary.total}</span> : null}
              {run.notificationSummary?.webhookSent ? <span className="change-badge">Webhook sent</span> : null}
              {run.notificationSummary?.webhookFailed ? <span className="change-badge change-badge--changed">Webhook failed</span> : null}
              {run.deliveries?.[0]?.payload?.conciseSummary ? <span className="change-badge">{run.deliveries[0].payload.conciseSummary}</span> : null}
              {run.changeSummary.slice(0, 2).map((line) => <span key={line} className="change-badge">{line}</span>)}
            </div>
            <div className="history-row__actions">
              {run.newerCaptureId ? <button className="ghost-button" onClick={() => navigate({ kind: "capture", id: run.newerCaptureId! })}>View capture</button> : null}
              {run.previousCaptureId && run.newerCaptureId ? <button className="ghost-button" onClick={() => navigate({ kind: "compare", url: watchlist?.requestedUrl ?? run.normalizedRequestedUrl, fromCaptureId: run.previousCaptureId!, toCaptureId: run.newerCaptureId! })}>Compare</button> : null}
            </div>
            <details className="details-card">
              <summary>Run details</summary>
              <div className="field-grid">
                <div className="field-grid__row">
                  <span>Outcome</span>
                  <strong>{watchlistOutcomeLabel(run.outcome)}</strong>
                </div>
                <div className="field-grid__row">
                  <span>HTTP status</span>
                  <strong>{run.httpStatus ?? "Not available"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Resolved URL</span>
                  <strong>{run.resolvedUrl ?? "Not available"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>State transition</span>
                  <strong>{run.availabilityTransition ?? (run.redirectChanged ? "redirect_changed" : run.stateChanged ? "state_changed" : "No state transition")}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Compare permalink</span>
                  <strong>{run.comparePath ?? "Not available"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Older checkpoint</span>
                  <strong>{run.checkpointIds.older ?? "Not available"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Newer checkpoint</span>
                  <strong>{run.checkpointIds.newer ?? "Not available"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Capture health</span>
                  <strong>{watchlistHealthLabel(run.captureHealth)}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Delivery summary</span>
                  <strong>{run.notificationSummary ? `${run.notificationSummary.localRecorded} local, ${run.notificationSummary.jsonRecorded} JSON, ${run.notificationSummary.webhookSent} webhook sent, ${run.notificationSummary.webhookFailed} webhook failed` : "No deliveries recorded"}</strong>
                </div>
              </div>
              {run.deliveries?.length ? (
                <div className="warning-stack">
                  {run.deliveries.map((delivery) => (
                    <div key={delivery.id} className="details-card">
                      <div className="field-grid">
                        <div className="field-grid__row">
                          <span>Delivery event</span>
                          <strong>{watchlistEventLabel(delivery.payload.eventType)}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Channel</span>
                          <strong>{delivery.kind} / {delivery.status}</strong>
                        </div>
                        <div className="field-grid__row field-grid__row--wide">
                          <span>Summary</span>
                          <strong>{delivery.payload.conciseSummary ?? run.changeSummary[0] ?? "Watchlist event"}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Verdict</span>
                          <strong>{delivery.payload.verdict ?? (run.status === "failed" ? "failed" : run.previousCaptureId ? (run.changeDetected ? "changed" : "unchanged") : "baseline")}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Changed fields</span>
                          <strong>{delivery.payload.changedFields ? Object.entries(delivery.payload.changedFields).filter(([, changed]) => changed).map(([field]) => field).join(", ") || "None" : "Not recorded"}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Compare permalink</span>
                          <strong>{delivery.payload.comparePermalink ?? delivery.payload.comparePath ?? run.comparePath ?? "Not available"}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Latest checkpoint</span>
                          <strong>{delivery.payload.latestCheckpointId ?? run.checkpointIds.newer ?? run.checkpointIds.older ?? "Not available"}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Extraction drift note</span>
                          <strong>{delivery.payload.extractionDriftDetected ? "Present" : "Not detected"}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Screenshot present</span>
                          <strong>{delivery.payload.screenshotPresent ? "Yes" : "No"}</strong>
                        </div>
                        <div className="field-grid__row field-grid__row--wide">
                          <span>Delivery target</span>
                          <strong>{delivery.target ?? delivery.payload.deliveryTarget ?? "Not applicable"}</strong>
                        </div>
                        <div className="field-grid__row">
                          <span>Run timestamp</span>
                          <strong>{formatTimestamp(delivery.payload.runTimestamp)}</strong>
                        </div>
                        <div className="field-grid__row field-grid__row--wide">
                          <span>Delivery error</span>
                          <strong>{delivery.errorMessage ?? delivery.payload.deliveryError ?? "None"}</strong>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </details>          </article>
        ))}
        {runs.length === 0 ? <p className="notice">No watchlist runs yet.</p> : null}
      </div>
    </div>
  );
};

const ComparisonView = ({
  comparison,
  normalizedUrl,
  error,
  isLoading,
  navigate
}: {
  comparison?: CaptureComparison;
  normalizedUrl?: string;
  error?: string;
  isLoading: boolean;
  navigate: (route: Route) => void;
}) => {
  const operatorKey = useOperatorKey(Boolean(comparison));
  const [actionMessage, setActionMessage] = useState<string | undefined>();
  const report = useMemo(
    () => (comparison ? buildComparisonReport(comparison, normalizedUrl, operatorKey) : undefined),
    [comparison, normalizedUrl, operatorKey]
  );

  if (error) {
    return <p className="notice notice--error">{error}</p>;
  }

  if (!comparison || !report) {
    return <p className="notice">{isLoading ? "Loading comparison..." : "Comparison not found."}</p>;
  }

  const trackedChangeCount = Object.values(comparison.fields).filter(Boolean).length;
  const hasBlockChanges =
    comparison.blockSummary.paragraphsAdded > 0 ||
    comparison.blockSummary.paragraphsRemoved > 0 ||
    comparison.blockSummary.headingsChanged > 0;
  const hasExtractionDrift = comparison.diagnostics.notes.length > 0;
  const hasWarnings =
    comparison.diagnostics.older.warnings.length > 0 || comparison.diagnostics.newer.warnings.length > 0;
  const hasMeaningfulChanges = trackedChangeCount > 0 || hasBlockChanges;
  const noTrackedChanges = !hasMeaningfulChanges && !hasExtractionDrift;
  const fieldRows = comparisonFieldRows(comparison);
  const valueRows = comparisonValueRows(comparison);
  const verdictTitle = noTrackedChanges
    ? "No detected changes between these observed captures"
    : "Differences detected between these observed captures";
  const verdictBody = noTrackedChanges
    ? "No tracked differences were detected in semantic content, metadata, title, author, claimed published date (page metadata), page kind, or extractor version. Expand the sections below to inspect the stored evidence."
    : "Differences were detected in tracked capture outputs. Review the observed field changes, block diff, and extraction diagnostics before drawing conclusions."
  ;

  const handleCopySummary = async () => {
    await copyText(comparisonSummaryText(report));
    setActionMessage("Summary copied.");
  };

  const handleCopyLink = async () => {
    await copyText(report.permalink);
    setActionMessage("Permalink copied.");
  };

  const handleExportJson = () => {
    downloadTextFile(`${comparisonFileStem(report)}.json`, JSON.stringify(report, null, 2), "application/json; charset=utf-8");
    setActionMessage("JSON report downloaded.");
  };

  const handleExportHtml = () => {
    downloadTextFile(`${comparisonFileStem(report)}.html`, buildComparisonReportHtml(report), "text/html; charset=utf-8");
    setActionMessage("HTML report downloaded.");
  };

  const handlePrintPdf = () => {
    window.print();
    setActionMessage("Print dialog opened for PDF export.");
  };

  return (
    <div className="detail-layout comparison-report">
      <div className="detail-header print-hidden">
        <button className="ghost-button" onClick={() => navigate({ kind: "home" })}>
          New capture
        </button>
        <button className="ghost-button" onClick={() => navigate({ kind: "history", url: normalizedUrl ?? comparison.normalizedRequestedUrl })}>
          View URL history
        </button>
        <button className="ghost-button" onClick={() => navigate({ kind: "capture", id: comparison.newer.capture.id })}>
          View newer capture
        </button>
      </div>

      <section className="headline-card headline-card--url">
        <div>
          <p className="eyebrow">Shareable comparison report</p>
          <h1>{normalizedUrl ?? comparison.normalizedRequestedUrl}</h1>
          <p className="hero-copy">{comparison.observationStatement}</p>
        </div>
      </section>

      <section className={`headline-card verdict-card ${noTrackedChanges ? "verdict-card--stable" : "verdict-card--changed"}`}>
        <div>
          <p className="eyebrow">Verdict</p>
          <h2>{verdictTitle}</h2>
          <p className="hero-copy">{verdictBody}</p>
        </div>
      </section>

      <div className="summary-grid">
        <SummaryCard label="Older observed at" value={formatTimestamp(comparison.older.observedAt)} />
        <SummaryCard label="Newer observed at" value={formatTimestamp(comparison.newer.observedAt)} tone="accent" />
        <SummaryCard label="Comparison basis" value={comparison.basis === "capture-id" ? "Capture IDs" : "Capture timestamps"} />
        <SummaryCard
          label="Detected changes"
          value={noTrackedChanges ? "No tracked changes detected" : `${trackedChangeCount} of 7 tracked fields`}
        />
      </div>

      <Section title="Report Actions">
        <div className="report-actions print-hidden">
          <button className="ghost-button" onClick={() => void handleCopySummary()}>
            Copy summary
          </button>
          <button className="ghost-button" onClick={() => void handleCopyLink()}>
            Copy permalink
          </button>
          <button className="ghost-button" onClick={handleExportJson}>
            Export JSON
          </button>
          <button className="ghost-button" onClick={handleExportHtml}>
            Export HTML
          </button>
          <button className="ghost-button" onClick={handlePrintPdf}>
            Export PDF
          </button>
        </div>
        <div className="field-grid">
          <div className="field-grid__row field-grid__row--wide">
            <span>Permalink</span>
            <strong>{report.permalink}</strong>
          </div>
          <div className="field-grid__row">
            <span>Report generated</span>
            <strong>{formatTimestamp(report.generatedAt)}</strong>
          </div>
        </div>
        {actionMessage ? <p className="notice">{actionMessage}</p> : null}
      </Section>

      <Section title="What This Proves">
        <ul className="evidence-list">
          {report.whatThisProves.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Section>

      <Section title="What This Does Not Prove">
        <ul className="evidence-list">
          {report.whatThisDoesNotProve.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Section>

      <Section title="Evidence Layers">
        <EvidenceLayersSection layers={report.evidenceLayers} />
      </Section>

      <Section title="Change Summary">
        <p className="metric-line">These are differences between two stored captures of the same normalized URL.</p>
        <ul className="evidence-list">
          {comparison.changeSummary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>

      <Section title="Observed Field Changes">
        <div className="field-grid">
          {fieldRows.map((row) => (
            <div key={row.label} className="field-grid__row">
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Detailed Diff">
        {noTrackedChanges ? (
          <p className="notice">Canonical preview unchanged across both captures. Expand below to inspect the stored previews.</p>
        ) : null}
        <details className="details-card" open={!noTrackedChanges}>
          <summary>Expand observed values and canonical previews</summary>
          <div className="comparison-columns">
            <div className="panel panel--nested">
              <h3>Older observed values</h3>
              <div className="field-grid comparison-field-grid">
                {valueRows.map((row) => (
                  <div key={`${row.label}-older`} className="field-grid__row">
                    <span>{row.label}</span>
                    <strong>{row.older}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel panel--nested">
              <h3>Newer observed values</h3>
              <div className="field-grid comparison-field-grid">
                {valueRows.map((row) => (
                  <div key={`${row.label}-newer`} className="field-grid__row">
                    <span>{row.label}</span>
                    <strong>{row.newer}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="comparison-columns">
            <div>
              <h3>Older canonical preview</h3>
              <pre>{formatBlockPreview(comparison.older.canonicalContent?.blocks)}</pre>
            </div>
            <div>
              <h3>Newer canonical preview</h3>
              <pre>{formatBlockPreview(comparison.newer.canonicalContent?.blocks)}</pre>
            </div>
          </div>
        </details>
      </Section>

      <Section title="Block-Level Canonical Diff">
        <div className="field-grid">
          <div className="field-grid__row">
            <span>Paragraphs added</span>
            <strong>{comparison.blockSummary.paragraphsAdded}</strong>
          </div>
          <div className="field-grid__row">
            <span>Paragraphs removed</span>
            <strong>{comparison.blockSummary.paragraphsRemoved}</strong>
          </div>
          <div className="field-grid__row">
            <span>Headings changed</span>
            <strong>{comparison.blockSummary.headingsChanged}</strong>
          </div>
        </div>
        {!hasBlockChanges ? (
          <p className="notice">No block-level additions, removals, or heading changes were detected.</p>
        ) : null}

        <details className="details-card" open={hasBlockChanges}>
          <summary>Paragraph and heading samples</summary>
          <div className="comparison-columns">
            <div>
              <h3>Added paragraphs</h3>
              <pre>{comparison.blockSummary.addedParagraphSamples.join("\n\n") || "No added paragraph samples."}</pre>
            </div>
            <div>
              <h3>Removed paragraphs</h3>
              <pre>{comparison.blockSummary.removedParagraphSamples.join("\n\n") || "No removed paragraph samples."}</pre>
            </div>
          </div>
          <pre>
            {comparison.blockSummary.changedHeadingSamples.length
              ? JSON.stringify(comparison.blockSummary.changedHeadingSamples, null, 2)
              : "No heading changes detected."}
          </pre>
        </details>
      </Section>

      <Section title="Extraction Diagnostics">
        {!hasExtractionDrift && !hasWarnings ? (
          <p className="notice">No extraction drift or extraction warnings were detected for these two captures.</p>
        ) : null}
        <details className="details-card" open={hasExtractionDrift || hasWarnings || hasMeaningfulChanges}>
          <summary>Expand extraction diagnostics</summary>
          <div className="comparison-columns">
            <div className="panel panel--nested">
              <h3>Older capture</h3>
              <div className="field-grid">
                <div className="field-grid__row">
                  <span>Capture ID</span>
                  <strong>{comparison.older.capture.id}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Page kind</span>
                  <strong>{comparison.diagnostics.older.pageKind ?? "Not detected"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Extractor version</span>
                  <strong>{comparison.diagnostics.older.extractorVersion ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Extraction status</span>
                  <strong>{comparison.diagnostics.older.extractionStatus ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Confidence</span>
                  <strong>{formatPercent(comparison.diagnostics.older.confidence)}</strong>
                </div>
              </div>
              {comparison.diagnostics.older.warnings.length ? (
                <div className="warning-stack">
                  {comparison.diagnostics.older.warnings.map((warning) => (
                    <p key={`older-${warning}`} className="notice notice--warning">
                      {warning}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="notice">No extraction warnings recorded.</p>
              )}
            </div>
            <div className="panel panel--nested">
              <h3>Newer capture</h3>
              <div className="field-grid">
                <div className="field-grid__row">
                  <span>Capture ID</span>
                  <strong>{comparison.newer.capture.id}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Page kind</span>
                  <strong>{comparison.diagnostics.newer.pageKind ?? "Not detected"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Extractor version</span>
                  <strong>{comparison.diagnostics.newer.extractorVersion ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Extraction status</span>
                  <strong>{comparison.diagnostics.newer.extractionStatus ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Confidence</span>
                  <strong>{formatPercent(comparison.diagnostics.newer.confidence)}</strong>
                </div>
              </div>
              {comparison.diagnostics.newer.warnings.length ? (
                <div className="warning-stack">
                  {comparison.diagnostics.newer.warnings.map((warning) => (
                    <p key={`newer-${warning}`} className="notice notice--warning">
                      {warning}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="notice">No extraction warnings recorded.</p>
              )}
            </div>
          </div>

          {comparison.diagnostics.notes.length ? (
            <div className="warning-stack">
              {comparison.diagnostics.notes.map((note) => (
                <p key={note} className="notice notice--warning">
                  {note}
                </p>
              ))}
            </div>
          ) : null}
        </details>
      </Section>

      <Section title="Verification Appendix">
        <VerificationOrderSection />
        <details className="details-card" open={hasMeaningfulChanges}>
          <summary>Expand capture settings and PDF diagnostics</summary>
          <div className="comparison-columns">
            <div className="panel panel--nested">
              <h3>Older observed capture</h3>
              <div className="field-grid">
                <div className="field-grid__row">
                  <span>Screenshot captured</span>
                  <strong>{toYesNo(report.verificationAppendix.older.screenshotCaptured)}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Screenshot hash</span>
                  <strong>{report.verificationAppendix.older.screenshotHash ?? "Not recorded"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Viewport</span>
                  <strong>{report.verificationAppendix.older.viewport}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Device preset</span>
                  <strong>{report.verificationAppendix.older.devicePreset}</strong>
                </div>
                <div className="field-grid__row field-grid__row--wide">
                  <span>User agent</span>
                  <strong>{report.verificationAppendix.older.userAgent}</strong>
                </div>
              </div>
              <PdfQualityDiagnosticsSection diagnostics={report.verificationAppendix.older.pdfQualityDiagnostics} />
            </div>
            <div className="panel panel--nested">
              <h3>Newer observed capture</h3>
              <div className="field-grid">
                <div className="field-grid__row">
                  <span>Screenshot captured</span>
                  <strong>{toYesNo(report.verificationAppendix.newer.screenshotCaptured)}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Screenshot hash</span>
                  <strong>{report.verificationAppendix.newer.screenshotHash ?? "Not recorded"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Viewport</span>
                  <strong>{report.verificationAppendix.newer.viewport}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Device preset</span>
                  <strong>{report.verificationAppendix.newer.devicePreset}</strong>
                </div>
                <div className="field-grid__row field-grid__row--wide">
                  <span>User agent</span>
                  <strong>{report.verificationAppendix.newer.userAgent}</strong>
                </div>
              </div>
              <PdfQualityDiagnosticsSection diagnostics={report.verificationAppendix.newer.pdfQualityDiagnostics} />
            </div>
          </div>
        </details>
      </Section>

      <Section title="Proof Grounding">
        {noTrackedChanges ? (
          <p className="notice">No tracked changes were detected. Expand below to inspect the proof bundle hashes for both observed captures.</p>
        ) : null}
        <details className="details-card" open={!noTrackedChanges}>
          <summary>Expand proof grounding</summary>
          <div className="comparison-columns">
            <div className="panel panel--nested">
              <h3>Older observed capture</h3>
              <div className="field-grid">
                <div className="field-grid__row">
                  <span>Semantic content hash</span>
                  <strong>{comparison.older.capture.canonicalContentHash ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Metadata hash</span>
                  <strong>{comparison.older.capture.metadataHash ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Proof bundle hash</span>
                  <strong>{comparison.older.capture.proofBundleHash ?? "Pending"}</strong>
                </div>
              </div>
            </div>
            <div className="panel panel--nested">
              <h3>Newer observed capture</h3>
              <div className="field-grid">
                <div className="field-grid__row">
                  <span>Semantic content hash</span>
                  <strong>{comparison.newer.capture.canonicalContentHash ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Metadata hash</span>
                  <strong>{comparison.newer.capture.metadataHash ?? "Pending"}</strong>
                </div>
                <div className="field-grid__row">
                  <span>Proof bundle hash</span>
                  <strong>{comparison.newer.capture.proofBundleHash ?? "Pending"}</strong>
                </div>
              </div>
            </div>
          </div>
        </details>
      </Section>

      <Section title="Verification Footer">
        <p className="metric-line">
          These references tie the comparison back to the two observed proof bundles and the operator key used for transparency checkpoints.
        </p>
        <div className="comparison-columns">
          <div className="panel panel--nested">
            <h3>Older capture references</h3>
            <div className="field-grid comparison-field-grid">
              <div className="field-grid__row">
                <span>Checkpoint</span>
                <strong>{report.verificationFooter.older.transparencyCheckpointId ?? "Not available"}</strong>
              </div>
              <div className="field-grid__row">
                <span>Log entry</span>
                <strong>{report.verificationFooter.older.transparencyLogEntryHash ?? "Not available"}</strong>
              </div>
              <div className="field-grid__row">
                <span>Merkle root</span>
                <strong>{report.verificationFooter.older.merkleRoot ?? "Not available"}</strong>
              </div>
            </div>
          </div>
          <div className="panel panel--nested">
            <h3>Newer capture references</h3>
            <div className="field-grid comparison-field-grid">
              <div className="field-grid__row">
                <span>Checkpoint</span>
                <strong>{report.verificationFooter.newer.transparencyCheckpointId ?? "Not available"}</strong>
              </div>
              <div className="field-grid__row">
                <span>Log entry</span>
                <strong>{report.verificationFooter.newer.transparencyLogEntryHash ?? "Not available"}</strong>
              </div>
              <div className="field-grid__row">
                <span>Merkle root</span>
                <strong>{report.verificationFooter.newer.merkleRoot ?? "Not available"}</strong>
              </div>
            </div>
          </div>
        </div>
        <div className="field-grid comparison-field-grid">
          <div className="field-grid__row">
            <span>Operator ID</span>
            <strong>{report.operatorKey?.operatorId ?? "Not available"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Operator key ID</span>
            <strong>{report.operatorKey?.keyId ?? "Not available"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Operator key fingerprint</span>
            <strong>{report.operatorKey?.publicKeySha256 ?? "Not available"}</strong>
          </div>
          <div className="field-grid__row">
            <span>Signature algorithm</span>
            <strong>{report.operatorKey?.algorithm ?? "Not available"}</strong>
          </div>
        </div>
      </Section>
    </div>
  );
};
export const App = () => {
  const [route, navigate] = useRoute();
  const captureDetail = useCaptureDetail(route.kind === "capture" ? route.id : undefined);
  const comparisonState = useComparison(route.kind === "compare" ? route : undefined);
  const page = useMemo(() => {
    if (route.kind === "verify") {
      return <VerifierView goHome={() => navigate({ kind: "home" })} />;
    }

    if (route.kind === "capture") {
      return (
        <CaptureDetailView
          detail={captureDetail.detail}
          isLoading={captureDetail.isLoading}
          error={captureDetail.error}
          navigate={navigate}
        />
      );
    }

    if (route.kind === "history") {
      return <HistoryView url={route.url} navigate={navigate} />;
    }

    if (route.kind === "compare") {
      return (
        <ComparisonView
          comparison={comparisonState.comparison}
          normalizedUrl={comparisonState.normalizedUrl}
          error={comparisonState.error}
          isLoading={comparisonState.isLoading}
          navigate={navigate}
        />
      );
    }

    if (route.kind === "watchlists") {
      return <WatchlistsView navigate={navigate} />;
    }

    if (route.kind === "watchlist") {
      return <WatchlistRunsView watchlistId={route.id} navigate={navigate} />;
    }

    return <HomeView onCreated={(capture) => navigate({ kind: "capture", id: capture.id })} navigate={navigate} />;
  }, [
    captureDetail.detail,
    captureDetail.error,
    captureDetail.isLoading,
    comparisonState.comparison,
    comparisonState.error,
    comparisonState.isLoading,
    comparisonState.normalizedUrl,
    navigate,
    route
  ]);

  return <div className="app-shell">{page}</div>;
};







































