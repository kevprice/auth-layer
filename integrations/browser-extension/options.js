import { DEFAULT_VERIFIER_URL, readVerifierUrl, writeVerifierUrl } from "./src/settings.js";

const input = document.querySelector("#verifier-url");
const saveButton = document.querySelector("#save-options");
const resetButton = document.querySelector("#reset-options");
const saveStatus = document.querySelector("#save-status");

const initialize = async () => {
  input.value = await readVerifierUrl();
};

saveButton.addEventListener("click", async () => {
  const value = await writeVerifierUrl(input.value);
  input.value = value;
  saveStatus.textContent = "Options saved.";
});

resetButton.addEventListener("click", async () => {
  const value = await writeVerifierUrl(DEFAULT_VERIFIER_URL);
  input.value = value;
  saveStatus.textContent = "Verifier URL reset to default.";
});

void initialize();
