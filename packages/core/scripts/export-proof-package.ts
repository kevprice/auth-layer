import "dotenv/config";

import { resolve } from "node:path";

import { createRuntimeServices } from "../src/runtime.js";

const [captureId, outputDirectory] = process.argv.slice(2);

if (!captureId || !outputDirectory) {
  console.error("Usage: npm run proof:export -- <capture-id> <output-directory>");
  process.exit(1);
}

const services = createRuntimeServices({ embeddedWorker: false });

try {
  const { manifestPath } = await services.proofPackageService.writePackage(captureId, resolve(outputDirectory));
  console.log(`Proof package written to ${manifestPath}`);
} finally {
  services.worker.stop();
  await services.repository.close?.();
}
