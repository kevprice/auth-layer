import { badgeStateForDiscovery } from "./src/discovery.js";

const applyBadgeState = async (tabId, state) => {
  if (typeof tabId !== "number") {
    return;
  }

  await chrome.action.setBadgeText({ tabId, text: state.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: state.color });
  await chrome.action.setTitle({ tabId, title: state.label });
};

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "auth-layer:page-state") {
    const state = badgeStateForDiscovery({
      manifestDetected: Boolean(message.payload?.manifestUrl),
      hadError: false
    });
    void applyBadgeState(sender.tab?.id, state);
  }

  if (message?.type === "auth-layer:page-error") {
    const state = badgeStateForDiscovery({ manifestDetected: true, hadError: true });
    void applyBadgeState(sender.tab?.id, state);
  }
});
