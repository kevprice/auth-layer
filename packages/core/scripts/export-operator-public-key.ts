import "dotenv/config";

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import { createRuntimeServices } from "../src/runtime.js";

const [outputPath] = process.argv.slice(2);
const services = createRuntimeServices({ embeddedWorker: false });

try {
  const operatorPublicKey = services.transparencyLogService.getOperatorPublicKey();
  const serialized = JSON.stringify(operatorPublicKey, null, 2);

  if (outputPath) {
    const target = resolve(outputPath);
    await writeFile(target, serialized);
    console.log(`Operator public key written to ${target}`);
  } else {
    console.log(serialized);
  }
} finally {
  services.worker.stop();
  await services.repository.close?.();
}
