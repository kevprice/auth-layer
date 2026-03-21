export const EXTENSION_TRUST_NOTE = "The extension does not prove authenticity. It reveals where proof material exists.";

export const findAuthenticityManifestHref = (doc = document) =>
  doc.querySelector('link[rel="authenticity-manifest"]')?.getAttribute("href") ?? undefined;

export const resolveManifestUrl = (href, pageUrl) => {
  if (!href) {
    return undefined;
  }

  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return undefined;
  }
};

export const extractManifestUrlFromHtml = (html, pageUrl) => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  return resolveManifestUrl(findAuthenticityManifestHref(doc), pageUrl);
};

const resolveOptionalUrl = (value, baseUrl) => {
  if (!value || !baseUrl) {
    return undefined;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
};

export const buildPreviewModel = ({ pageUrl, manifestUrl, manifest, exportPayload }) => {
  const exportSummary = exportPayload ?? {};
  const captureExportUrl = resolveOptionalUrl(manifest?.captureExportUrl, manifestUrl);
  const transparencyLogUrl = resolveOptionalUrl(manifest?.transparencyLogUrl, manifestUrl);
  const transparencyEntryPresent = Boolean(
    transparencyLogUrl || exportSummary.transparencyLogEntry || exportSummary.transparencyCheckpoint
  );

  return {
    pageUrl,
    manifestUrl,
    artifactType: manifest?.artifactType,
    title: manifest?.title,
    publisher: manifest?.publisher ?? manifest?.siteIdentifier,
    publishedAt: manifest?.publishedAt,
    updatedAt: manifest?.updatedAt,
    latestCaptureId: manifest?.latestCaptureId,
    captureExportUrl,
    transparencyLogUrl,
    attestationCount: exportSummary.attestationSummary?.attestationCount ?? 0,
    lineageNodeCount: exportSummary.lineageSummary?.lineageNodeCount ?? 0,
    hasTransparencyMaterials: transparencyEntryPresent,
    hasWorkflowClaims:
      Boolean(exportSummary.attestationSummary?.hasAttestations) ||
      (exportSummary.attestationSummary?.attestationCount ?? 0) > 0,
    materials: {
      manifestFound: Boolean(manifestUrl),
      captureExportFound: Boolean(captureExportUrl),
      transparencyEntryFound: transparencyEntryPresent
    }
  };
};

export const badgeStateForDiscovery = ({ manifestDetected, hadError }) => {
  if (hadError) {
    return {
      text: "!",
      color: "#d4a017",
      label: "Manifest detected but details could not be loaded."
    };
  }

  if (manifestDetected) {
    return {
      text: "P",
      color: "#2f855a",
      label: "Proof materials detected."
    };
  }

  return {
    text: "",
    color: "#718096",
    label: "No authenticity manifest detected."
  };
};
