import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { createLineageBundle, hashLineageBundle } from "@auth-layer/shared";

import { browserVerifierLimits, verifyProofPackageZip } from "../src/browserVerifier";

const root = process.cwd();

const collectFiles = async (directory: string, prefix = ""): Promise<Array<{ path: string; body: Uint8Array }>> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; body: Uint8Array }> = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, relativePath));
    } else {
      files.push({ path: relativePath, body: new Uint8Array(await readFile(absolutePath)) });
    }
  }

  return files;
};

const zipDirectory = async (directory: string, mutate?: (zip: JSZip) => Promise<void> | void): Promise<File> => {
  const zip = new JSZip();
  const files = await collectFiles(directory);

  for (const file of files) {
    zip.file(file.path, file.body);
  }

  if (mutate) {
    await mutate(zip);
  }

  const body = await zip.generateAsync({ type: "uint8array" });
  return new File([new Uint8Array(body) as unknown as BlobPart], `${path.basename(directory)}.zip`, { type: "application/zip" });
};

const writeJsonIntoZip = async (zip: JSZip, filePath: string, mutate: (value: any) => Promise<any> | any) => {
  const current = zip.file(filePath);
  if (!current) {
    throw new Error(`Missing ${filePath} in zip mutation.`);
  }

  const json = JSON.parse(await current.async("text"));
  zip.file(filePath, JSON.stringify(await mutate(json)));
};

const addLineageBundleToZip = async (zip: JSZip, mode: "valid" | "invalid-missing-node" | "verbatim-mismatch" = "valid") => {
  const lineageBundle = mode === "invalid-missing-node"
    ? createLineageBundle({
        contentObjects: [{ id: "root", type: "quote", text: "Original quote" }],
        edges: [{ from: "root", to: "missing", derivationType: "verbatim" }]
      })
    : mode === "verbatim-mismatch"
      ? createLineageBundle({
          contentObjects: [
            { id: "root", type: "transcript-segment", text: "Original full sentence" },
            { id: "quote", type: "quote", text: "Different full sentence" }
          ],
          edges: [{ from: "root", to: "quote", derivationType: "verbatim" }],
          rootObjectIds: ["root"]
        })
      : createLineageBundle({
          contentObjects: [
            { id: "root", type: "transcript-segment", text: "The original transcript segment includes this exact wording." },
            { id: "quote", type: "quote", text: "includes this exact wording", contextBefore: "The original transcript segment", contextAfter: "." },
            { id: "headline", type: "headline", text: "Exact wording included" }
          ],
          edges: [
            { from: "root", to: "quote", derivationType: "trimmed" },
            { from: "quote", to: "headline", derivationType: "headline" }
          ],
          rootObjectIds: ["root"]
        });

  zip.file("lineage.json", JSON.stringify(lineageBundle));
  await writeJsonIntoZip(zip, "manifest.json", async (manifest) => ({
    ...manifest,
    lineageBundleHash: await hashLineageBundle(lineageBundle),
    files: {
      ...manifest.files,
      lineageBundle: { path: "lineage.json", mediaType: "application/json; charset=utf-8", optional: false }
    }
  }));
};

describe("browser verifier", () => {
  it("verifies a valid package with user-supplied trust material", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"));
    const checkpointFile = new File(
      [await readFile(path.join(root, "examples/checkpoints/valid-checkpoint.json"))],
      "valid-checkpoint.json",
      { type: "application/json" }
    );
    const operatorKeyFile = new File(
      [await readFile(path.join(root, "examples/operator-keys/dev-operator.public-key.json"))],
      "dev-operator.public-key.json",
      { type: "application/json" }
    );

    const report = await verifyProofPackageZip({
      packageZip,
      checkpointFile,
      operatorKeyFiles: [operatorKeyFile]
    });

    expect(report.status).toBe("verified");
    expect(report.trustBasis.checkpointSource).toBe("user-supplied");
    expect(report.trustBasis.operatorKeySource).toBe("user-supplied");
    expect(report.trustBasis.independentTrustRootSuppliedByUser).toBe(true);
  });

  it("verifies a valid package with package-provided trust material", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"));

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("verified");
    expect(report.trustBasis.checkpointSource).toBe("package-provided");
    expect(report.trustBasis.operatorKeySource).toBe("package-provided");
    expect(report.trustBasis.independentTrustRootSuppliedByUser).toBe(false);
  });

  it("returns partially verified when checkpoint material is missing", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"), async (zip) => {
      zip.remove("transparency-checkpoint.json");
      await writeJsonIntoZip(zip, "manifest.json", (manifest) => ({
        ...manifest,
        files: {
          ...manifest.files,
          transparencyCheckpoint: {
            ...manifest.files.transparencyCheckpoint,
            optional: true
          }
        }
      }));
    });

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("partially-verified");
    expect(report.checks.find((check) => check.id === "merkle-inclusion-proof")?.status).toBe("incomplete");
    expect(report.trustBasis.checkpointSource).toBe("missing");
  });

  it("returns partially verified when operator key material is missing", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"), (zip) => {
      zip.remove("operator-public-key.json");
    });

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("partially-verified");
    expect(report.checks.find((check) => check.id === "checkpoint-signature")?.status).toBe("incomplete");
    expect(report.trustBasis.operatorKeySource).toBe("missing");
  });

  it("fails when canonical content has been tampered with", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/tampered-canonical-content"));

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "proof-package-integrity")?.status).toBe("fail");
  });

  it("fails when the inclusion proof has been tampered with", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/tampered-inclusion-proof"));

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "merkle-inclusion-proof")?.status).toBe("fail");
  });

  it("fails when the user supplies the wrong checkpoint", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"));
    const checkpointFile = new File(
      [await readFile(path.join(root, "examples/checkpoints/wrong-checkpoint.json"))],
      "wrong-checkpoint.json",
      { type: "application/json" }
    );

    const report = await verifyProofPackageZip({ packageZip, checkpointFile });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "merkle-inclusion-proof")?.status).toBe("fail");
  });

  it("fails when the user supplies the wrong operator key", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"));
    const operatorKeyFile = new File(
      [await readFile(path.join(root, "examples/operator-keys/wrong-operator.public-key.json"))],
      "wrong-operator.public-key.json",
      { type: "application/json" }
    );

    const report = await verifyProofPackageZip({ packageZip, operatorKeyFiles: [operatorKeyFile] });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "checkpoint-signature")?.status).toBe("fail");
  });

  it("rejects oversized uploads with a friendly limit error", async () => {
    const oversized = new File([new Uint8Array(browserVerifierLimits.maxZipBytes + 1)], "oversized.zip", { type: "application/zip" });

    await expect(verifyProofPackageZip({ packageZip: oversized })).rejects.toThrow("Package too large for browser verifier v1.");
  });

  it("reports missing required files clearly", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"), async (zip) => {
      zip.remove("capture-record.json");
      await writeJsonIntoZip(zip, "manifest.json", (manifest) => manifest);
    });

    await expect(verifyProofPackageZip({ packageZip })).rejects.toThrow("Missing required file");
  });
  it("includes lineage summary when a package carries quote lineage metadata", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"), async (zip) => {
      await addLineageBundleToZip(zip, "valid");
    });

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("verified");
    expect(report.lineage?.hasLineage).toBe(true);
    expect(report.lineage?.lineageNodeCount).toBe(3);
    expect(report.lineage?.lineageWarnings.some((warning) => warning.code === "semantic-equivalence-not-proven")).toBe(true);
  });

  it("fails when lineage metadata references a missing node", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"), async (zip) => {
      await addLineageBundleToZip(zip, "invalid-missing-node");
    });

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "proof-package-integrity")?.status).toBe("fail");
  });

  it("surfaces lineage exactness warnings without failing a valid package", async () => {
    const packageZip = await zipDirectory(path.join(root, "examples/proof-packages/valid"), async (zip) => {
      await addLineageBundleToZip(zip, "verbatim-mismatch");
    });

    const report = await verifyProofPackageZip({ packageZip });

    expect(report.status).toBe("verified");
    expect(report.lineage?.lineageWarnings.some((warning) => warning.code === "verbatim-text-mismatch")).toBe(true);
  });
});
