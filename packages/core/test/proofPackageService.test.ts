import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";

import {
  CaptureProcessor,
  Ed25519TransparencyCheckpointSigner,
  EXTRACTOR_VERSION,
  ExtractionService,
  FetchService,
  FileSystemObjectStore,
  HashService,
  InternalHmacTimestampProvider,
  normalizeRequestedUrl,
  PostgresCaptureRepository,
  ProofPackageService,
  runMigrations,
  TransparencyLogService,
  verifyProofPackageDirectory
} from "../src/index.js";

const html = `
<!doctype html>
<html lang="en">
  <head>
    <title>Proof package story</title>
    <meta property="og:title" content="Proof package story" />
    <meta name="author" content="Ada Lovelace" />
    <meta property="article:published_time" content="2024-11-05T09:00:00Z" />
  </head>
  <body>
    <article>
      <h1>Proof package story</h1>
      <p>This capture exists so we can export a portable proof package.</p>
      <p>The canonical content, proof bundle, and receipt should all verify offline.</p>
      <p>The transparency log entry and checkpoint should also be included.</p>
    </article>
  </body>
</html>`;

const createFetchResponse = (finalUrl: string): Response =>
  ({
    status: 200,
    url: finalUrl,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    arrayBuffer: async () => Buffer.from(html)
  } as unknown as Response);

const temporaryDirectories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createSigner = () =>
  new Ed25519TransparencyCheckpointSigner({
    privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICuDjMQ9dp3BORmrTQ3bY68tEe7Pg5s3O1zt9KCuzK/J
-----END PRIVATE KEY-----`,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7qW1iCRvTCU4Zz2iLX7gSV8l2N4NLCVpNYD+ps5c/nQ=
-----END PUBLIC KEY-----`,
    operatorId: "test-operator",
    keyId: "test-operator-ed25519-v1",
    createdAt: "2026-03-15T00:00:00.000Z"
  });

const createWrongSigner = () =>
  new Ed25519TransparencyCheckpointSigner({
    privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAuzj2GLsMt5VVyHg+e4l+DWgmA36VZ82fpOLGqB+q7p
-----END PRIVATE KEY-----`,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJSbEaH0MUyBvjicDXzVaX06XAhhOr88bURtXg8/ExJ8=
-----END PUBLIC KEY-----`,
    operatorId: "wrong-operator",
    keyId: "wrong-operator-ed25519-v1",
    createdAt: "2026-03-15T00:00:00.000Z"
  });

type Harness = {
  rootDirectory: string;
  repository: PostgresCaptureRepository;
  proofPackageService: ProofPackageService;
  processor: CaptureProcessor;
  timestampProvider: InternalHmacTimestampProvider;
  checkpointSigner: Ed25519TransparencyCheckpointSigner;
};

const createHarness = async (): Promise<Harness> => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "auth-layer-proof-package-"));
  temporaryDirectories.push(rootDirectory);

  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await runMigrations(pool);

  const repository = new PostgresCaptureRepository(pool);
  const objectStore = new FileSystemObjectStore(join(rootDirectory, "artifacts"));
  const timestampProvider = new InternalHmacTimestampProvider("test-secret");
  const checkpointSigner = createSigner();
  const transparencyLogService = new TransparencyLogService(repository, checkpointSigner);
  const processor = new CaptureProcessor(
    repository,
    objectStore,
    new FetchService(async (url) => createFetchResponse(url.replace("/proof-story", "/final-proof-story"))),
    new ExtractionService(),
    new HashService(),
    timestampProvider,
    transparencyLogService
  );
  const proofPackageService = new ProofPackageService(repository, objectStore, processor, transparencyLogService);

  closers.push(async () => {
    await repository.close();
  });

  return {
    rootDirectory,
    repository,
    proofPackageService,
    processor,
    timestampProvider,
    checkpointSigner
  };
};

const createCompletedCapture = async (harness: Harness, requestedUrl = "https://news.example.com/proof-story") => {
  const capture = await harness.repository.createCapture({
    requestedUrl,
    normalizedRequestedUrl: normalizeRequestedUrl(requestedUrl),
    extractorVersion: EXTRACTOR_VERSION
  });

  const processed = await harness.processor.processClaimedCapture(capture);
  expect(processed.status).toBe("completed");
  return capture;
};

describe("ProofPackageService", () => {
  it("writes a portable proof package that verifies offline with a trusted operator key", async () => {
    const harness = await createHarness();
    const capture = await createCompletedCapture(harness);

    const packageDirectory = join(harness.rootDirectory, "proof-package");
    const { manifestPath } = await harness.proofPackageService.writePackage(capture.id, packageDirectory);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.packageType).toBe("auth-layer-proof-package");
    expect(manifest.captureId).toBe(capture.id);
    expect(manifest.files.operatorPublicKey.path).toBe("operator-public-key.json");
    expect(manifest.files.transparencyInclusionProof.path).toBe("transparency-inclusion-proof.json");
    expect(manifest.files.diagnostics?.path).toBe("diagnostics.json");

    const report = await verifyProofPackageDirectory(packageDirectory, {
      timestampProvider: harness.timestampProvider,
      trustedOperatorKeys: [harness.checkpointSigner.getPublicKey()]
    });

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("fails verification when canonical content is tampered", async () => {
    const harness = await createHarness();
    const capture = await createCompletedCapture(harness);

    const packageDirectory = join(harness.rootDirectory, "tampered-proof-package");
    await harness.proofPackageService.writePackage(capture.id, packageDirectory);

    const canonicalContentPath = join(packageDirectory, "canonical-content.json");
    const canonicalContent = JSON.parse(await readFile(canonicalContentPath, "utf8"));
    canonicalContent.blocks[0].text = "Tampered paragraph";
    await writeFile(canonicalContentPath, JSON.stringify(canonicalContent, null, 2));

    const report = await verifyProofPackageDirectory(packageDirectory, {
      timestampProvider: harness.timestampProvider,
      trustedOperatorKeys: [harness.checkpointSigner.getPublicKey()]
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "canonical-content-hash")?.ok).toBe(false);
  });

  it("fails verification when the inclusion proof is tampered", async () => {
    const harness = await createHarness();
    const capture = await createCompletedCapture(harness);

    const packageDirectory = join(harness.rootDirectory, "tampered-inclusion-proof-package");
    await harness.proofPackageService.writePackage(capture.id, packageDirectory);

    const inclusionProofPath = join(packageDirectory, "transparency-inclusion-proof.json");
    const inclusionProof = JSON.parse(await readFile(inclusionProofPath, "utf8"));
    inclusionProof.rootHash = "sha256:tampered-root";
    await writeFile(inclusionProofPath, JSON.stringify(inclusionProof, null, 2));

    const report = await verifyProofPackageDirectory(packageDirectory, {
      timestampProvider: harness.timestampProvider,
      trustedOperatorKeys: [harness.checkpointSigner.getPublicKey()]
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "transparency-proof-root-link")?.ok).toBe(false);
  });

  it("fails verification when a different checkpoint is supplied", async () => {
    const harness = await createHarness();
    const firstCapture = await createCompletedCapture(harness, "https://news.example.com/proof-story-a");

    const packageDirectory = join(harness.rootDirectory, "wrong-checkpoint-package");
    await harness.proofPackageService.writePackage(firstCapture.id, packageDirectory);

    await createCompletedCapture(harness, "https://news.example.com/proof-story-b");
    const wrongCheckpoint = await harness.repository.getLatestTransparencyCheckpoint();
    expect(wrongCheckpoint?.treeSize).toBe(2);

    const report = await verifyProofPackageDirectory(packageDirectory, {
      timestampProvider: harness.timestampProvider,
      trustedOperatorKeys: [harness.checkpointSigner.getPublicKey()],
      checkpoint: wrongCheckpoint
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "transparency-proof-checkpoint-link")?.ok).toBe(false);
  });

  it("fails verification when the operator key is not trusted", async () => {
    const harness = await createHarness();
    const capture = await createCompletedCapture(harness);
    const wrongSigner = createWrongSigner();

    const packageDirectory = join(harness.rootDirectory, "wrong-operator-key-package");
    await harness.proofPackageService.writePackage(capture.id, packageDirectory);

    const report = await verifyProofPackageDirectory(packageDirectory, {
      timestampProvider: harness.timestampProvider,
      trustedOperatorKeys: [wrongSigner.getPublicKey()]
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "transparency-checkpoint-signature")?.ok).toBe(false);
  });
});



