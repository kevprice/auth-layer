import "dotenv/config";

import { createRuntimeServices } from "@auth-layer/core";

const services = createRuntimeServices({ embeddedWorker: false });
services.worker.start();

console.log("Worker polling for queued captures");

const shutdown = async () => {
  services.worker.stop();
  await services.repository.close?.();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
