import type { CaptureDetail, EvidenceLayerSummary, PdfQualityDiagnostics, RenderedEvidence } from "@auth-layer/shared";

const renderedScreenshotHash = (renderedEvidence?: RenderedEvidence): string | undefined =>
  renderedEvidence?.screenshot?.hash ?? renderedEvidence?.screenshotHash;

export const derivePdfQualityDiagnostics = (detail: Pick<CaptureDetail, "capture" | "canonicalContent" | "metadata">): PdfQualityDiagnostics | undefined => {
  if (detail.capture.artifactType !== "pdf-file") {
    return undefined;
  }

  const textAvailable = detail.canonicalContent?.textAvailable ?? detail.metadata?.textAvailable ?? false;
  const extractedCharacterCount = detail.canonicalContent?.stats.characterCount ?? detail.canonicalContent?.bodyMarkdown.trim().length ?? 0;
  const metadataExtracted = Boolean(detail.metadata);
  const likelyScannedImageOnly = !textAvailable || extractedCharacterCount <= 32;

  return {
    embeddedTextDetected: textAvailable,
    extractedCharacterCount,
    metadataExtracted,
    likelyScannedImageOnly
  };
};

export const buildEvidenceLayerSummaries = (
  detail: Pick<CaptureDetail, "capture" | "canonicalContent" | "metadata" | "proofBundle" | "approvalReceipt">
): EvidenceLayerSummary[] => {
  const isPdf = detail.capture.artifactType === "pdf-file";
  const screenshotHash = renderedScreenshotHash(detail.capture.renderedEvidence);

  return [
    {
      id: "raw-snapshot",
      label: "Raw snapshot",
      available: Boolean(detail.capture.rawSnapshotHash),
      proves: isPdf
        ? "The exact uploaded PDF bytes were preserved as observed by the operator."
        : "The exact fetched response body was preserved as observed by the operator.",
      doesNotProve: isPdf
        ? "It does not prove who originally created the document or when it was first authored."
        : "It does not prove when the publisher originally created the page or what changed before capture.",
      hashReference: detail.capture.rawSnapshotHash,
      exportReference: isPdf ? "raw-snapshot.json + source-file.pdf" : "raw-snapshot.json + raw-snapshot.html"
    },
    {
      id: "canonical-content",
      label: "Canonical content",
      available: Boolean(detail.canonicalContent),
      proves: "Deterministic extracted content can be compared across captures without relying on full-page HTML equality.",
      doesNotProve: "It does not prove publisher intent, authorship, or the truth of extracted statements.",
      hashReference: detail.capture.canonicalContentHash,
      exportReference: "canonical-content.json"
    },
    {
      id: "metadata",
      label: "Metadata",
      available: Boolean(detail.metadata),
      proves: "Normalized citation-like fields such as title, author, and claimed publication date were extracted and hashed separately.",
      doesNotProve: "It does not independently validate the truth of claimed author or claimed publication date fields.",
      hashReference: detail.capture.metadataHash,
      exportReference: "metadata.json"
    },
    {
      id: "rendered-evidence",
      label: "Rendered evidence",
      available: Boolean(detail.capture.renderedEvidence || detail.capture.artifacts.screenshotStorageKey),
      proves: "When present, the screenshot records what the operator-rendered page looked like under the recorded viewport and device settings.",
      doesNotProve: "It does not replace raw snapshot or canonical content proof, and screenshot equality is not expected across captures.",
      hashReference: screenshotHash,
      exportReference: detail.capture.artifacts.screenshotStorageKey ? "rendered-screenshot.png" : undefined
    },
    {
      id: "operator-observation",
      label: "Operator observation",
      available: Boolean(detail.capture.proofBundleHash),
      proves: "The operator observed, hashed, and packaged this capture and linked it to a transparency checkpoint.",
      doesNotProve: "It does not prove original publisher intent, original creation time, or uploader approval.",
      hashReference: detail.capture.proofBundleHash,
      exportReference: "proof-bundle.json + transparency-export.json"
    },
    {
      id: "uploader-approval",
      label: "Uploader approval",
      available: Boolean(detail.approvalReceipt),
      proves: "When present, the uploader approved the exact PDF hash recorded in the approval receipt.",
      doesNotProve: "It is optional provenance and is not required to verify the operator observation.",
      hashReference: detail.approvalReceipt?.rawPdfHash,
      exportReference: detail.approvalReceipt ? "approval-receipt.json" : undefined
    }
  ];
};
