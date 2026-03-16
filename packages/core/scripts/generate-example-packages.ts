import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { newDb } from "pg-mem";

import {
  CaptureProcessor,
  DEV_OPERATOR_PRIVATE_KEY_PEM,
  DEV_OPERATOR_PUBLIC_KEY_PEM,
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
  TransparencyLogService
} from "../src/index.js";

const WRONG_OPERATOR_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAuzj2GLsMt5VVyHg+e4l+DWgmA36VZ82fpOLGqB+q7p
-----END PRIVATE KEY-----
`;

const WRONG_OPERATOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJSbEaH0MUyBvjicDXzVaX06XAhhOr88bURtXg8/ExJ8=
-----END PUBLIC KEY-----
`;

const html = `
<!doctype html>
<html lang="en">
  <head>
    <title>Example proof package story</title>
    <meta property="og:title" content="Example proof package story" />
    <meta name="author" content="Example Reporter" />
    <meta property="article:published_time" content="2024-11-05T09:00:00Z" />
  </head>
  <body>
    <article>
      <h1>Example proof package story</h1>
      <p>This fixture demonstrates a valid exported proof package.</p>
      <p>It also acts as the source material for intentionally broken examples.</p>
      <p>Independent verifiers should detect when these files are tampered.</p>
    </article>
  </body>
</html>`;

const createFetchResponse = (url: string): Response =>
  ({
    status: 200,
    url,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    arrayBuffer: async () => Buffer.from(html)
  } as unknown as Response);

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(value, null, 2));
};

const createCapture = async (
  repository: PostgresCaptureRepository,
  processor: CaptureProcessor,
  requestedUrl: string
) => {
  const capture = await repository.createCapture({
    requestedUrl,
    normalizedRequestedUrl: normalizeRequestedUrl(requestedUrl),
    extractorVersion: EXTRACTOR_VERSION
  });
  const processed = await processor.processClaimedCapture(capture);
  if (processed.status !== "completed") {
    throw new Error(`Failed to generate example package: ${processed.errorMessage ?? processed.status}`);
  }
  return capture;
};

const main = async (): Promise<void> => {
  const examplesRoot = resolve("examples");
  const proofPackagesRoot = join(examplesRoot, "proof-packages");
  const checkpointsRoot = join(examplesRoot, "checkpoints");
  const operatorKeysRoot = join(examplesRoot, "operator-keys");
  const tempRoot = await mkdtemp(join(tmpdir(), "auth-layer-example-"));

  await rm(examplesRoot, { recursive: true, force: true });
  await mkdir(proofPackagesRoot, { recursive: true });
  await mkdir(checkpointsRoot, { recursive: true });
  await mkdir(operatorKeysRoot, { recursive: true });

  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await runMigrations(pool);

  const repository = new PostgresCaptureRepository(pool);
  const objectStore = new FileSystemObjectStore(join(tempRoot, "artifacts"));
  const timestampProvider = new InternalHmacTimestampProvider("example-secret");
  const checkpointSigner = new Ed25519TransparencyCheckpointSigner({
    privateKeyPem: DEV_OPERATOR_PRIVATE_KEY_PEM,
    publicKeyPem: DEV_OPERATOR_PUBLIC_KEY_PEM,
    operatorId: "auth-layer-dev",
    keyId: "auth-layer-dev-ed25519-v1",
    createdAt: "2026-03-15T00:00:00.000Z"
  });
  const wrongSigner = new Ed25519TransparencyCheckpointSigner({
    privateKeyPem: WRONG_OPERATOR_PRIVATE_KEY_PEM,
    publicKeyPem: WRONG_OPERATOR_PUBLIC_KEY_PEM,
    operatorId: "auth-layer-wrong",
    keyId: "auth-layer-wrong-ed25519-v1",
    createdAt: "2026-03-15T00:00:00.000Z"
  });
  const transparencyLogService = new TransparencyLogService(repository, checkpointSigner);
  const processor = new CaptureProcessor(
    repository,
    objectStore,
    new FetchService(async (url) => createFetchResponse(url.replace("/example-story", "/final-example-story"))),
    new ExtractionService(),
    new HashService(),
    timestampProvider,
    transparencyLogService
  );
  const proofPackageService = new ProofPackageService(repository, objectStore, processor, transparencyLogService);

  const primaryCapture = await createCapture(repository, processor, "https://news.example.com/example-story");
  const validDirectory = join(proofPackagesRoot, "valid");
  await proofPackageService.writePackage(primaryCapture.id, validDirectory);

  const validCheckpoint = await repository.getLatestTransparencyCheckpoint();
  if (!validCheckpoint) {
    throw new Error("Failed to generate example checkpoint");
  }

  await writeJson(join(checkpointsRoot, "valid-checkpoint.json"), validCheckpoint);
  await writeJson(join(operatorKeysRoot, "dev-operator.public-key.json"), checkpointSigner.getPublicKey());
  await writeJson(join(operatorKeysRoot, "wrong-operator.public-key.json"), wrongSigner.getPublicKey());

  const secondCapture = await createCapture(repository, processor, "https://news.example.com/example-story-second");
  const wrongCheckpoint = await repository.getLatestTransparencyCheckpoint();
  if (!wrongCheckpoint || wrongCheckpoint.checkpointId === validCheckpoint.checkpointId || secondCapture.id === primaryCapture.id) {
    throw new Error("Failed to generate a distinct wrong checkpoint fixture");
  }
  await writeJson(join(checkpointsRoot, "wrong-checkpoint.json"), wrongCheckpoint);

  const tamperedCanonicalDirectory = join(proofPackagesRoot, "tampered-canonical-content");
  await cp(validDirectory, tamperedCanonicalDirectory, { recursive: true });
  const canonicalPath = join(tamperedCanonicalDirectory, "canonical-content.json");
  const canonicalContent = JSON.parse(await readFile(canonicalPath, "utf8"));
  canonicalContent.blocks[0].text = "Tampered canonical block text.";
  await writeJson(canonicalPath, canonicalContent);

  const tamperedInclusionProofDirectory = join(proofPackagesRoot, "tampered-inclusion-proof");
  await cp(validDirectory, tamperedInclusionProofDirectory, { recursive: true });
  const inclusionProofPath = join(tamperedInclusionProofDirectory, "transparency-inclusion-proof.json");
  const inclusionProof = JSON.parse(await readFile(inclusionProofPath, "utf8"));
  inclusionProof.rootHash = "sha256:tampered-merkle-root";
  await writeJson(inclusionProofPath, inclusionProof);

  const badReceiptDirectory = join(proofPackagesRoot, "bad-receipt");
  await cp(validDirectory, badReceiptDirectory, { recursive: true });
  const receiptPath = join(badReceiptDirectory, "receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.proofBundleHash = "sha256:tampered-receipt-bundle";
  await writeJson(receiptPath, receipt);

  const badCheckpointDirectory = join(proofPackagesRoot, "bad-checkpoint-signature");
  await cp(validDirectory, badCheckpointDirectory, { recursive: true });
  const checkpointPath = join(badCheckpointDirectory, "transparency-checkpoint.json");
  const tamperedCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  tamperedCheckpoint.signature = `${tamperedCheckpoint.signature.slice(0, -1)}A`;
  await writeJson(checkpointPath, tamperedCheckpoint);

  await writeFile(
    join(examplesRoot, "README.md"),
    `# Example Artifacts

- \`operator-keys/dev-operator.public-key.json\`: trusted public key for the valid example operator
- \`operator-keys/wrong-operator.public-key.json\`: non-matching operator key for negative verification tests
- \`checkpoints/valid-checkpoint.json\`: signed Merkle checkpoint for the valid example package
- \`checkpoints/wrong-checkpoint.json\`: valid but mismatched checkpoint from a later log state
- \`proof-packages/valid\`: valid exported proof package with a Merkle inclusion proof
- \`proof-packages/tampered-canonical-content\`: canonical content modified after export
- \`proof-packages/tampered-inclusion-proof\`: inclusion proof modified after export
- \`proof-packages/bad-receipt\`: receipt references the wrong proof bundle hash
- \`proof-packages/bad-checkpoint-signature\`: checkpoint signature has been tampered

Verify the valid example with:

\`npm run proof:verify -- examples/proof-packages/valid --checkpoint examples/checkpoints/valid-checkpoint.json --operator-key examples/operator-keys/dev-operator.public-key.json\`

Negative checks:

- wrong checkpoint: \`npm run proof:verify -- examples/proof-packages/valid --checkpoint examples/checkpoints/wrong-checkpoint.json --operator-key examples/operator-keys/dev-operator.public-key.json\`
- wrong operator key: \`npm run proof:verify -- examples/proof-packages/valid --checkpoint examples/checkpoints/valid-checkpoint.json --operator-key examples/operator-keys/wrong-operator.public-key.json\`
- tampered inclusion proof: \`npm run proof:verify -- examples/proof-packages/tampered-inclusion-proof --checkpoint examples/checkpoints/valid-checkpoint.json --operator-key examples/operator-keys/dev-operator.public-key.json\`
`,
    "utf8"
  );

  await repository.close();
  await rm(tempRoot, { recursive: true, force: true });

  console.log(`Example proof packages written to ${examplesRoot}`);
};

await main();
