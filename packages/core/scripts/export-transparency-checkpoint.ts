import "dotenv/config";

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import { createRuntimeServices } from "../src/runtime.js";

const [outputPath] = process.argv.slice(2);
const services = createRuntimeServices({ embeddedWorker: false });

try {
  const checkpoint = await services.repository.getLatestTransparencyCheckpoint();

  if (!checkpoint) {
    console.error("No transparency checkpoint is available yet.");
    process.exit(1);
  }

  const serialized = JSON.stringify(checkpoint, null, 2);
  if (outputPath) {
    const target = resolve(outputPath);
    await writeFile(target, serialized);
    console.log(`Transparency checkpoint written to ${target}`);
  } else {
    console.log(serialized);
  }
} finally {
  services.worker.stop();
  await services.repository.close?.();
}
