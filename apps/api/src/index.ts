import "dotenv/config";

import { createServer } from "node:http";

import { createRuntimeServices } from "@auth-layer/core";

import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const services = createRuntimeServices();
const app = createApp(services);
const server = createServer(app);

server.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

const shutdown = async () => {
  services.worker.stop();
  await services.repository.close?.();
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
