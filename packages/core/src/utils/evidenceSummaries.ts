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
  const isImage = detail.capture.artifactType === "image-file";
  const isArticle = detail.capture.artifactType === "article-publish";
  const screenshotHash = renderedScreenshotHash(detail.capture.renderedEvidence);

  return [
    {
      id: "raw-snapshot",
      label: "Raw snapshot",
      available: Boolean(detail.capture.rawSnapshotHash),
      proves: isPdf
        ? "The exact uploaded PDF bytes were preserved as observed by the operator."
        : isImage
          ? "The exact uploaded image bytes were preserved as observed by the operator."
          : isArticle
            ? "The deterministic WordPress publish HTML prepared at publish time was preserved as observed by the operator."
            : "The exact fetched response body was preserved as observed by the operator.",
      doesNotProve: isPdf
        ? "It does not prove who originally created the document or when it was first authored."
        : isImage
          ? "It does not prove who originally created the image or whether identity claims about it are true by default."
          : isArticle
            ? "It does not prove that author or publisher identity claims are trusted by default, only that this publish payload was packaged and logged."
            : "It does not prove when the publisher originally created the page or what changed before capture.",
      hashReference: detail.capture.rawSnapshotHash,
      exportReference: isPdf ? "raw-snapshot.json + source-file.pdf" : isImage ? "source-image.bin" : "raw-snapshot.json + raw-snapshot.html"
    },
    {
      id: "canonical-content",
      label: "Canonical content",
      available: Boolean(detail.canonicalContent),
      proves: isArticle
        ? "Deterministic article content derived from the WordPress publish payload can be compared across revisions without trusting the live page."
        : "Deterministic extracted content can be compared across captures without relying on full-page HTML equality.",
      doesNotProve: "It does not prove publisher intent, authorship, or the truth of extracted statements.",
      hashReference: detail.capture.canonicalContentHash,
      exportReference: "canonical-content.json"
    },
    {
      id: "metadata",
      label: "Metadata",
      available: Boolean(detail.metadata),
      proves: isArticle
        ? "Normalized article metadata such as title, byline claims, site identifier, and claimed timestamps were extracted and hashed separately."
        : "Normalized citation-like fields such as title, author, and claimed publication date were extracted and hashed separately.",
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
      id: "attestations",
      label: "Attestations",
      available: Boolean(detail.capture.artifacts.attestationBundleStorageKey),
      proves: "When present, authenticated human actions such as publish, update, or approval were recorded as additive attestation metadata inside the package.",
      doesNotProve: "Attestations are informational provenance claims and are not required trust roots for offline verification.",
      hashReference: detail.proofBundle?.attestationBundleHash,
      exportReference: detail.capture.artifacts.attestationBundleStorageKey ? "attestations.json" : undefined
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
