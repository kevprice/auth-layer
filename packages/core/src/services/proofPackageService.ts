import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AttestationBundle,
  CanonicalContent,
  CanonicalMetadata,
  CaptureDetail,
  LineageBundle,
  OperatorPublicKey,
  ProofBundle,
  ProofPackageDiagnostics,
  ProofPackageManifest,
  ProofPackageVerificationCheck,
  ProofPackageVerificationReport,
  RawSnapshot,
  PdfApprovalReceipt,
  TransparencyCheckpoint,
  TransparencyInclusionProof,
  TransparencyLogEntry,
  TransparencyReceipt
} from "@auth-layer/shared";
import { computeContentAttestationHash, hashAttestationBundle, hashLineageBundle, summarizeAttestationBundle, summarizeLineageBundle, validateLineageBundle } from "@auth-layer/shared";

import type { CaptureRepository } from "../repositories/captureRepository.js";
import type { ObjectStore } from "../storage/objectStore.js";
import { hashStableValue, stableStringify } from "../utils/stableJson.js";
import { hashMerkleLeaf, verifyMerkleInclusionProof } from "../utils/merkleTransparency.js";
import { buildEvidenceLayerSummaries, derivePdfQualityDiagnostics } from "../utils/evidenceSummaries.js";
import { HashService } from "./hashService.js";
import { buildArticleRevisionLineage } from "./articleService.js";
import { verifyContentAttestationSignature } from "./attestationService.js";
import { verifyPdfApprovalReceiptSignature } from "./pdfApprovalService.js";
import type { CaptureProcessor } from "./captureProcessor.js";
import type { TimestampProvider } from "./timestampProvider.js";
import type { TransparencyLogService } from "./transparencyLogService.js";
import { verifyTransparencyCheckpointSignature } from "./transparencyLogService.js";

const MANIFEST_FILE = "manifest.json";
const CAPTURE_RECORD_FILE = "capture-record.json";
const RAW_SNAPSHOT_FILE = "raw-snapshot.json";
const RAW_HTML_FILE = "raw-snapshot.html";
const RAW_PDF_FILE = "source-file.pdf";
const RAW_IMAGE_FILE = "source-image.bin";
const SCREENSHOT_FILE = "rendered-screenshot.png";
const CANONICAL_CONTENT_FILE = "canonical-content.json";
const METADATA_FILE = "metadata.json";
const DIAGNOSTICS_FILE = "diagnostics.json";
const LINEAGE_BUNDLE_FILE = "lineage.json";
const ATTESTATION_BUNDLE_FILE = "attestations.json";
const PROOF_BUNDLE_FILE = "proof-bundle.json";
const RECEIPT_FILE = "receipt.json";
const APPROVAL_RECEIPT_FILE = "approval-receipt.json";
const TRANSPARENCY_EXPORT_FILE = "transparency-export.json";
const TRANSPARENCY_LOG_ENTRY_FILE = "transparency-log-entry.json";
const TRANSPARENCY_CHECKPOINT_FILE = "transparency-checkpoint.json";
const TRANSPARENCY_INCLUSION_PROOF_FILE = "transparency-inclusion-proof.json";
const OPERATOR_PUBLIC_KEY_FILE = "operator-public-key.json";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, stableStringify(value));
};

const renderedScreenshotHash = (renderedEvidence?: CaptureDetail["capture"]["renderedEvidence"]): string | undefined =>
  renderedEvidence?.screenshot?.hash ?? renderedEvidence?.screenshotHash;

const buildRawSnapshot = (input: {
  capture: {
    requestedUrl: string;
    finalUrl?: string;
    fetchedAt?: string;
    httpStatus?: number;
    headers?: Record<string, string>;
    contentType?: string;
    charset?: string;
    artifacts: { rawHtmlStorageKey?: string };
  };
  schemaVersion: number;
}): RawSnapshot | undefined => {
  if (!input.capture.finalUrl || !input.capture.fetchedAt || input.capture.httpStatus === undefined || !input.capture.artifacts.rawHtmlStorageKey) {
    return undefined;
  }

  return {
    schemaVersion: input.schemaVersion,
    requestedUrl: input.capture.requestedUrl,
    finalUrl: input.capture.finalUrl,
    fetchedAt: input.capture.fetchedAt,
    httpStatus: input.capture.httpStatus,
    headers: input.capture.headers ?? {},
    contentType: input.capture.contentType,
    charset: input.capture.charset,
    rawHtmlStorageKey: input.capture.artifacts.rawHtmlStorageKey
  };
};


const buildProofPackageDiagnostics = (input: {
  detail: CaptureDetail;
  transparencyLogEntry?: TransparencyLogEntry;
  transparencyCheckpoint?: TransparencyCheckpoint;
  lineageBundle?: LineageBundle;
  attestationBundle?: AttestationBundle;
}): ProofPackageDiagnostics => ({
  schemaVersion: 2,
  artifactType: input.detail.capture.artifactType,
  captureId: input.detail.capture.id,
  extractorVersion: input.detail.canonicalContent?.extractorVersion ?? input.detail.capture.extractorVersion,
  normalizationVersion: input.detail.canonicalContent?.normalizationVersion ?? input.detail.capture.normalizationVersion,
  pageKind: input.detail.capture.pageKind,
  contentExtractionStatus: input.detail.capture.contentExtractionStatus,
  canonicalContent: input.detail.canonicalContent
    ? {
        schemaVersion: input.detail.canonicalContent.schemaVersion,
        stats: input.detail.canonicalContent.stats,
        diagnostics: input.detail.canonicalContent.diagnostics
      }
    : undefined,
  metadata: input.detail.metadata
    ? {
        schemaVersion: input.detail.metadata.schemaVersion,
        fieldProvenance: input.detail.metadata.fieldProvenance
      }
    : undefined,
  renderedEvidence: input.detail.capture.renderedEvidence
    ? {
        screenshot: input.detail.capture.renderedEvidence.screenshot
          ? {
              hash: input.detail.capture.renderedEvidence.screenshot.hash,
              format: input.detail.capture.renderedEvidence.screenshot.format,
              mediaType: input.detail.capture.renderedEvidence.screenshot.mediaType
            }
          : renderedScreenshotHash(input.detail.capture.renderedEvidence)
            ? { hash: renderedScreenshotHash(input.detail.capture.renderedEvidence), format: "png", mediaType: "image/png" }
            : undefined,
        viewport: input.detail.capture.renderedEvidence.viewport,
        device: input.detail.capture.renderedEvidence.device
          ? {
              devicePreset: input.detail.capture.renderedEvidence.device.devicePreset,
              userAgent: input.detail.capture.renderedEvidence.device.userAgent,
              userAgentLabel: input.detail.capture.renderedEvidence.device.userAgentLabel
            }
          : input.detail.capture.renderedEvidence.userAgentLabel
            ? { userAgentLabel: input.detail.capture.renderedEvidence.userAgentLabel }
            : undefined,
      }
    : undefined,
  approval: input.detail.capture.approvalReceiptId || input.detail.capture.actorAccountId || input.detail.capture.approvalType
    ? {
        approvalReceiptId: input.detail.capture.approvalReceiptId,
        actorAccountId: input.detail.capture.actorAccountId,
        approvalType: input.detail.capture.approvalType,
        approvalScope: input.detail.capture.approvalScope,
        approvalMethod: input.detail.capture.approvalMethod
      }
    : undefined,
  transparency:
    input.transparencyLogEntry || input.transparencyCheckpoint || input.detail.receipt
      ? {
          logEntryHash: input.transparencyLogEntry?.entryHash ?? input.detail.receipt?.transparencyLogEntryHash,
          checkpointId: input.transparencyCheckpoint?.checkpointId ?? input.detail.receipt?.transparencyCheckpointId,
          merkleRoot: input.transparencyCheckpoint?.rootHash ?? input.detail.receipt?.merkleRoot
        }
      : undefined,
  evidenceLayers: buildEvidenceLayerSummaries(input.detail),
  pdfQualityDiagnostics: derivePdfQualityDiagnostics(input.detail),
  lineageSummary: summarizeLineageBundle(input.lineageBundle),
  attestationSummary: summarizeAttestationBundle(input.attestationBundle)
});
const requiredCheck = (name: string, ok: boolean, details: string): ProofPackageVerificationCheck => ({ name, ok, details });

export class ProofPackageService {
  constructor(
    private readonly repository: CaptureRepository,
    private readonly objectStore: ObjectStore,
    private readonly processor: CaptureProcessor,
    private readonly transparencyLogService: TransparencyLogService
  ) {}

  async writePackage(captureId: string, outputDirectory: string, options?: { lineageBundle?: LineageBundle }): Promise<{ manifestPath: string }> {
    const detail = await this.processor.loadCaptureDetail(captureId);
    if (!detail) {
      throw new Error(`Capture ${captureId} not found`);
    }

    const transparencyExport = await this.processor.loadCaptureTransparencyExport(captureId);
    if (!transparencyExport) {
      throw new Error(`Transparency export for capture ${captureId} is not available`);
    }

    const { entry, checkpoint, inclusionProof } = await this.transparencyLogService.getCaptureTransparency(
      captureId,
      detail.receipt?.transparencyCheckpointId
    );
    const operatorPublicKey = this.transparencyLogService.getOperatorPublicKey();
    const currentArticleObject = detail.metadata?.articleObject ?? detail.canonicalContent?.articleObject;
    const previousCompletedCapture = detail.capture.artifactType === "article-publish"
      ? (await this.repository.listCapturesForUrl(detail.capture.normalizedRequestedUrl)).find(
          (candidate) => candidate.id !== detail.capture.id && candidate.status === "completed"
        )
      : undefined;
    const previousDetail = previousCompletedCapture ? await this.processor.loadCaptureDetail(previousCompletedCapture.id) : undefined;
    const previousArticleObject = previousDetail?.metadata?.articleObject ?? previousDetail?.canonicalContent?.articleObject;
    const sameArticleIdentity = Boolean(
      currentArticleObject &&
      previousArticleObject &&
      currentArticleObject.siteIdentifier === previousArticleObject.siteIdentifier &&
      currentArticleObject.postId === previousArticleObject.postId
    );
    const lineageBundle = options?.lineageBundle ?? (
      detail.capture.artifactType === "article-publish" && detail.canonicalContent?.bodyMarkdown && sameArticleIdentity
        ? buildArticleRevisionLineage({
            currentCaptureId: detail.capture.id,
            currentText: detail.canonicalContent.bodyMarkdown,
            currentTitle: detail.metadata?.title ?? detail.canonicalContent.title,
            currentCapturedAt: detail.capture.capturedAt,
            currentSourceLabel: detail.capture.sourceLabel,
            previousCaptureId: previousDetail?.capture.id,
            previousText: previousDetail?.canonicalContent?.bodyMarkdown,
            previousTitle: previousDetail?.metadata?.title ?? previousDetail?.canonicalContent?.title,
            previousCapturedAt: previousDetail?.capture.capturedAt,
            previousSourceLabel: previousDetail?.capture.sourceLabel
          })
        : undefined
    );
    const lineageValidation = lineageBundle ? validateLineageBundle(lineageBundle) : undefined;
    if (lineageValidation && !lineageValidation.ok) {
      throw new Error(`Cannot export proof package with invalid lineage: ${lineageValidation.errors.map((warning) => warning.message).join("; ")}`);
    }
    const lineageBundleHash = lineageBundle ? await hashLineageBundle(lineageBundle) : undefined;
    const diagnostics = buildProofPackageDiagnostics({
      detail,
      transparencyLogEntry: entry,
      transparencyCheckpoint: checkpoint,
      lineageBundle,
      attestationBundle: detail.attestationBundle
    });
    const rawHtml = detail.capture.artifacts.rawHtmlStorageKey
      ? await this.objectStore.getText(detail.capture.artifacts.rawHtmlStorageKey)
      : undefined;
    const rawPdf = detail.capture.artifacts.rawPdfStorageKey
      ? await this.objectStore.getObject(detail.capture.artifacts.rawPdfStorageKey)
      : undefined;
    const rawImage = detail.capture.artifacts.rawImageStorageKey
      ? await this.objectStore.getObject(detail.capture.artifacts.rawImageStorageKey)
      : undefined;
    const screenshot = detail.capture.artifacts.screenshotStorageKey
      ? await this.objectStore.getObject(detail.capture.artifacts.screenshotStorageKey)
      : undefined;
    const rawSnapshot = buildRawSnapshot({
      capture: detail.capture,
      schemaVersion: detail.proofBundle?.rawSnapshotSchemaVersion ?? 1
    });

    const targetDirectory = resolve(outputDirectory);
    await mkdir(targetDirectory, { recursive: true });

    if (rawSnapshot) {
      await writeJson(join(targetDirectory, RAW_SNAPSHOT_FILE), rawSnapshot);
    }
    if (rawHtml !== undefined) {
      await writeFile(join(targetDirectory, RAW_HTML_FILE), rawHtml, "utf8");
    }
    if (rawPdf) {
      await writeFile(join(targetDirectory, RAW_PDF_FILE), rawPdf.body);
    }
    if (rawImage) {
      await writeFile(join(targetDirectory, RAW_IMAGE_FILE), rawImage.body);
    }
    if (screenshot) {
      await writeFile(join(targetDirectory, SCREENSHOT_FILE), screenshot.body);
    }
    if (lineageBundle) {
      await writeJson(join(targetDirectory, LINEAGE_BUNDLE_FILE), lineageBundle);
    }
    if (detail.attestationBundle) {
      await writeJson(join(targetDirectory, ATTESTATION_BUNDLE_FILE), detail.attestationBundle);
    }

    const exportedCapture = { ...detail.capture };
    await writeJson(join(targetDirectory, CAPTURE_RECORD_FILE), exportedCapture);
    if (detail.canonicalContent) {
      await writeJson(join(targetDirectory, CANONICAL_CONTENT_FILE), detail.canonicalContent);
    }
    if (detail.metadata) {
      await writeJson(join(targetDirectory, METADATA_FILE), detail.metadata);
    }
    await writeJson(join(targetDirectory, DIAGNOSTICS_FILE), diagnostics);
    if (detail.proofBundle) {
      await writeJson(join(targetDirectory, PROOF_BUNDLE_FILE), detail.proofBundle);
    }
    if (detail.receipt) {
      await writeJson(join(targetDirectory, RECEIPT_FILE), detail.receipt);
    }
    if (detail.approvalReceipt) {
      await writeJson(join(targetDirectory, APPROVAL_RECEIPT_FILE), detail.approvalReceipt);
    }
    const exportedTransparency = { ...transparencyExport, capture: exportedCapture, lineageBundle, attestationBundle: detail.attestationBundle };
    await writeJson(join(targetDirectory, TRANSPARENCY_EXPORT_FILE), exportedTransparency);
    if (entry) {
      await writeJson(join(targetDirectory, TRANSPARENCY_LOG_ENTRY_FILE), entry);
    }
    if (checkpoint) {
      await writeJson(join(targetDirectory, TRANSPARENCY_CHECKPOINT_FILE), checkpoint);
    }
    if (inclusionProof) {
      await writeJson(join(targetDirectory, TRANSPARENCY_INCLUSION_PROOF_FILE), inclusionProof);
    }
    await writeJson(join(targetDirectory, OPERATOR_PUBLIC_KEY_FILE), operatorPublicKey);

    const manifest: ProofPackageManifest = {
      schemaVersion: 9,
      artifactType: detail.capture.artifactType,
      sourceLabel: detail.capture.sourceLabel,
      fileName: detail.capture.fileName,
      mediaType: detail.capture.mediaType,
      byteSize: detail.capture.byteSize,
      packageType: "auth-layer-proof-package",
      exportedAt: transparencyExport.exportedAt,
      captureId: detail.capture.id,
      requestedUrl: detail.capture.requestedUrl,
      finalUrl: detail.capture.finalUrl,
      proofBundleHash: detail.capture.proofBundleHash,
      lineageBundleHash,
      attestationBundleHash: detail.proofBundle?.attestationBundleHash,
      canonicalContentHash: detail.capture.canonicalContentHash,
      metadataHash: detail.capture.metadataHash,
      rawSnapshotHash: detail.capture.rawSnapshotHash,
      hashAlgorithm: detail.capture.hashAlgorithm,
      extractorVersion: detail.capture.extractorVersion,
      normalizationVersion: detail.capture.normalizationVersion,
      files: {
        manifest: { path: MANIFEST_FILE, mediaType: "application/json; charset=utf-8" },
        rawSnapshot: { path: RAW_SNAPSHOT_FILE, mediaType: "application/json; charset=utf-8", optional: !rawSnapshot },
        rawHtml: { path: RAW_HTML_FILE, mediaType: "text/html; charset=utf-8", optional: rawHtml === undefined },
        rawPdf: { path: RAW_PDF_FILE, mediaType: detail.capture.mediaType ?? "application/pdf", optional: rawPdf === undefined },
        rawImage: { path: RAW_IMAGE_FILE, mediaType: detail.capture.mediaType ?? "application/octet-stream", optional: rawImage === undefined },
        screenshot: { path: SCREENSHOT_FILE, mediaType: screenshot?.contentType ?? "image/png", optional: screenshot === undefined },
        captureRecord: { path: CAPTURE_RECORD_FILE, mediaType: "application/json; charset=utf-8" },
        canonicalContent: { path: CANONICAL_CONTENT_FILE, mediaType: "application/json; charset=utf-8", optional: !detail.canonicalContent },
        metadata: { path: METADATA_FILE, mediaType: "application/json; charset=utf-8", optional: !detail.metadata },
        diagnostics: { path: DIAGNOSTICS_FILE, mediaType: "application/json; charset=utf-8" },
        lineageBundle: { path: LINEAGE_BUNDLE_FILE, mediaType: "application/json; charset=utf-8", optional: !lineageBundle },
        attestationBundle: { path: ATTESTATION_BUNDLE_FILE, mediaType: "application/json; charset=utf-8", optional: !detail.attestationBundle },
        proofBundle: { path: PROOF_BUNDLE_FILE, mediaType: "application/json; charset=utf-8", optional: !detail.proofBundle },
        receipt: { path: RECEIPT_FILE, mediaType: "application/json; charset=utf-8", optional: !detail.receipt },
        approvalReceipt: { path: APPROVAL_RECEIPT_FILE, mediaType: "application/json; charset=utf-8", optional: !detail.approvalReceipt },
        transparencyExport: { path: TRANSPARENCY_EXPORT_FILE, mediaType: "application/json; charset=utf-8" },
        transparencyLogEntry: { path: TRANSPARENCY_LOG_ENTRY_FILE, mediaType: "application/json; charset=utf-8", optional: !entry },
        transparencyCheckpoint: { path: TRANSPARENCY_CHECKPOINT_FILE, mediaType: "application/json; charset=utf-8", optional: !checkpoint },
        transparencyInclusionProof: { path: TRANSPARENCY_INCLUSION_PROOF_FILE, mediaType: "application/json; charset=utf-8", optional: !inclusionProof },
        operatorPublicKey: { path: OPERATOR_PUBLIC_KEY_FILE, mediaType: "application/json; charset=utf-8" }
      }
    };

    await writeJson(join(targetDirectory, MANIFEST_FILE), manifest);
    return { manifestPath: join(targetDirectory, MANIFEST_FILE) };
  }
}

export const verifyProofPackageDirectory = async (
  directory: string,
  options?: {
    timestampProvider?: TimestampProvider;
    trustedOperatorKeys?: OperatorPublicKey[];
    checkpoint?: TransparencyCheckpoint;
    inspectLineage?: boolean;
  }
): Promise<ProofPackageVerificationReport> => {
  const targetDirectory = resolve(directory);
  const readRequiredJson = async <T>(relativePath: string): Promise<T> =>
    JSON.parse(await readFile(join(targetDirectory, relativePath), "utf8")) as T;
  const readOptionalJson = async <T>(relativePath: string, optional?: boolean): Promise<T | undefined> => {
    if (optional) {
      try {
        return JSON.parse(await readFile(join(targetDirectory, relativePath), "utf8")) as T;
      } catch {
        return undefined;
      }
    }

    return readRequiredJson<T>(relativePath);
  };

  const manifest = await readRequiredJson<ProofPackageManifest>(MANIFEST_FILE);
  const captureRecord = await readRequiredJson<{ id: string; rawSnapshotHash?: string; canonicalContentHash?: string; metadataHash?: string; proofBundleHash?: string; lineageBundleHash?: string; attestationBundleHash?: string }>(
    manifest.files.captureRecord.path
  );
  const rawSnapshot = await readOptionalJson<RawSnapshot>(manifest.files.rawSnapshot.path, manifest.files.rawSnapshot.optional);
  const rawHtml = manifest.files.rawHtml.optional
    ? await readFile(join(targetDirectory, manifest.files.rawHtml.path), "utf8").catch(() => undefined)
    : await readFile(join(targetDirectory, manifest.files.rawHtml.path), "utf8");
  const rawPdf = manifest.files.rawPdf
    ? manifest.files.rawPdf.optional
      ? await readFile(join(targetDirectory, manifest.files.rawPdf.path)).catch(() => undefined)
      : await readFile(join(targetDirectory, manifest.files.rawPdf.path))
    : undefined;
  const rawImage = manifest.files.rawImage
    ? manifest.files.rawImage.optional
      ? await readFile(join(targetDirectory, manifest.files.rawImage.path)).catch(() => undefined)
      : await readFile(join(targetDirectory, manifest.files.rawImage.path))
    : undefined;
  const canonicalContent = await readOptionalJson<CanonicalContent>(manifest.files.canonicalContent.path, manifest.files.canonicalContent.optional);
  const metadata = await readOptionalJson<CanonicalMetadata>(manifest.files.metadata.path, manifest.files.metadata.optional);
  const screenshot = manifest.files.screenshot
    ? manifest.files.screenshot.optional
      ? await readFile(join(targetDirectory, manifest.files.screenshot.path)).catch(() => undefined)
      : await readFile(join(targetDirectory, manifest.files.screenshot.path))
    : undefined;
  const diagnostics = manifest.files.diagnostics
    ? await readOptionalJson<ProofPackageDiagnostics>(manifest.files.diagnostics.path, manifest.files.diagnostics.optional)
    : undefined;
  const lineageBundle = manifest.files.lineageBundle
    ? await readOptionalJson<LineageBundle>(manifest.files.lineageBundle.path, manifest.files.lineageBundle.optional)
    : undefined;
  const attestationBundle = manifest.files.attestationBundle
    ? await readOptionalJson<AttestationBundle>(manifest.files.attestationBundle.path, manifest.files.attestationBundle.optional)
    : undefined;
  const proofBundle = await readOptionalJson<ProofBundle>(manifest.files.proofBundle.path, manifest.files.proofBundle.optional);
  const receipt = await readOptionalJson<TransparencyReceipt>(manifest.files.receipt.path, manifest.files.receipt.optional);
  const approvalReceipt = manifest.files.approvalReceipt
    ? await readOptionalJson<PdfApprovalReceipt>(manifest.files.approvalReceipt.path, manifest.files.approvalReceipt.optional)
    : undefined;
  const transparencyLogEntry = await readOptionalJson<TransparencyLogEntry>(
    manifest.files.transparencyLogEntry.path,
    manifest.files.transparencyLogEntry.optional
  );
  const packageCheckpoint = await readOptionalJson<TransparencyCheckpoint>(
    manifest.files.transparencyCheckpoint.path,
    manifest.files.transparencyCheckpoint.optional
  );
  const inclusionProof = await readOptionalJson<TransparencyInclusionProof>(
    manifest.files.transparencyInclusionProof.path,
    manifest.files.transparencyInclusionProof.optional
  );
  const operatorPublicKey = await readOptionalJson<OperatorPublicKey>(
    manifest.files.operatorPublicKey.path,
    manifest.files.operatorPublicKey.optional
  );

  const effectiveCheckpoint = options?.checkpoint ?? packageCheckpoint;
  const effectiveTrustedKeys = options?.trustedOperatorKeys?.length
    ? options.trustedOperatorKeys
    : operatorPublicKey
      ? [operatorPublicKey]
      : [];
  const hashService = new HashService();
  const checks: ProofPackageVerificationCheck[] = [];

  checks.push(requiredCheck("capture-id", manifest.captureId === captureRecord.id, "Manifest capture ID matches capture-record.json."));

  if (rawSnapshot && rawHtml !== undefined) {
    const rawSnapshotHash = hashService.hashRawSnapshot(rawSnapshot, rawHtml);
    checks.push(requiredCheck("raw-snapshot-hash", rawSnapshotHash === manifest.rawSnapshotHash, "Recomputed raw snapshot hash matches manifest."));
    checks.push(requiredCheck("raw-snapshot-hash-record", rawSnapshotHash === captureRecord.rawSnapshotHash, "Recomputed raw snapshot hash matches capture record."));
  }

  if (rawPdf) {
    const rawPdfHash = hashService.hashPdfFile(rawPdf);
    checks.push(requiredCheck("raw-pdf-hash", rawPdfHash === manifest.rawSnapshotHash, "Recomputed PDF file hash matches manifest."));
    checks.push(requiredCheck("raw-pdf-hash-record", rawPdfHash === captureRecord.rawSnapshotHash, "Recomputed PDF file hash matches capture record."));
  }

  if (rawImage) {
    const rawImageHash = hashService.hashImageFile(rawImage);
    checks.push(requiredCheck("raw-image-hash", rawImageHash === manifest.rawSnapshotHash, "Recomputed image file hash matches manifest."));
    checks.push(requiredCheck("raw-image-hash-record", rawImageHash === captureRecord.rawSnapshotHash, "Recomputed image file hash matches capture record."));
  }

  if (screenshot && proofBundle?.screenshotHash) {
    const screenshotHash = hashService.hashBuffer(screenshot);
    checks.push(requiredCheck("screenshot-hash", screenshotHash === proofBundle.screenshotHash, "Recomputed screenshot hash matches proof-bundle.json."));
    if (diagnostics?.renderedEvidence?.screenshot?.hash) {
      checks.push(requiredCheck("screenshot-hash-diagnostics", screenshotHash === diagnostics.renderedEvidence.screenshot.hash, "Recomputed screenshot hash matches diagnostics.json."));
    }
  }

  if (canonicalContent) {
    const canonicalHash = hashService.hashCanonicalContent(canonicalContent);
    checks.push(requiredCheck("canonical-content-hash", canonicalHash === manifest.canonicalContentHash, "Recomputed canonical content hash matches manifest."));
    checks.push(requiredCheck("canonical-content-hash-record", canonicalHash === captureRecord.canonicalContentHash, "Recomputed canonical content hash matches capture record."));
  }

  if (metadata) {
    const metadataHash = hashService.hashMetadata(metadata);
    checks.push(requiredCheck("metadata-hash", metadataHash === manifest.metadataHash, "Recomputed metadata hash matches manifest."));
    checks.push(requiredCheck("metadata-hash-record", metadataHash === captureRecord.metadataHash, "Recomputed metadata hash matches capture record."));
  }

  if (diagnostics) {
    checks.push(requiredCheck("diagnostics-capture-id", diagnostics.captureId === manifest.captureId, "Diagnostics capture ID matches manifest."));
    checks.push(requiredCheck("diagnostics-extractor-version", diagnostics.extractorVersion === manifest.extractorVersion, "Diagnostics extractor version matches manifest."));
    if (manifest.normalizationVersion) {
      checks.push(requiredCheck("diagnostics-normalization-version", diagnostics.normalizationVersion === manifest.normalizationVersion, "Diagnostics normalization version matches manifest."));
    }
    if (canonicalContent && diagnostics.canonicalContent?.schemaVersion !== undefined) {
      checks.push(requiredCheck("diagnostics-canonical-schema", diagnostics.canonicalContent.schemaVersion === canonicalContent.schemaVersion, "Diagnostics canonical schema version matches canonical-content.json."));
    }
    if (metadata && diagnostics.metadata?.schemaVersion !== undefined) {
      checks.push(requiredCheck("diagnostics-metadata-schema", diagnostics.metadata.schemaVersion === metadata.schemaVersion, "Diagnostics metadata schema version matches metadata.json."));
    }
  }

  if (lineageBundle) {
    const lineageBundleHash = await hashLineageBundle(lineageBundle);
    checks.push(requiredCheck("lineage-bundle-hash", lineageBundleHash === manifest.lineageBundleHash, "Recomputed lineage bundle hash matches manifest."));
    if (proofBundle?.lineageBundleHash) {
      checks.push(requiredCheck("lineage-bundle-hash-proof-bundle", lineageBundleHash === proofBundle.lineageBundleHash, "Recomputed lineage bundle hash matches proof-bundle.json."));
    }
    if (captureRecord.lineageBundleHash) {
      checks.push(requiredCheck("lineage-bundle-hash-record", lineageBundleHash === captureRecord.lineageBundleHash, "Recomputed lineage bundle hash matches capture record."));
    }
    const lineageValidation = validateLineageBundle(lineageBundle);
    checks.push(requiredCheck("lineage-graph-valid", lineageValidation.ok, lineageValidation.ok ? "Lineage graph is a valid DAG." : lineageValidation.errors.map((warning) => warning.message).join("; ")));
  }

  if (attestationBundle) {
    const attestationBundleHash = await hashAttestationBundle(attestationBundle);
    checks.push(requiredCheck("attestation-bundle-hash", attestationBundleHash === manifest.attestationBundleHash, "Recomputed attestation bundle hash matches manifest."));
    if (proofBundle?.attestationBundleHash) {
      checks.push(requiredCheck("attestation-bundle-hash-proof-bundle", attestationBundleHash === proofBundle.attestationBundleHash, "Recomputed attestation bundle hash matches proof-bundle.json."));
    }
  }

  if (proofBundle) {
    const proofBundleHash = hashStableValue(proofBundle);
    checks.push(requiredCheck("proof-bundle-hash", proofBundleHash === manifest.proofBundleHash, "Recomputed proof bundle hash matches manifest."));
    checks.push(requiredCheck("proof-bundle-hash-record", proofBundleHash === captureRecord.proofBundleHash, "Recomputed proof bundle hash matches capture record."));

    if (receipt) {
      checks.push(requiredCheck("receipt-structure", receipt.proofBundleHash === proofBundleHash, "Receipt references the same proof bundle hash."));
      if (options?.timestampProvider) {
        checks.push(requiredCheck(
          "receipt-signature",
          options.timestampProvider.verify(receipt, proofBundleHash),
          "Receipt signature validates with the configured timestamp provider."
        ));
      }
    }
  }

  if (approvalReceipt) {
    checks.push(requiredCheck("approval-receipt-capture-link", approvalReceipt.captureId === manifest.captureId, "Approval receipt references the same capture ID."));
    checks.push(requiredCheck("approval-receipt-scope", Boolean(approvalReceipt.approvalScope), "Approval receipt declares an approval scope."));
    checks.push(requiredCheck("approval-receipt-method", Boolean(approvalReceipt.approvalMethod), "Approval receipt declares an approval method."));
    if (rawPdf) {
      const rawPdfHash = hashService.hashPdfFile(rawPdf);
      checks.push(requiredCheck("approval-receipt-pdf-link", approvalReceipt.rawPdfHash === rawPdfHash, "Approval receipt references the same PDF file hash."));
    }
  }

  if (transparencyLogEntry) {
    const entryHash = hashStableValue({
      schemaVersion: transparencyLogEntry.schemaVersion,
      logIndex: transparencyLogEntry.logIndex,
      captureId: transparencyLogEntry.captureId,
      proofBundleHash: transparencyLogEntry.proofBundleHash,
      previousEntryHash: transparencyLogEntry.previousEntryHash ?? null,
      createdAt: transparencyLogEntry.createdAt
    });
    checks.push(requiredCheck("transparency-entry-hash", entryHash === transparencyLogEntry.entryHash, "Transparency log entry hash is reproducible."));
  }

  if (effectiveCheckpoint) {
    if (operatorPublicKey) {
      checks.push(requiredCheck(
        "operator-key-fingerprint",
        operatorPublicKey.publicKeySha256 === effectiveCheckpoint.operatorPublicKeySha256,
        "Operator public key fingerprint matches the checkpoint metadata."
      ));
    }



    if (effectiveTrustedKeys.length) {
      checks.push(requiredCheck(
        "transparency-checkpoint-signature",
        verifyTransparencyCheckpointSignature(effectiveCheckpoint, effectiveTrustedKeys),
        "Transparency checkpoint signature validates against a trusted operator public key."
      ));

      if (approvalReceipt) {
        checks.push(requiredCheck(
          "approval-receipt-signature",
          verifyPdfApprovalReceiptSignature(approvalReceipt, effectiveTrustedKeys),
          "Approval receipt signature validates against a trusted operator public key."
        ));
      }
    }

    if (receipt) {
      checks.push(requiredCheck(
        "transparency-checkpoint-receipt-link",
        receipt.transparencyCheckpointId === effectiveCheckpoint.checkpointId,
        "Receipt references the same transparency checkpoint."
      ));
    }

    if ((effectiveCheckpoint.logMode ?? "legacy-hash-chain") === "merkle-tree-v1") {
      checks.push(requiredCheck(
        "transparency-proof-present",
        Boolean(inclusionProof),
        "A Merkle checkpoint requires an inclusion proof in the package."
      ));

      if (inclusionProof && transparencyLogEntry) {
        checks.push(requiredCheck(
          "transparency-proof-checkpoint-link",
          inclusionProof.checkpointId === effectiveCheckpoint.checkpointId,
          "Inclusion proof references the same checkpoint."
        ));
        checks.push(requiredCheck(
          "transparency-proof-entry-link",
          inclusionProof.logEntryHash === transparencyLogEntry.entryHash,
          "Inclusion proof references the same log entry hash."
        ));
        checks.push(requiredCheck(
          "transparency-proof-leaf-hash",
          inclusionProof.leafHash === hashMerkleLeaf(transparencyLogEntry.entryHash),
          "Inclusion proof leaf hash matches the log entry hash."
        ));
        checks.push(requiredCheck(
          "transparency-proof-root-link",
          inclusionProof.rootHash === effectiveCheckpoint.rootHash && inclusionProof.treeSize === effectiveCheckpoint.treeSize,
          "Inclusion proof root and tree size match the checkpoint."
        ));
        checks.push(requiredCheck(
          "transparency-proof-verification",
          verifyMerkleInclusionProof(inclusionProof),
          "Merkle inclusion proof validates against the checkpoint root."
        ));
      }
    } else if (transparencyLogEntry) {
      checks.push(requiredCheck(
        "legacy-transparency-link",
        effectiveCheckpoint.lastLogIndex === transparencyLogEntry.logIndex &&
          effectiveCheckpoint.lastEntryHash === transparencyLogEntry.entryHash &&
          effectiveCheckpoint.rootHash === transparencyLogEntry.entryHash,
        "Legacy hash-chain checkpoint matches the included log entry exactly."
      ));
    }
  }

  const lineageSummary = summarizeLineageBundle(lineageBundle);
  const attestationSummary = summarizeAttestationBundle(attestationBundle);
  const attestationVerification = attestationBundle
    ? await Promise.all(
        attestationBundle.attestations.map(async (attestation) => ({
          hashMatches:
            (await computeContentAttestationHash({
              schemaVersion: attestation.schemaVersion,
              id: attestation.id,
              type: attestation.type,
              actor: attestation.actor,
              auth: attestation.auth,
              timestamp: attestation.timestamp,
              notes: attestation.notes,
              subjectContentHash: attestation.subjectContentHash,
              relatedContentHashes: attestation.relatedContentHashes,
              metadata: attestation.metadata,
              issuerOperatorId: attestation.issuerOperatorId,
              issuerKeyId: attestation.issuerKeyId,
              issuerPublicKeySha256: attestation.issuerPublicKeySha256,
              signatureAlgorithm: attestation.signatureAlgorithm
            })) === attestation.attestationHash,
          signatureValid: effectiveTrustedKeys.length
            ? await verifyContentAttestationSignature(attestation, effectiveTrustedKeys)
            : false
        }))
      )
    : [];
  const verifiedCount = attestationVerification.filter((result) => result.hashMatches && result.signatureValid).length;
  const invalidCount = attestationVerification.filter((result) => !result.hashMatches || (effectiveTrustedKeys.length > 0 && !result.signatureValid)).length;
  const unverifiedCount = attestationVerification.length - verifiedCount - invalidCount;
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    packagePath: targetDirectory,
    captureId: manifest.captureId,
    checks,
    attestations: attestationSummary.hasAttestations
      ? {
          ...attestationSummary,
          verifiedCount,
          invalidCount,
          unverifiedCount,
          trustedKeyMaterialAvailable: effectiveTrustedKeys.length > 0
        }
      : undefined,
    lineage: lineageSummary.hasLineage
      ? {
          ...lineageSummary,
          nodes: options?.inspectLineage ? lineageBundle?.contentObjects : undefined,
          edges: options?.inspectLineage ? lineageBundle?.edges : undefined
        }
      : undefined,
  };
};


























