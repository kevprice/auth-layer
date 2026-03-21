import { findAuthenticityManifestHref, resolveManifestUrl } from "./src/discovery.js";

const getPageDiscovery = () => ({
  pageUrl: window.location.href,
  manifestUrl: resolveManifestUrl(findAuthenticityManifestHref(document), window.location.href)
});

const publishState = () => {
  chrome.runtime.sendMessage({
    type: "auth-layer:page-state",
    payload: getPageDiscovery()
  });
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "auth-layer:get-page-discovery") {
    sendResponse(getPageDiscovery());
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", publishState, { once: true });
} else {
  publishState();
}
