export const DEFAULT_VERIFIER_URL = "http://localhost:3000/#/verify";
const KEY = "verifierUrl";

export const readVerifierUrl = async () => {
  const stored = await chrome.storage.sync.get(KEY);
  return typeof stored[KEY] === "string" && stored[KEY].trim() ? stored[KEY].trim() : DEFAULT_VERIFIER_URL;
};

export const writeVerifierUrl = async (value) => {
  const next = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_VERIFIER_URL;
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
};
