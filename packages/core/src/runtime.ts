import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Pool } from "pg";

import type { CaptureRepository } from "./repositories/captureRepository.js";
import { PostgresCaptureRepository } from "./repositories/postgresCaptureRepository.js";
import { CaptureProcessor } from "./services/captureProcessor.js";
import { ExtractionService } from "./services/extractionService.js";
import { FetchService } from "./services/fetchService.js";
import { HashService } from "./services/hashService.js";
import { PdfApprovalService, Ed25519PdfApprovalSigner } from "./services/pdfApprovalService.js";
import { ProofPackageService } from "./services/proofPackageService.js";
import { BrowserScreenshotService } from "./services/screenshotService.js";
import { WatchlistService } from "./services/watchlistService.js";
import { InternalHmacTimestampProvider } from "./services/timestampProvider.js";
import {
  DEV_OPERATOR_PRIVATE_KEY_PEM,
  DEV_OPERATOR_PUBLIC_KEY_PEM,
  Ed25519TransparencyCheckpointSigner,
  TransparencyLogService
} from "./services/transparencyLogService.js";
import { FileSystemObjectStore } from "./storage/fileSystemObjectStore.js";
import { PollingWorker } from "./worker/pollingWorker.js";

export type RuntimeServices = {
  repository: CaptureRepository;
  objectStore: FileSystemObjectStore;
  processor: CaptureProcessor;
  proofPackageService: ProofPackageService;
  transparencyLogService: TransparencyLogService;
  pdfApprovalService: PdfApprovalService;
  watchlistService: WatchlistService;
  worker: PollingWorker;
};

const readConfiguredValue = (value?: string, path?: string): string | undefined => {
  if (value?.trim()) {
    return value;
  }

  if (path?.trim()) {
    return readFileSync(resolve(path), "utf8");
  }

  return undefined;
};

const createOperatorKeyConfig = () => ({
  privateKeyPem: readConfiguredValue(process.env.OPERATOR_PRIVATE_KEY_PEM, process.env.OPERATOR_PRIVATE_KEY_PATH)
    ?? DEV_OPERATOR_PRIVATE_KEY_PEM,
  publicKeyPem: readConfiguredValue(process.env.OPERATOR_PUBLIC_KEY_PEM, process.env.OPERATOR_PUBLIC_KEY_PATH)
    ?? DEV_OPERATOR_PUBLIC_KEY_PEM,
  operatorId: process.env.OPERATOR_ID?.trim() || "auth-layer-dev",
  keyId: process.env.OPERATOR_KEY_ID?.trim() || "auth-layer-dev-ed25519-v1",
  createdAt: process.env.OPERATOR_KEY_CREATED_AT?.trim() || "2026-03-15T00:00:00.000Z"
});

const createTransparencyCheckpointSigner = (): Ed25519TransparencyCheckpointSigner =>
  new Ed25519TransparencyCheckpointSigner(createOperatorKeyConfig());

const createPdfApprovalService = (): PdfApprovalService =>
  new PdfApprovalService(new Ed25519PdfApprovalSigner(createOperatorKeyConfig()));

export const resolveEmbeddedWorkerEnabled = (embeddedWorker?: boolean): boolean => {
  if (embeddedWorker !== undefined) {
    return embeddedWorker;
  }

  const configuredValue = process.env.EMBEDDED_WORKER?.trim().toLowerCase();

  if (configuredValue === undefined || configuredValue === "") {
    return true;
  }

  return configuredValue !== "false";
};

export const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Run npm run db:migrate after configuring it in .env.");
  }

  return databaseUrl;
};

const createRepository = (): CaptureRepository =>
  new PostgresCaptureRepository(new Pool({ connectionString: requireDatabaseUrl() }));

export const createRuntimeServices = (options?: {
  baseDirectory?: string;
  embeddedWorker?: boolean;
  fetchImpl?: typeof fetch;
}): RuntimeServices => {
  const baseDirectory = options?.baseDirectory ?? process.cwd();
  const repository = createRepository();
  const objectStore = new FileSystemObjectStore(
    resolve(baseDirectory, process.env.ARTIFACT_STORAGE_DIR ?? ".data/artifacts")
  );
  const timestampProvider = new InternalHmacTimestampProvider(process.env.TIMESTAMP_SECRET ?? "change-me");
  const transparencyLogService = new TransparencyLogService(repository, createTransparencyCheckpointSigner());
  const pdfApprovalService = createPdfApprovalService();
  const screenshotService = new BrowserScreenshotService(
    process.env.RENDER_BROWSER_PATH?.trim() || undefined,
    {
      width: Number(process.env.RENDER_VIEWPORT_WIDTH ?? 1440),
      height: Number(process.env.RENDER_VIEWPORT_HEIGHT ?? 960)
    }
  );
  const processor = new CaptureProcessor(
    repository,
    objectStore,
    new FetchService(options?.fetchImpl ?? fetch),
    new ExtractionService(),
    new HashService(),
    timestampProvider,
    transparencyLogService,
    screenshotService,
    pdfApprovalService
  );
  const proofPackageService = new ProofPackageService(repository, objectStore, processor, transparencyLogService);
  const watchlistService = new WatchlistService(
    repository,
    processor,
    process.env.WATCHLIST_EXTRACTOR_VERSION?.trim() || "readability-v1",
    options?.fetchImpl ?? fetch,
    process.env.WEB_ORIGIN
  );
  const worker = new PollingWorker(repository, processor, Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1500), undefined, watchlistService);

  if (resolveEmbeddedWorkerEnabled(options?.embeddedWorker)) {
    worker.start();
  }

  return { repository, objectStore, processor, proofPackageService, transparencyLogService, pdfApprovalService, watchlistService, worker };
};
