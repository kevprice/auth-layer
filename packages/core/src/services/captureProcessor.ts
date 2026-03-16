import { Buffer } from "node:buffer";

import type {
  CanonicalContent,
  CanonicalMetadata,
  CaptureComparison,
  CaptureComparisonSide,
  CaptureDetail,
  CaptureRecord,
  CaptureScope,
  CaptureTransparencyExport,
  ProofBundle,
  RawSnapshot
} from "@auth-layer/shared";

import type { CaptureRepository } from "../repositories/captureRepository.js";
import type { ObjectStore } from "../storage/objectStore.js";
import { hashStableValue } from "../utils/stableJson.js";
import { compareCaptureDetails, compareWithPreviousCapture, type ComparisonSource } from "./comparisonService.js";
import { buildEvidenceLayerSummaries, derivePdfQualityDiagnostics } from "../utils/evidenceSummaries.js";
import type { ExtractionService } from "./extractionService.js";
import { PDF_EXTRACTOR_VERSION, PdfService } from "./pdfService.js";
import type { FetchService } from "./fetchService.js";
import type { HashService } from "./hashService.js";
import type { PdfApprovalService } from "./pdfApprovalService.js";
import type { ScreenshotService } from "./screenshotService.js";
import type { TimestampProvider } from "./timestampProvider.js";
import type { TransparencyLogService } from "./transparencyLogService.js";

const artifactPath = (captureId: string, fileName: string): string => `captures/${captureId}/${fileName}`;
const jsonByteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
const proofStatement =
  "This export proves that our system observed the captured URL in the preserved fetched state and derived canonical content by the recorded capture timestamp. It does not prove original authorship or original publication time.";

const buildCaptureScope = (capture: Partial<CaptureRecord>): CaptureScope => ({
  rawHttpBodyPreserved: Boolean(capture.artifacts?.rawHtmlStorageKey),
  rawFilePreserved: Boolean(capture.artifacts?.rawPdfStorageKey),
  canonicalContentExtracted: Boolean(capture.artifacts?.canonicalContentStorageKey),
  metadataExtracted: Boolean(capture.artifacts?.metadataStorageKey),
  screenshotPreserved: Boolean(capture.artifacts?.screenshotStorageKey),
  renderedDomPreserved: false
});

const buildComparisonSource = (
  capture: Pick<CaptureRecord, "id" | "canonicalContentHash" | "metadataHash" | "claimedPublishedAt">,
  metadata?: CanonicalMetadata
): ComparisonSource => ({
  id: capture.id,
  canonicalContentHash: capture.canonicalContentHash,
  metadataHash: capture.metadataHash,
  claimedPublishedAt: metadata?.publishedAtClaimed ?? capture.claimedPublishedAt,
  title: metadata?.title,
  author: metadata?.author
});

const observedAtForCapture = (capture: CaptureRecord): string => capture.capturedAt ?? capture.createdAt;
const renderedScreenshotHash = (renderedEvidence?: CaptureRecord["renderedEvidence"]): string | undefined =>
  renderedEvidence?.screenshot?.hash ?? renderedEvidence?.screenshotHash;

type CaptureComparisonSelector =
  | {
      basis: "capture-id";
      fromCaptureId: string;
      toCaptureId: string;
    }
  | {
      basis: "captured-at";
      fromCapturedAt: string;
      toCapturedAt: string;
    };

export class CaptureProcessor {
  private readonly pdfService = new PdfService();

  constructor(
    private readonly repository: CaptureRepository,
    private readonly objectStore: ObjectStore,
    private readonly fetchService: FetchService,
    private readonly extractionService: ExtractionService,
    private readonly hashService: HashService,
    private readonly timestampProvider: TimestampProvider,
    private readonly transparencyLogService: TransparencyLogService,
    private readonly screenshotService?: ScreenshotService,
    private readonly pdfApprovalService?: PdfApprovalService
  ) {}

  async processClaimedCapture(capture: CaptureRecord): Promise<CaptureRecord> {
    if (capture.artifactType === "pdf-file") {
      return this.processClaimedPdfCapture(capture);
    }
    let stage: CaptureRecord["status"] = "fetching";

    try {
      const fetchedPage = await this.fetchService.fetch(capture.requestedUrl);
      const rawHtmlStorageKey = artifactPath(capture.id, "raw.html");
      await this.objectStore.putObject(rawHtmlStorageKey, fetchedPage.rawHtml, "text/html; charset=utf-8");

      const rawSnapshot: RawSnapshot = {
        ...fetchedPage.snapshot,
        rawHtmlStorageKey
      };
      const rawSnapshotHash = this.hashService.hashRawSnapshot(rawSnapshot, fetchedPage.rawHtml);

      const afterFetch = await this.repository.recordFetchCompleted({
        captureId: capture.id,
        finalUrl: rawSnapshot.finalUrl,
        fetchedAt: rawSnapshot.fetchedAt,
        httpStatus: rawSnapshot.httpStatus,
        headers: rawSnapshot.headers,
        contentType: rawSnapshot.contentType,
        charset: rawSnapshot.charset,
        rawSnapshotHash,
        rawSourceArtifact: {
          kind: "raw-html",
          storageKey: rawHtmlStorageKey,
          contentHash: hashStableValue(fetchedPage.rawHtml),
          contentType: "text/html; charset=utf-8",
          byteSize: Buffer.byteLength(fetchedPage.rawHtml, "utf8")
        }
      });
      stage = "extracting";

      const extraction = await this.extractionService.extract({
        rawHtml: fetchedPage.rawHtml,
        sourceUrl: rawSnapshot.finalUrl
      });
      const canonicalContentStorageKey = artifactPath(capture.id, "canonical-content.json");
      const metadataStorageKey = artifactPath(capture.id, "metadata.json");
      await Promise.all([
        this.objectStore.putJson(canonicalContentStorageKey, extraction.canonicalContent),
        this.objectStore.putJson(metadataStorageKey, extraction.metadata)
      ]);

      let screenshotArtifact: import("../repositories/captureRepository.js").ArtifactReferenceInput | undefined;
      let renderedEvidence: CaptureRecord["renderedEvidence"] | undefined;
      if (this.screenshotService) {
        const screenshot = await this.screenshotService.capture(rawSnapshot.finalUrl);
        if (screenshot) {
          const screenshotStorageKey = artifactPath(capture.id, "rendered-screenshot.png");
          await this.objectStore.putObject(screenshotStorageKey, screenshot.body, screenshot.contentType);
          const screenshotHash = this.hashService.hashBuffer(screenshot.body);
          screenshotArtifact = {
            kind: "screenshot",
            storageKey: screenshotStorageKey,
            contentHash: screenshotHash,
            contentType: screenshot.contentType,
            byteSize: screenshot.body.byteLength
          };
          renderedEvidence = {
            screenshot: {
              hash: screenshotHash,
              format: screenshot.screenshotFormat,
              mediaType: screenshot.contentType
            },
            viewport: screenshot.viewport,
            device: {
              devicePreset: screenshot.devicePreset,
              userAgent: screenshot.userAgent,
              userAgentLabel: screenshot.userAgentLabel
            },
            screenshotHash,
            userAgentLabel: screenshot.userAgentLabel
          };
        }
      }

      const canonicalContentHash = this.hashService.hashCanonicalContent(extraction.canonicalContent);
      const metadataHash = this.hashService.hashMetadata(extraction.metadata);

      const afterDerivation = await this.repository.recordDerivationCompleted({
        captureId: capture.id,
        pageKind: extraction.pageKind,
        extractionStatus: extraction.extractionStatus,
        claimedPublishedAt: extraction.metadata.publishedAtClaimed,
        canonicalContent: extraction.canonicalContent,
        metadata: extraction.metadata,
        canonicalContentHash,
        metadataHash,
        canonicalContentArtifact: {
          kind: "canonical-content",
          storageKey: canonicalContentStorageKey,
          contentHash: canonicalContentHash,
          contentType: "application/json; charset=utf-8",
          byteSize: jsonByteSize(extraction.canonicalContent)
        },
        metadataArtifact: {
          kind: "metadata",
          storageKey: metadataStorageKey,
          contentHash: metadataHash,
          contentType: "application/json; charset=utf-8",
          byteSize: jsonByteSize(extraction.metadata)
        },
        screenshotArtifact,
        renderedEvidence
      });
      stage = "timestamping";

      const captureScope = buildCaptureScope(afterDerivation);
      const hashes = this.hashService.buildProofBundle({
        artifactType: capture.artifactType ?? "url-capture",
        captureId: capture.id,
        sourceLabel: capture.sourceLabel ?? capture.requestedUrl,
        fileName: capture.fileName,
        mediaType: capture.mediaType,
        byteSize: capture.byteSize,
        requestedUrl: capture.requestedUrl,
        finalUrl: rawSnapshot.finalUrl,
        pageKind: extraction.pageKind,
        extractorVersion: extraction.canonicalContent.extractorVersion,
        normalizationVersion: extraction.canonicalContent.normalizationVersion,
        rawSnapshotSchemaVersion: rawSnapshot.schemaVersion,
        canonicalContentSchemaVersion: extraction.canonicalContent.schemaVersion,
        metadataSchemaVersion: extraction.metadata.schemaVersion,
        captureScope,
        rawSnapshotHash,
        screenshotHash: renderedScreenshotHash(renderedEvidence),
        canonicalContentHash,
        metadataHash,
        createdAt: new Date().toISOString()
      });

      const issuedReceipt = await this.timestampProvider.issue(hashes.proofBundleHash);
      const transparency = await this.transparencyLogService.appendCapture(capture.id, hashes.proofBundleHash, issuedReceipt);
      const receipt = transparency.receipt ?? issuedReceipt;

      const proofBundleStorageKey = artifactPath(capture.id, "proof-bundle.json");
      await this.objectStore.putJson(proofBundleStorageKey, hashes.proofBundle);

      const previousCompletedCapture = (await this.repository.listCapturesForUrl(capture.normalizedRequestedUrl)).find(
        (candidate) => candidate.id !== capture.id && candidate.status === "completed"
      );
      const previousDetail = previousCompletedCapture ? await this.loadCaptureDetail(previousCompletedCapture.id) : undefined;
      const comparison = compareWithPreviousCapture(
        buildComparisonSource(
          {
            id: capture.id,
            canonicalContentHash,
            metadataHash,
            claimedPublishedAt: extraction.metadata.publishedAtClaimed
          },
          extraction.metadata
        ),
        previousDetail
          ? buildComparisonSource(
              {
                id: previousDetail.capture.id,
                canonicalContentHash: previousDetail.capture.canonicalContentHash,
                metadataHash: previousDetail.capture.metadataHash,
                claimedPublishedAt: previousDetail.capture.claimedPublishedAt
              },
              previousDetail.metadata
            )
          : undefined
      );

      let completedCapture = await this.repository.recordTimestampCompleted({
        captureId: capture.id,
        capturedAt: receipt.receivedAt,
        proofBundle: hashes.proofBundle,
        proofBundleHash: hashes.proofBundleHash,
        receipt,
        proofBundleArtifact: {
          kind: "proof-bundle",
          storageKey: proofBundleStorageKey,
          contentHash: hashes.proofBundleHash,
          contentType: "application/json; charset=utf-8",
          byteSize: jsonByteSize(hashes.proofBundle)
        },
        comparedToCaptureId: comparison.comparedToCaptureId,
        contentChangedFromPrevious: comparison.contentChangedFromPrevious,
        metadataChangedFromPrevious: comparison.metadataChangedFromPrevious,
        titleChangedFromPrevious: comparison.titleChangedFromPrevious,
        authorChangedFromPrevious: comparison.authorChangedFromPrevious,
        claimedPublishedAtChangedFromPrevious: comparison.claimedPublishedAtChangedFromPrevious
      });

      return completedCapture;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown capture failure";
      const errorCode = error instanceof Error ? error.name : "CaptureError";
      return this.repository.recordFailure({
        captureId: capture.id,
        stageStatus: stage,
        errorCode: `${stage}:${errorCode}`,
        errorMessage: message
      });
    }
  }


  private async processClaimedPdfCapture(capture: CaptureRecord): Promise<CaptureRecord> {
    let stage: CaptureRecord["status"] = "fetching";

    try {
      const rawPdfStorageKey = capture.artifacts.rawPdfStorageKey;
      if (!rawPdfStorageKey) {
        throw new Error("Raw PDF artifact is missing for this queued PDF capture");
      }

      const rawPdfObject = await this.objectStore.getObject(rawPdfStorageKey);
      if (!rawPdfObject) {
        throw new Error("Stored PDF artifact could not be loaded");
      }

      const fetchedAt = capture.fetchedAt ?? capture.createdAt;
      const rawSnapshotHash = capture.rawSnapshotHash ?? this.hashService.hashPdfFile(rawPdfObject.body);
      await this.repository.recordFetchCompleted({
        captureId: capture.id,
        finalUrl: capture.requestedUrl,
        fetchedAt,
        httpStatus: 200,
        headers: {},
        contentType: capture.mediaType ?? rawPdfObject.contentType,
        rawSnapshotHash,
        rawSourceArtifact: {
          kind: "raw-pdf",
          storageKey: rawPdfStorageKey,
          contentHash: rawSnapshotHash,
          contentType: capture.mediaType ?? rawPdfObject.contentType,
          byteSize: capture.byteSize ?? rawPdfObject.body.byteLength
        }
      });
      stage = "extracting";

      const extraction = this.pdfService.extract({
        buffer: rawPdfObject.body,
        sourceUrl: capture.requestedUrl,
        sourceLabel: capture.sourceLabel ?? capture.fileName ?? capture.requestedUrl,
        fileName: capture.fileName ?? "document.pdf",
        mediaType: capture.mediaType ?? rawPdfObject.contentType ?? "application/pdf",
        byteSize: capture.byteSize ?? rawPdfObject.body.byteLength
      });

      const canonicalContentStorageKey = artifactPath(capture.id, "canonical-content.json");
      const metadataStorageKey = artifactPath(capture.id, "metadata.json");
      await Promise.all([
        this.objectStore.putJson(canonicalContentStorageKey, extraction.canonicalContent),
        this.objectStore.putJson(metadataStorageKey, extraction.metadata)
      ]);

      const canonicalContentHash = this.hashService.hashCanonicalContent(extraction.canonicalContent);
      const metadataHash = this.hashService.hashMetadata(extraction.metadata);

      const afterDerivation = await this.repository.recordDerivationCompleted({
        captureId: capture.id,
        pageKind: extraction.pageKind,
        extractionStatus: extraction.extractionStatus,
        claimedPublishedAt: extraction.metadata.publishedAtClaimed,
        canonicalContent: extraction.canonicalContent,
        metadata: extraction.metadata,
        canonicalContentHash,
        metadataHash,
        canonicalContentArtifact: {
          kind: "canonical-content",
          storageKey: canonicalContentStorageKey,
          contentHash: canonicalContentHash,
          contentType: "application/json; charset=utf-8",
          byteSize: jsonByteSize(extraction.canonicalContent)
        },
        metadataArtifact: {
          kind: "metadata",
          storageKey: metadataStorageKey,
          contentHash: metadataHash,
          contentType: "application/json; charset=utf-8",
          byteSize: jsonByteSize(extraction.metadata)
        }
      });
      stage = "timestamping";

      const captureScope = buildCaptureScope(afterDerivation);
      const hashes = this.hashService.buildProofBundle({
        artifactType: "pdf-file",
        captureId: capture.id,
        sourceLabel: capture.sourceLabel ?? capture.fileName ?? capture.requestedUrl,
        fileName: capture.fileName,
        mediaType: capture.mediaType,
        byteSize: capture.byteSize,
        requestedUrl: capture.requestedUrl,
        finalUrl: capture.requestedUrl,
        pageKind: extraction.pageKind,
        extractorVersion: extraction.canonicalContent.extractorVersion,
        normalizationVersion: extraction.canonicalContent.normalizationVersion,
        rawSnapshotSchemaVersion: 1,
        canonicalContentSchemaVersion: extraction.canonicalContent.schemaVersion,
        metadataSchemaVersion: extraction.metadata.schemaVersion,
        captureScope,
        rawSnapshotHash,
        screenshotHash: undefined,
        canonicalContentHash,
        metadataHash,
        createdAt: new Date().toISOString()
      });

      const issuedReceipt = await this.timestampProvider.issue(hashes.proofBundleHash);
      const transparency = await this.transparencyLogService.appendCapture(capture.id, hashes.proofBundleHash, issuedReceipt);
      const receipt = transparency.receipt ?? issuedReceipt;
      const proofBundleStorageKey = artifactPath(capture.id, "proof-bundle.json");
      await this.objectStore.putJson(proofBundleStorageKey, hashes.proofBundle);

      const previousCompletedCapture = (await this.repository.listCapturesForUrl(capture.normalizedRequestedUrl)).find(
        (candidate) => candidate.id !== capture.id && candidate.status === "completed"
      );
      const previousDetail = previousCompletedCapture ? await this.loadCaptureDetail(previousCompletedCapture.id) : undefined;
      const comparison = compareWithPreviousCapture(
        buildComparisonSource(
          {
            id: capture.id,
            canonicalContentHash,
            metadataHash,
            claimedPublishedAt: extraction.metadata.publishedAtClaimed
          },
          extraction.metadata
        ),
        previousDetail
          ? buildComparisonSource(
              {
                id: previousDetail.capture.id,
                canonicalContentHash: previousDetail.capture.canonicalContentHash,
                metadataHash: previousDetail.capture.metadataHash,
                claimedPublishedAt: previousDetail.capture.claimedPublishedAt
              },
              previousDetail.metadata
            )
          : undefined
      );

      let completedCapture = await this.repository.recordTimestampCompleted({
        captureId: capture.id,
        capturedAt: receipt.receivedAt,
        proofBundle: hashes.proofBundle,
        proofBundleHash: hashes.proofBundleHash,
        receipt,
        proofBundleArtifact: {
          kind: "proof-bundle",
          storageKey: proofBundleStorageKey,
          contentHash: hashes.proofBundleHash,
          contentType: "application/json; charset=utf-8",
          byteSize: jsonByteSize(hashes.proofBundle)
        },
        comparedToCaptureId: comparison.comparedToCaptureId,
        contentChangedFromPrevious: comparison.contentChangedFromPrevious,
        metadataChangedFromPrevious: comparison.metadataChangedFromPrevious,
        titleChangedFromPrevious: comparison.titleChangedFromPrevious,
        authorChangedFromPrevious: comparison.authorChangedFromPrevious,
        claimedPublishedAtChangedFromPrevious: comparison.claimedPublishedAtChangedFromPrevious
      });

      if (capture.actorAccountId && this.pdfApprovalService) {
        const approvalReceipt = this.pdfApprovalService.issue({
          captureId: capture.id,
          actorAccountId: capture.actorAccountId,
          approvalType: capture.approvalType ?? "pdf-upload-approval-v1",
          approvalScope: capture.approvalScope ?? "file-hash",
          approvalMethod: capture.approvalMethod ?? "account-signature",
          rawPdfHash: rawSnapshotHash
        });
        const approvalStorageKey = artifactPath(capture.id, "approval-receipt.json");
        await this.objectStore.putJson(approvalStorageKey, approvalReceipt);
        completedCapture = await this.repository.recordApprovalReceipt({
          captureId: capture.id,
          approvalReceipt,
          actorAccountId: capture.actorAccountId,
          approvalType: capture.approvalType ?? "pdf-upload-approval-v1",
          approvalScope: capture.approvalScope ?? "file-hash",
          approvalMethod: capture.approvalMethod ?? "account-signature",
          artifact: {
            kind: "approval-receipt",
            storageKey: approvalStorageKey,
            contentHash: hashStableValue(approvalReceipt),
            contentType: "application/json; charset=utf-8",
            byteSize: jsonByteSize(approvalReceipt)
          }
        });
      }

      return completedCapture;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown PDF capture failure";
      const errorCode = error instanceof Error ? error.name : "PdfCaptureError";
      return this.repository.recordFailure({
        captureId: capture.id,
        stageStatus: stage,
        errorCode: `${stage}:${errorCode}`,
        errorMessage: message
      });
    }
  }

  private async loadArtifactJson<T>(storageKey?: string): Promise<T | undefined> {
    if (!storageKey) {
      return undefined;
    }

    const value = await this.objectStore.getText(storageKey);
    return value ? (JSON.parse(value) as T) : undefined;
  }

  async loadCaptureDetail(id: string): Promise<CaptureDetail | undefined> {
    const capture = await this.repository.getCapture(id);

    if (!capture) {
      return undefined;
    }

    const [canonicalContent, metadata, proofBundle, receipt, approvalReceipt] = await Promise.all([
      this.loadArtifactJson<CanonicalContent>(capture.artifacts.canonicalContentStorageKey),
      this.loadArtifactJson<CanonicalMetadata>(capture.artifacts.metadataStorageKey),
      this.loadArtifactJson<ProofBundle>(capture.artifacts.proofBundleStorageKey),
      capture.proofReceiptId ? this.repository.getReceipt(capture.proofReceiptId) : Promise.resolve(undefined),
      capture.approvalReceiptId ? this.repository.getApprovalReceipt(capture.approvalReceiptId) : Promise.resolve(undefined)
    ]);

    return {
      capture,
      canonicalContent,
      metadata,
      proofBundle,
      receipt,
      approvalReceipt
    };
  }

  async loadCaptureTransparencyExport(id: string): Promise<CaptureTransparencyExport | undefined> {
    const detail = await this.loadCaptureDetail(id);

    if (!detail) {
      return undefined;
    }

    const [events, artifactReferences, transparency] = await Promise.all([
      this.repository.listCaptureEvents(id),
      this.repository.listArtifactReferences(id),
      this.transparencyLogService.getCaptureTransparency(id, detail.receipt?.transparencyCheckpointId)
    ]);

    return {
      schemaVersion: 3,
      artifactType: detail.capture.artifactType,
      exportType: "capture-transparency-export",
      exportedAt: detail.capture.capturedAt ?? detail.capture.updatedAt,
      proofStatement:
        detail.capture.artifactType === "pdf-file"
          ? "This export proves that our system observed the preserved PDF file and derived canonical metadata or text by the recorded capture timestamp. It does not prove original authorship or original document creation time."
          : proofStatement,
      captureScope: detail.proofBundle?.captureScope ?? buildCaptureScope(detail.capture),
      comparisonSummary: {
        comparedToCaptureId: detail.capture.comparedToCaptureId,
        semanticContentChanged: detail.capture.contentChangedFromPrevious,
        metadataChanged: detail.capture.metadataChangedFromPrevious,
        titleChanged: detail.capture.titleChangedFromPrevious,
        authorChanged: detail.capture.authorChangedFromPrevious,
        claimedPublishedAtChanged: detail.capture.claimedPublishedAtChangedFromPrevious
      },
      evidenceLayers: buildEvidenceLayerSummaries(detail),
      pdfQualityDiagnostics: derivePdfQualityDiagnostics(detail),
      capture: detail.capture,
      events,
      artifactReferences,
      canonicalContent: detail.canonicalContent,
      metadata: detail.metadata,
      proofBundle: detail.proofBundle,
      receipt: detail.receipt,
      approvalReceipt: detail.approvalReceipt,
      transparencyLogEntry: transparency.entry,
      transparencyCheckpoint: transparency.checkpoint,
      transparencyInclusionProof: transparency.inclusionProof
    };
  }

  async getHistory(normalizedRequestedUrl: string): Promise<CaptureRecord[]> {
    return this.repository.listCapturesForUrl(normalizedRequestedUrl);
  }

  private async buildComparisonSide(capture: CaptureRecord): Promise<CaptureComparisonSide> {
    const detail = await this.loadCaptureDetail(capture.id);
    if (!detail) {
      throw new Error(`Capture ${capture.id} not found`);
    }

    return {
      capture: detail.capture,
      canonicalContent: detail.canonicalContent,
      metadata: detail.metadata,
      proofBundle: detail.proofBundle,
      receipt: detail.receipt,
      observedAt: observedAtForCapture(detail.capture)
    };
  }

  async compareCapturesForUrl(normalizedRequestedUrl: string, selector: CaptureComparisonSelector): Promise<CaptureComparison> {
    const captures = await this.repository.listCapturesForUrl(normalizedRequestedUrl);
    if (captures.length < 2) {
      throw new Error("At least two captures are required to compare this URL");
    }

    let selected: [CaptureRecord, CaptureRecord] | undefined;

    if (selector.basis === "capture-id") {
      const fromCapture = captures.find((capture) => capture.id === selector.fromCaptureId);
      const toCapture = captures.find((capture) => capture.id === selector.toCaptureId);
      if (!fromCapture || !toCapture) {
        throw new Error("Both capture IDs must belong to the requested normalized URL");
      }
      selected = [fromCapture, toCapture];
    } else {
      const fromCapture = captures.find((capture) => observedAtForCapture(capture) === selector.fromCapturedAt);
      const toCapture = captures.find((capture) => observedAtForCapture(capture) === selector.toCapturedAt);
      if (!fromCapture || !toCapture) {
        throw new Error("Both capture timestamps must belong to the requested normalized URL");
      }
      selected = [fromCapture, toCapture];
    }

    if (selected[0].id === selected[1].id) {
      throw new Error("Choose two different captures to compare");
    }

    const [left, right] = await Promise.all([this.buildComparisonSide(selected[0]), this.buildComparisonSide(selected[1])]);
    const [older, newer] = [left, right].sort((a, b) => observedAtForCapture(a.capture).localeCompare(observedAtForCapture(b.capture))) as [
      CaptureComparisonSide,
      CaptureComparisonSide
    ];

    return compareCaptureDetails({
      normalizedRequestedUrl,
      basis: selector.basis,
      older,
      newer
    });
  }
}


