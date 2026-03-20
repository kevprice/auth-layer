import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OperatorPublicKey, TransparencyCheckpoint } from "@auth-layer/shared";

import { InternalHmacTimestampProvider } from "../src/services/timestampProvider.js";
import { verifyProofPackageDirectory } from "../src/services/proofPackageService.js";

const args = process.argv.slice(2);
const packageDirectory = args[0];

if (!packageDirectory) {
  console.error("Usage: npm run proof:verify -- <package-directory> [--checkpoint <checkpoint.json>] [--operator-key <operator-public-key.json>] [--timestamp-secret <secret>] [--inspect-lineage]");
  process.exit(1);
}

const operatorKeyPaths: string[] = [];
let checkpointPath: string | undefined;
let timestampSecret: string | undefined;
let inspectLineage = false;

for (let index = 1; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--checkpoint") {
    checkpointPath = args[index + 1];
    index += 1;
    continue;
  }

  if (argument === "--operator-key") {
    const operatorKeyPath = args[index + 1];
    if (operatorKeyPath) {
      operatorKeyPaths.push(operatorKeyPath);
    }
    index += 1;
    continue;
  }

  if (argument === "--timestamp-secret") {
    timestampSecret = args[index + 1];
    index += 1;
    continue;
  }

  if (argument === "--inspect-lineage") {
    inspectLineage = true;
  }
}

const trustedOperatorKeys = await Promise.all(
  operatorKeyPaths.map(async (operatorKeyPath) =>
    JSON.parse(await readFile(resolve(operatorKeyPath), "utf8")) as OperatorPublicKey
  )
);
const checkpoint = checkpointPath
  ? (JSON.parse(await readFile(resolve(checkpointPath), "utf8")) as TransparencyCheckpoint)
  : undefined;

console.error("Verification order: 1) proof package integrity 2) Merkle inclusion proof 3) checkpoint signature 4) optional PDF approval receipt");
if (inspectLineage) {
  console.error("Lineage inspection: package integrity remains the trust boundary. Lineage metadata is package-authored provenance and does not by itself prove semantic equivalence.");
}

const report = await verifyProofPackageDirectory(resolve(packageDirectory), {
  timestampProvider: timestampSecret
    ? new InternalHmacTimestampProvider(timestampSecret)
    : undefined,
  trustedOperatorKeys,
  checkpoint,
  inspectLineage
});

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
