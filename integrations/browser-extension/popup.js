import {
  EXTENSION_TRUST_NOTE,
  badgeStateForDiscovery,
  buildPreviewModel
} from "./src/discovery.js";
import { DEFAULT_VERIFIER_URL, readVerifierUrl } from "./src/settings.js";

const statusPill = document.querySelector("#status-pill");
const statusCopy = document.querySelector("#status-copy");
const summaryList = document.querySelector("#summary-list");
const materialsList = document.querySelector("#materials-list");
const claimsList = document.querySelector("#claims-list");
const actions = document.querySelector("#actions");

const renderSummaryRows = (rows) => {
  summaryList.replaceChildren();
  for (const row of rows) {
    const wrapper = document.createElement("div");
    const label = document.createElement("dt");
    const value = document.createElement("dd");
    label.textContent = row.label;
    value.textContent = row.value;
    wrapper.append(label, value);
    summaryList.appendChild(wrapper);
  }
};

const renderClaims = (items) => {
  claimsList.replaceChildren();
  for (const item of items) {
    const entry = document.createElement("li");
    entry.textContent = item;
    claimsList.appendChild(entry);
  }
};

const renderMaterials = (items) => {
  materialsList.replaceChildren();
  for (const item of items) {
    const entry = document.createElement("li");
    const label = document.createElement("span");
    const state = document.createElement("span");
    label.className = "material-label";
    state.className = `material-state material-state--${item.state}`;
    label.textContent = item.label;
    state.textContent = item.copy;
    entry.append(label, state);
    materialsList.appendChild(entry);
  }
};

const addLink = (label, href, download = false) => {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noreferrer";
  if (download) {
    link.download = "";
  }
  actions.appendChild(link);
};

const addButton = (label, onClick) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  actions.appendChild(button);
};

const setStatus = (state, detail) => {
  statusPill.textContent = state.label;
  statusPill.className = `pill ${state.hadError ? "pill--warning" : state.manifestDetected ? "pill--available" : "pill--neutral"}`;
  statusCopy.textContent = detail;
};

const getActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const requestPageDiscovery = async (tabId) => chrome.tabs.sendMessage(tabId, { type: "auth-layer:get-page-discovery" });

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
};

const materialState = (found, unknown = false) => {
  if (unknown) {
    return { state: "unknown", copy: "unknown" };
  }
  return found ? { state: "yes", copy: "found" } : { state: "no", copy: "not found" };
};

const renderNoContext = (verifierUrl) => {
  setStatus({ manifestDetected: false, hadError: false, label: "No page context" }, "Open a webpage to use discovery.");
  renderSummaryRows([{ label: "Page", value: "No active tab" }]);
  renderMaterials([
    { label: "Manifest", ...materialState(false) },
    { label: "Capture export", ...materialState(false) },
    { label: "Transparency entry", ...materialState(false) }
  ]);
  renderClaims([EXTENSION_TRUST_NOTE]);
  addLink("Open verifier", verifierUrl);
};

const renderNoManifest = (pageUrl, verifierUrl) => {
  const neutral = { ...badgeStateForDiscovery({ manifestDetected: false, hadError: false }), manifestDetected: false, hadError: false };
  setStatus(neutral, "No authenticity manifest was detected on this page.");
  renderSummaryRows([{ label: "Page", value: pageUrl }]);
  renderMaterials([
    { label: "Manifest", ...materialState(false) },
    { label: "Capture export", ...materialState(false) },
    { label: "Transparency entry", ...materialState(false) }
  ]);
  renderClaims([
    "No proof materials were advertised on this page.",
    EXTENSION_TRUST_NOTE
  ]);
  addLink("Open verifier", verifierUrl);
};

const renderDiscoveredPreview = (preview, verifierUrl) => {
  const available = { ...badgeStateForDiscovery({ manifestDetected: true, hadError: false }), manifestDetected: true, hadError: false };
  setStatus(
    available,
    "Manifest detected. This popup shows where proof materials exist and what claims they advertise. Offline verification is still recommended for full checking."
  );
  renderSummaryRows([
    { label: "Page", value: preview.pageUrl },
    { label: "Artifact type", value: preview.artifactType ?? "Not stated" },
    { label: "Title", value: preview.title ?? "Not stated" },
    { label: "Publisher / site", value: preview.publisher ?? "Not stated" },
    { label: "Published", value: preview.publishedAt ?? "Not stated" },
    { label: "Updated", value: preview.updatedAt ?? "Not stated" }
  ]);
  renderMaterials([
    { label: "Manifest", ...materialState(preview.materials.manifestFound) },
    { label: "Capture export", ...materialState(preview.materials.captureExportFound) },
    { label: "Transparency entry", ...materialState(preview.materials.transparencyEntryFound) }
  ]);
  renderClaims([
    preview.hasWorkflowClaims
      ? `Workflow or identity claims are present (${preview.attestationCount} attestation${preview.attestationCount === 1 ? "" : "s"}).`
      : "No workflow attestation claims were surfaced in this preview.",
    preview.lineageNodeCount > 0
      ? `Revision or lineage metadata is present (${preview.lineageNodeCount} node${preview.lineageNodeCount === 1 ? "" : "s"}).`
      : "No lineage metadata was surfaced in this preview.",
    "Named actors remain informational claims unless independently verified.",
    EXTENSION_TRUST_NOTE
  ]);

  addLink("Open verifier", verifierUrl);
  addButton("Extension options", () => chrome.runtime.openOptionsPage());
  addLink("Open manifest JSON", preview.manifestUrl);
  addLink("Download manifest JSON", preview.manifestUrl, true);
  if (preview.captureExportUrl) {
    addLink("Open capture export JSON", preview.captureExportUrl);
    addLink("Download capture export JSON", preview.captureExportUrl, true);
  }
  if (preview.transparencyLogUrl) {
    addLink("Open transparency entry", preview.transparencyLogUrl);
  }
};

const renderLoadError = (pageUrl, verifierUrl, errorMessage) => {
  const warning = { ...badgeStateForDiscovery({ manifestDetected: true, hadError: true }), manifestDetected: true, hadError: true };
  setStatus(warning, errorMessage);
  renderSummaryRows([{ label: "Page", value: pageUrl }]);
  renderMaterials([
    { label: "Manifest", ...materialState(true) },
    { label: "Capture export", ...materialState(false, true) },
    { label: "Transparency entry", ...materialState(false, true) }
  ]);
  renderClaims([
    "Manifest may exist, but preview details could not be loaded.",
    "This is not the same as a cryptographic verification failure.",
    EXTENSION_TRUST_NOTE
  ]);
  addLink("Open verifier", verifierUrl);
  addButton("Extension options", () => chrome.runtime.openOptionsPage());
};

const initialize = async () => {
  const tab = await getActiveTab();
  const verifierUrl = await readVerifierUrl().catch(() => DEFAULT_VERIFIER_URL);
  actions.replaceChildren();

  if (!tab?.id || !tab.url) {
    renderNoContext(verifierUrl);
    return;
  }

  try {
    const pageState = await requestPageDiscovery(tab.id);
    const manifestUrl = pageState?.manifestUrl;

    if (!manifestUrl) {
      renderNoManifest(tab.url, verifierUrl);
      return;
    }

    const manifestPayload = await fetchJson(manifestUrl);
    const manifest = manifestPayload.manifest ?? manifestPayload;
    const exportPayload = manifest.captureExportUrl ? await fetchJson(new URL(manifest.captureExportUrl, manifestUrl).toString()) : undefined;
    const preview = buildPreviewModel({ pageUrl: tab.url, manifestUrl, manifest, exportPayload });

    renderDiscoveredPreview(preview, verifierUrl);
  } catch (error) {
    chrome.tabs.sendMessage(tab.id, { type: "auth-layer:page-error" }).catch(() => undefined);
    renderLoadError(
      tab.url,
      verifierUrl,
      error instanceof Error ? error.message : "Manifest detected but preview details could not be loaded."
    );
  }
};

void initialize();
