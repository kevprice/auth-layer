import JSZip from "jszip";
import nacl from "tweetnacl";

import {
  computeContentAttestationHash,
  hashAttestationBundle,
  hashLineageBundle,
  summarizeAttestationBundle,
  summarizeLineageBundle,
  validateLineageBundle
} from "@auth-layer/shared";
import type {
  AttestationBundle,
  AttestationVerificationSummary,
  CanonicalContent,
  CanonicalMetadata,
  LineageBundle,
  LineageSummary,
  OperatorPublicKey,
  PdfApprovalReceipt,
  ProofBundle,
  ProofPackageManifest,
  RawSnapshot,
  TransparencyCheckpoint,
  TransparencyInclusionProof,
  TransparencyLogEntry
} from "@auth-layer/shared";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 75 * 1024 * 1024;
const MAX_INDIVIDUAL_FILE_BYTES = 25 * 1024 * 1024;

export type BrowserVerifierStatus = "verified" | "partially-verified" | "failed";
export type BrowserVerifierCheckStatus = "pass" | "fail" | "incomplete";
export type BrowserVerifierTrustSource = "user-supplied" | "package-provided" | "missing";

export type BrowserVerifierCheck = {
  id: "proof-package-integrity" | "merkle-inclusion-proof" | "checkpoint-signature" | "pdf-approval-receipt";
  label: string;
  status: BrowserVerifierCheckStatus;
  details: string;
};

export type BrowserVerifierTrustBasis = {
  checkpointSource: BrowserVerifierTrustSource;
  operatorKeySource: BrowserVerifierTrustSource;
  independentTrustRootSuppliedByUser: boolean;
  operatorKeyFingerprints: string[];
  operatorKeyIds: string[];
  checkpointId?: string;
  proofBundleHash?: string;
};

export type BrowserVerificationReport = {
  status: BrowserVerifierStatus;
  summary: string;
  trustBasisSummary: string;
  trustBasis: BrowserVerifierTrustBasis;
  checks: BrowserVerifierCheck[];
  packageInfo: {
    captureId?: string;
    artifactType?: string;
    packageType?: string;
    proofBundleHash?: string;
    fileCount: number;
  };
  appendix: {
    fileReferences: string[];
    selectedCheckpointId?: string;
    selectedCheckpointHash?: string;
    selectedCheckpointRootHash?: string;
    selectedCheckpointSource: BrowserVerifierTrustSource;
    selectedOperatorKeySource: BrowserVerifierTrustSource;
    transparencyLogEntryHash?: string;
    inclusionProof?: Pick<TransparencyInclusionProof, "mode" | "treeSize" | "leafIndex" | "rootHash" | "checkpointId">;
    approvalReceipt?: {
      id: string;
      approvalScope: string;
      approvalMethod: string;
      actorAccountId: string;
      issuerOperatorId: string;
      issuerKeyId: string;
    };
  };
  issues: string[];
  articleSummary?: {
    title?: string;
    publisher?: string;
    canonicalUrl?: string;
    publishedAt?: string;
    updatedAt?: string;
  };
  attestations?: AttestationVerificationSummary;
  lineage?: LineageSummary & {
    nodes?: LineageBundle["contentObjects"];
    edges?: LineageBundle["edges"];
  };
  generatedAt: string;
};

export type VerifyProofPackageZipInput = {
  packageZip: File;
  checkpointFile?: File;
  operatorKeyFiles?: File[];
};

type PackageFiles = Map<string, Uint8Array>;

type VerificationContext = {
  manifest: ProofPackageManifest;
  captureRecord: {
    id: string;
    rawSnapshotHash?: string;
    canonicalContentHash?: string;
    metadataHash?: string;
    proofBundleHash?: string;
  };
  rawSnapshot?: RawSnapshot;
  rawHtml?: string;
  rawPdf?: Uint8Array;
  rawImage?: Uint8Array;
  screenshot?: Uint8Array;
  canonicalContent?: CanonicalContent;
  metadata?: CanonicalMetadata;
  proofBundle?: ProofBundle;
  approvalReceipt?: PdfApprovalReceipt;
  attestationBundle?: AttestationBundle;
  transparencyLogEntry?: TransparencyLogEntry;
  packageCheckpoint?: TransparencyCheckpoint;
  inclusionProof?: TransparencyInclusionProof;
  packageOperatorKey?: OperatorPublicKey;
  lineageBundle?: LineageBundle;
  allFileNames: string[];
};

const CHECK_LABELS: Record<BrowserVerifierCheck["id"], string> = {
  "proof-package-integrity": "Proof package integrity",
  "merkle-inclusion-proof": "Merkle inclusion proof",
  "checkpoint-signature": "Checkpoint signature",
  "pdf-approval-receipt": "Optional PDF approval receipt"
};

const normalizeLineEndings = (value: string): string => value.replace(/\r\n?/g, "\n");

const normalizeString = (value: string): string =>
  normalizeLineEndings(value)
    .normalize("NFC")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortKeys(nestedValue)])
    );
  }

  return value;
};

const normalizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return normalizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeValue(nestedValue)])
    );
  }

  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(sortKeys(value));

const hashBytes = async (value: Uint8Array): Promise<string> => {
  const buffer = new Uint8Array(value.byteLength);
  buffer.set(value);
  const digest = await crypto.subtle.digest("SHA-256", buffer as BufferSource);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const hashString = async (value: string): Promise<string> => hashBytes(textEncoder.encode(value));
const hashStableValue = async (value: unknown): Promise<string> => hashString(stableStringify(value));

const toUint8Array = (value: string): Uint8Array => textEncoder.encode(value);

const decodeHexHash = (value: string): Uint8Array => {
  const hex = value.replace(/^sha256:/, "");
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid SHA-256 hash: ${value}`);
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const next = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    next.set(part, offset);
    offset += part.length;
  }
  return next;
};

const hashMerkleLeaf = async (entryHash: string): Promise<string> =>
  hashBytes(concatBytes(new Uint8Array([0]), decodeHexHash(entryHash)));

const hashMerkleNode = async (leftHash: string, rightHash: string): Promise<string> =>
  hashBytes(concatBytes(new Uint8Array([1]), decodeHexHash(leftHash), decodeHexHash(rightHash)));

const verifyMerkleInclusionProof = async (proof: TransparencyInclusionProof): Promise<boolean> => {
  if (proof.mode !== "merkle-v1") {
    return false;
  }

  let currentHash = proof.leafHash;
  for (const step of proof.steps) {
    currentHash = step.direction === "left"
      ? await hashMerkleNode(step.hash, currentHash)
      : await hashMerkleNode(currentHash, step.hash);
  }

  return currentHash === proof.rootHash;
};

const readJsonBytes = <T>(value: Uint8Array, label: string): T => {
  try {
    return JSON.parse(textDecoder.decode(value)) as T;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
};

const readText = (value: Uint8Array): string => textDecoder.decode(value);

const sanitizeZipPath = (value: string): string => value.replace(/\\/g, "/").replace(/^\.?\//, "");

const stripCommonRootPrefix = (paths: string[]): string[] => {
  const segments = paths.map((value) => sanitizeZipPath(value).split("/").filter(Boolean));
  if (!segments.length) {
    return [];
  }

  const firstPrefix = segments[0]?.[0];
  if (!firstPrefix) {
    return paths.map(sanitizeZipPath);
  }

  const shouldStrip = segments.every((parts) => parts.length > 1 && parts[0] === firstPrefix);
  if (!shouldStrip) {
    return paths.map(sanitizeZipPath);
  }

  return segments.map((parts) => parts.slice(1).join("/"));
};

const loadZipFiles = async (file: File): Promise<PackageFiles> => {
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error("Package too large for browser verifier v1.");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("Unsupported proof-package layout.");
  }

  const sourceFiles = Object.values(zip.files).filter((entry) => !entry.dir);
  const normalizedNames = stripCommonRootPrefix(sourceFiles.map((entry) => entry.name));
  const packageFiles: PackageFiles = new Map();
  let totalBytes = 0;

  for (let index = 0; index < sourceFiles.length; index += 1) {
    const entry = sourceFiles[index];
    if (!entry) {
      continue;
    }
    const normalizedPath = normalizedNames[index] ?? sanitizeZipPath(entry.name);
    if (!normalizedPath || normalizedPath.startsWith("/") || normalizedPath.split("/").includes("..")) {
      throw new Error("Unsupported proof-package layout.");
    }

    const bytes = new Uint8Array(await entry.async("uint8array"));
    if (bytes.length > MAX_INDIVIDUAL_FILE_BYTES) {
      throw new Error("Package too large for browser verifier v1.");
    }

    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_EXTRACTED_BYTES) {
      throw new Error("Archive expands beyond browser verifier limits.");
    }

    packageFiles.set(normalizedPath, bytes);
  }

  return packageFiles;
};

const getRequiredFile = (files: PackageFiles, path: string, label: string): Uint8Array => {
  const file = files.get(path);
  if (!file) {
    throw new Error(`Missing required file: ${label} (${path}).`);
  }
  return file;
};

const getOptionalFile = (files: PackageFiles, path?: string, optional?: boolean): Uint8Array | undefined => {
  if (!path) {
    return undefined;
  }
  const value = files.get(path);
  if (!value && !optional) {
    throw new Error(`Missing required file: ${path}.`);
  }
  return value;
};

const buildContext = (files: PackageFiles): VerificationContext => {
  const manifest = readJsonBytes<ProofPackageManifest>(getRequiredFile(files, "manifest.json", "manifest"), "manifest.json");
  const captureRecord = readJsonBytes<VerificationContext["captureRecord"]>(
    getRequiredFile(files, manifest.files.captureRecord.path, "capture-record.json"),
    manifest.files.captureRecord.path
  );

  const rawSnapshotBytes = getOptionalFile(files, manifest.files.rawSnapshot.path, manifest.files.rawSnapshot.optional);
  const rawHtmlBytes = getOptionalFile(files, manifest.files.rawHtml.path, manifest.files.rawHtml.optional);
  const rawPdfBytes = getOptionalFile(files, manifest.files.rawPdf?.path, manifest.files.rawPdf?.optional);
  const screenshotBytes = getOptionalFile(files, manifest.files.screenshot?.path, manifest.files.screenshot?.optional);
  const canonicalContentBytes = getOptionalFile(files, manifest.files.canonicalContent.path, manifest.files.canonicalContent.optional);
  const metadataBytes = getOptionalFile(files, manifest.files.metadata.path, manifest.files.metadata.optional);
  const proofBundleBytes = getOptionalFile(files, manifest.files.proofBundle.path, manifest.files.proofBundle.optional);
  const lineageBundleBytes = manifest.files.lineageBundle?.path ? files.get(manifest.files.lineageBundle.path) : undefined;
  const approvalReceiptBytes = getOptionalFile(files, manifest.files.approvalReceipt?.path, manifest.files.approvalReceipt?.optional);
  const attestationBundleBytes = getOptionalFile(files, manifest.files.attestationBundle?.path, manifest.files.attestationBundle?.optional);
  const transparencyLogEntryBytes = getOptionalFile(files, manifest.files.transparencyLogEntry.path, manifest.files.transparencyLogEntry.optional);
  const transparencyCheckpointBytes = manifest.files.transparencyCheckpoint?.path ? files.get(manifest.files.transparencyCheckpoint.path) : undefined;
  const inclusionProofBytes = manifest.files.transparencyInclusionProof?.path ? files.get(manifest.files.transparencyInclusionProof.path) : undefined;
  const operatorPublicKeyBytes = manifest.files.operatorPublicKey?.path ? files.get(manifest.files.operatorPublicKey.path) : undefined;

  return {
    manifest,
    captureRecord,
    rawSnapshot: rawSnapshotBytes ? readJsonBytes<RawSnapshot>(rawSnapshotBytes, manifest.files.rawSnapshot.path) : undefined,
    rawHtml: rawHtmlBytes ? readText(rawHtmlBytes) : undefined,
    rawPdf: rawPdfBytes,
    rawImage: getOptionalFile(files, manifest.files.rawImage?.path, manifest.files.rawImage?.optional),
    screenshot: screenshotBytes,
    canonicalContent: canonicalContentBytes ? readJsonBytes<CanonicalContent>(canonicalContentBytes, manifest.files.canonicalContent.path) : undefined,
    metadata: metadataBytes ? readJsonBytes<CanonicalMetadata>(metadataBytes, manifest.files.metadata.path) : undefined,
    proofBundle: proofBundleBytes ? readJsonBytes<ProofBundle>(proofBundleBytes, manifest.files.proofBundle.path) : undefined,
    lineageBundle: lineageBundleBytes ? readJsonBytes<LineageBundle>(lineageBundleBytes, manifest.files.lineageBundle?.path ?? "lineage.json") : undefined,
    approvalReceipt: approvalReceiptBytes ? readJsonBytes<PdfApprovalReceipt>(approvalReceiptBytes, manifest.files.approvalReceipt?.path ?? "approval-receipt.json") : undefined,
    attestationBundle: attestationBundleBytes ? readJsonBytes<AttestationBundle>(attestationBundleBytes, manifest.files.attestationBundle?.path ?? "attestations.json") : undefined,
    transparencyLogEntry: transparencyLogEntryBytes
      ? readJsonBytes<TransparencyLogEntry>(transparencyLogEntryBytes, manifest.files.transparencyLogEntry.path)
      : undefined,
    packageCheckpoint: transparencyCheckpointBytes
      ? readJsonBytes<TransparencyCheckpoint>(transparencyCheckpointBytes, manifest.files.transparencyCheckpoint.path)
      : undefined,
    inclusionProof: inclusionProofBytes
      ? readJsonBytes<TransparencyInclusionProof>(inclusionProofBytes, manifest.files.transparencyInclusionProof.path)
      : undefined,
    packageOperatorKey: operatorPublicKeyBytes
      ? readJsonBytes<OperatorPublicKey>(operatorPublicKeyBytes, manifest.files.operatorPublicKey.path)
      : undefined,
    allFileNames: Array.from(files.keys()).sort((left, right) => left.localeCompare(right))
  };
};

const unsignedCheckpointPayload = (checkpoint: Omit<TransparencyCheckpoint, "signature" | "checkpointHash">) => ({
  schemaVersion: checkpoint.schemaVersion,
  checkpointId: checkpoint.checkpointId,
  treeSize: checkpoint.treeSize,
  lastLogIndex: checkpoint.lastLogIndex,
  lastEntryHash: checkpoint.lastEntryHash,
  rootHash: checkpoint.rootHash,
  issuedAt: checkpoint.issuedAt,
  operatorId: checkpoint.operatorId,
  operatorKeyId: checkpoint.operatorKeyId,
  operatorPublicKeySha256: checkpoint.operatorPublicKeySha256,
  signatureAlgorithm: checkpoint.signatureAlgorithm,
  logMode: checkpoint.logMode ?? "legacy-hash-chain",
  previousCheckpointId: checkpoint.previousCheckpointId ?? null,
  previousCheckpointHash: checkpoint.previousCheckpointHash ?? null
});

const computeTransparencyCheckpointHash = async (checkpoint: Omit<TransparencyCheckpoint, "signature" | "checkpointHash">): Promise<string> =>
  hashStableValue(unsignedCheckpointPayload(checkpoint));

const unsignedApprovalPayload = (receipt: Omit<PdfApprovalReceipt, "signature">) => ({
  schemaVersion: receipt.schemaVersion,
  receiptType: receipt.receiptType,
  id: receipt.id,
  captureId: receipt.captureId,
  actorAccountId: receipt.actorAccountId,
  approvalType: receipt.approvalType,
  approvalScope: receipt.approvalScope,
  approvalMethod: receipt.approvalMethod,
  rawPdfHash: receipt.rawPdfHash,
  approvedAt: receipt.approvedAt,
  issuerOperatorId: receipt.issuerOperatorId,
  issuerKeyId: receipt.issuerKeyId,
  issuerPublicKeySha256: receipt.issuerPublicKeySha256,
  signatureAlgorithm: receipt.signatureAlgorithm
});

const computePdfApprovalReceiptHash = async (receipt: Omit<PdfApprovalReceipt, "signature">): Promise<string> =>
  hashStableValue(unsignedApprovalPayload(receipt));

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const pemToEd25519PublicKey = (pem: string): Uint8Array => {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const bytes = decodeBase64(base64);
  const prefix = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
  if (bytes.length !== prefix.length + 32) {
    throw new Error("Unsupported operator public key format.");
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) {
      throw new Error("Unsupported operator public key format.");
    }
  }
  return bytes.slice(prefix.length);
};

const matchesTrustedKey = (
  checkpointOrReceipt: {
    operatorId?: string;
    operatorKeyId?: string;
    operatorPublicKeySha256?: string;
    signatureAlgorithm?: string;
    issuerOperatorId?: string;
    issuerKeyId?: string;
    issuerPublicKeySha256?: string;
  },
  key: OperatorPublicKey
): boolean => {
  const operatorId = checkpointOrReceipt.operatorId ?? checkpointOrReceipt.issuerOperatorId;
  const keyId = checkpointOrReceipt.operatorKeyId ?? checkpointOrReceipt.issuerKeyId;
  const fingerprint = checkpointOrReceipt.operatorPublicKeySha256 ?? checkpointOrReceipt.issuerPublicKeySha256;
  return key.operatorId === operatorId &&
    key.keyId === keyId &&
    key.algorithm === (checkpointOrReceipt.signatureAlgorithm ?? "ed25519") &&
    key.publicKeySha256 === fingerprint;
};

const verifyTransparencyCheckpointSignature = async (
  checkpoint: TransparencyCheckpoint,
  trustedOperatorKeys: OperatorPublicKey[]
): Promise<boolean> => {
  const matchingKey = trustedOperatorKeys.find((key) => matchesTrustedKey(checkpoint, key));
  if (!matchingKey) {
    return false;
  }

  const { signature, checkpointHash, ...unsigned } = checkpoint;
  const expectedHash = await computeTransparencyCheckpointHash(unsigned);
  if (checkpointHash !== expectedHash) {
    return false;
  }

  return nacl.sign.detached.verify(
    toUint8Array(checkpointHash),
    decodeBase64(signature),
    pemToEd25519PublicKey(matchingKey.publicKeyPem)
  );
};

const verifyPdfApprovalReceiptSignature = async (
  receipt: PdfApprovalReceipt,
  trustedOperatorKeys: OperatorPublicKey[]
): Promise<boolean> => {
  const matchingKey = trustedOperatorKeys.find((key) => matchesTrustedKey(receipt, key));
  if (!matchingKey) {
    return false;
  }

  const { signature, ...unsigned } = receipt;
  const receiptHash = await computePdfApprovalReceiptHash(unsigned);
  return nacl.sign.detached.verify(
    toUint8Array(receiptHash),
    decodeBase64(signature),
    pemToEd25519PublicKey(matchingKey.publicKeyPem)
  );
};

const verifyContentAttestationSignature = async (
  attestation: AttestationBundle["attestations"][number],
  trustedOperatorKeys: OperatorPublicKey[]
): Promise<boolean> => {
  const matchingKey = trustedOperatorKeys.find((key) => matchesTrustedKey(attestation, key));
  if (!matchingKey) {
    return false;
  }

  const { signature, attestationHash, ...unsigned } = attestation;
  const recomputedHash = await computeContentAttestationHash(unsigned);
  if (recomputedHash !== attestationHash) {
    return false;
  }

  return nacl.sign.detached.verify(
    toUint8Array(attestationHash),
    decodeBase64(signature),
    pemToEd25519PublicKey(matchingKey.publicKeyPem)
  );
};

const buildCheck = (
  id: BrowserVerifierCheck["id"],
  status: BrowserVerifierCheckStatus,
  details: string
): BrowserVerifierCheck => ({
  id,
  label: CHECK_LABELS[id],
  status,
  details
});

const selectedTrustMaterial = async (
  input: VerifyProofPackageZipInput,
  context: VerificationContext
): Promise<{
  checkpoint?: TransparencyCheckpoint;
  checkpointSource: BrowserVerifierTrustSource;
  trustedOperatorKeys: OperatorPublicKey[];
  operatorKeySource: BrowserVerifierTrustSource;
}> => {
  const checkpoint = input.checkpointFile
    ? readJsonBytes<TransparencyCheckpoint>(new Uint8Array(await input.checkpointFile.arrayBuffer()), input.checkpointFile.name)
    : context.packageCheckpoint;
  const checkpointSource: BrowserVerifierTrustSource = input.checkpointFile
    ? "user-supplied"
    : context.packageCheckpoint
      ? "package-provided"
      : "missing";

  const operatorKeys = input.operatorKeyFiles?.length
    ? await Promise.all(
        input.operatorKeyFiles.map(async (file) =>
          readJsonBytes<OperatorPublicKey>(new Uint8Array(await file.arrayBuffer()), file.name)
        )
      )
    : context.packageOperatorKey
      ? [context.packageOperatorKey]
      : [];
  const operatorKeySource: BrowserVerifierTrustSource = input.operatorKeyFiles?.length
    ? "user-supplied"
    : context.packageOperatorKey
      ? "package-provided"
      : "missing";

  return {
    checkpoint,
    checkpointSource,
    trustedOperatorKeys: operatorKeys,
    operatorKeySource
  };
};

const recomputeProofPackageIntegrity = async (context: VerificationContext): Promise<{ ok: boolean; issues: string[] }> => {
  const issues: string[] = [];

  if (context.manifest.captureId !== context.captureRecord.id) {
    issues.push("Manifest capture ID does not match capture-record.json.");
  }

  if (context.rawSnapshot && context.rawHtml !== undefined) {
    const rawSnapshotHash = await hashStableValue({ ...context.rawSnapshot, rawHtml: context.rawHtml });
    if (rawSnapshotHash !== context.manifest.rawSnapshotHash || rawSnapshotHash !== context.captureRecord.rawSnapshotHash) {
      issues.push("Raw snapshot hash does not match the manifest or capture record.");
    }
  }

  if (context.rawPdf) {
    const rawPdfHash = await hashBytes(context.rawPdf);
    if (rawPdfHash !== context.manifest.rawSnapshotHash || rawPdfHash !== context.captureRecord.rawSnapshotHash) {
      issues.push("Source PDF hash does not match the manifest or capture record.");
    }
  }

  if (context.screenshot && context.proofBundle?.screenshotHash) {
    const screenshotHash = await hashBytes(context.screenshot);
    if (screenshotHash !== context.proofBundle.screenshotHash) {
      issues.push("Screenshot hash does not match proof-bundle.json.");
    }
  }

  if (context.canonicalContent) {
    const canonicalHash = await hashStableValue(normalizeValue(context.canonicalContent));
    if (canonicalHash !== context.manifest.canonicalContentHash || canonicalHash !== context.captureRecord.canonicalContentHash) {
      issues.push("Canonical content hash does not match the manifest or capture record.");
    }
  }

  if (context.metadata) {
    const metadataHash = await hashStableValue(normalizeValue(context.metadata));
    if (metadataHash !== context.manifest.metadataHash || metadataHash !== context.captureRecord.metadataHash) {
      issues.push("Metadata hash does not match the manifest or capture record.");
    }
  }

  if (context.lineageBundle) {
    const lineageBundleHash = await hashLineageBundle(context.lineageBundle);
    if (lineageBundleHash !== context.manifest.lineageBundleHash) {
      issues.push("Lineage bundle hash does not match the manifest.");
    }
    const lineageValidation = validateLineageBundle(context.lineageBundle);
    if (!lineageValidation.ok) {
      issues.push(...lineageValidation.errors.map((warning) => warning.message));
    }
  }

  if (context.proofBundle) {
    const proofBundleHash = await hashStableValue(context.proofBundle);
    if (proofBundleHash !== context.manifest.proofBundleHash || proofBundleHash !== context.captureRecord.proofBundleHash) {
      issues.push("Proof bundle hash does not match the manifest or capture record.");
    }
  }

  if (context.approvalReceipt) {
    if (!context.approvalReceipt.approvalScope || !context.approvalReceipt.approvalMethod) {
      issues.push("Approval receipt is missing approval scope or approval method.");
    }
    if (context.rawPdf) {
      const rawPdfHash = await hashBytes(context.rawPdf);
      if (context.approvalReceipt.rawPdfHash !== rawPdfHash) {
        issues.push("Approval receipt does not reference the same PDF file hash.");
      }
    }
  }

  if (context.transparencyLogEntry) {
    const entryHash = await hashStableValue({
      schemaVersion: context.transparencyLogEntry.schemaVersion,
      logIndex: context.transparencyLogEntry.logIndex,
      captureId: context.transparencyLogEntry.captureId,
      proofBundleHash: context.transparencyLogEntry.proofBundleHash,
      previousEntryHash: context.transparencyLogEntry.previousEntryHash ?? null,
      createdAt: context.transparencyLogEntry.createdAt
    });
    if (entryHash !== context.transparencyLogEntry.entryHash) {
      issues.push("Transparency log entry hash is not reproducible.");
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
};

const summarizeTrustBasis = (trustBasis: BrowserVerifierTrustBasis, status: BrowserVerifierStatus): string => {
  if (status === "verified") {
    return trustBasis.independentTrustRootSuppliedByUser
      ? "Verification succeeded using user-supplied trust material."
      : "Verification succeeded using package-provided checkpoint and operator key material.";
  }

  if (status === "partially-verified") {
    return "Integrity checks passed, but full transparency verification could not complete with the available trust material.";
  }

  return "Verification failed because one or more required checks did not validate.";
};

const summarizeStatus = (status: BrowserVerifierStatus, integrityIssues: string[]): string => {
  if (status === "verified") {
    return "The exported package and full transparency chain verified successfully.";
  }

  if (status === "partially-verified") {
    return "The package integrity checks passed, but the full transparency trust chain could not be established.";
  }

  return integrityIssues[0] ?? "One or more required verification checks failed.";
};

export const verifyProofPackageZip = async (input: VerifyProofPackageZipInput): Promise<BrowserVerificationReport> => {
  const packageFiles = await loadZipFiles(input.packageZip);
  const context = buildContext(packageFiles);
  const selected = await selectedTrustMaterial(input, context);
  const checks: BrowserVerifierCheck[] = [];
  const issues: string[] = [];

  const integrity = await recomputeProofPackageIntegrity(context);
  if (!integrity.ok) {
    issues.push(...integrity.issues);
  }
  checks.push(
    buildCheck(
      "proof-package-integrity",
      integrity.ok ? "pass" : "fail",
      integrity.ok ? "All required package artifacts recomputed cleanly." : integrity.issues[0] ?? "Package integrity checks failed."
    )
  );

  let merkleStatus: BrowserVerifierCheckStatus = "incomplete";
  let merkleDetails = "No checkpoint was available to verify Merkle inclusion.";
  if (selected.checkpoint && context.transparencyLogEntry && context.inclusionProof) {
    const proof = context.inclusionProof;
    const checkpoint = selected.checkpoint;

    if ((checkpoint.logMode ?? "legacy-hash-chain") === "merkle-tree-v1") {
      const leafHashMatches = proof.leafHash === await hashMerkleLeaf(context.transparencyLogEntry.entryHash);
      const rootMatches = proof.rootHash === checkpoint.rootHash && proof.treeSize === checkpoint.treeSize;
      const checkpointMatches = proof.checkpointId === checkpoint.checkpointId;
      const entryMatches = proof.logEntryHash === context.transparencyLogEntry.entryHash;
      const proofValid = await verifyMerkleInclusionProof(proof);
      const ok = leafHashMatches && rootMatches && checkpointMatches && entryMatches && proofValid;
      merkleStatus = ok ? "pass" : "fail";
      merkleDetails = ok
        ? "Merkle inclusion proof matches the selected checkpoint root."
        : "Merkle inclusion proof does not match the selected checkpoint or transparency log entry.";
      if (!ok) {
        issues.push(merkleDetails);
      }
    } else {
      const ok = checkpoint.lastLogIndex === context.transparencyLogEntry.logIndex &&
        checkpoint.lastEntryHash === context.transparencyLogEntry.entryHash &&
        checkpoint.rootHash === context.transparencyLogEntry.entryHash;
      merkleStatus = ok ? "pass" : "fail";
      merkleDetails = ok
        ? "Legacy exact-entry checkpoint matches the included log entry."
        : "Legacy exact-entry checkpoint does not match the included log entry.";
      if (!ok) {
        issues.push(merkleDetails);
      }
    }
  } else if (selected.checkpoint && !context.inclusionProof && (selected.checkpoint.logMode ?? "legacy-hash-chain") === "merkle-tree-v1") {
    merkleStatus = "incomplete";
    merkleDetails = "Merkle checkpoint selected, but the package did not include an inclusion proof.";
  } else if (!selected.checkpoint) {
    merkleStatus = "incomplete";
    merkleDetails = "No checkpoint was supplied or included in the package.";
  }
  checks.push(buildCheck("merkle-inclusion-proof", merkleStatus, merkleDetails));

  let checkpointStatus: BrowserVerifierCheckStatus = "incomplete";
  let checkpointDetails = "No trusted operator key material was available for checkpoint signature verification.";
  if (selected.checkpoint && selected.trustedOperatorKeys.length > 0) {
    const ok = await verifyTransparencyCheckpointSignature(selected.checkpoint, selected.trustedOperatorKeys);
    checkpointStatus = ok ? "pass" : "fail";
    checkpointDetails = ok
      ? "Checkpoint signature validates against the selected trusted operator key material."
      : "Checkpoint signature does not validate against the selected trusted operator key material.";
    if (!ok) {
      issues.push(checkpointDetails);
    }
  } else if (!selected.checkpoint) {
    checkpointDetails = "No checkpoint was available for signature verification.";
  }
  checks.push(buildCheck("checkpoint-signature", checkpointStatus, checkpointDetails));

  let approvalStatus: BrowserVerifierCheckStatus = "incomplete";
  let approvalDetails = "No approval receipt was included in the package.";
  if (context.approvalReceipt) {
    if (selected.trustedOperatorKeys.length > 0) {
      const ok = await verifyPdfApprovalReceiptSignature(context.approvalReceipt, selected.trustedOperatorKeys);
      approvalStatus = ok ? "pass" : "fail";
      approvalDetails = ok
        ? "Approval receipt validates against the selected trusted operator key material."
        : "Approval receipt does not validate against the selected trusted operator key material.";
      if (!ok) {
        issues.push(approvalDetails);
      }
    } else {
      approvalStatus = "incomplete";
      approvalDetails = "Approval receipt is present, but no trusted operator key material was available to verify it.";
    }
  }
  checks.push(buildCheck("pdf-approval-receipt", approvalStatus, approvalDetails));

  const fullTrustChainAvailable = integrity.ok &&
    merkleStatus === "pass" &&
    checkpointStatus === "pass";
  const anyFailure = checks.some((check) => check.status === "fail");
  const status: BrowserVerifierStatus = anyFailure
    ? "failed"
    : fullTrustChainAvailable
      ? "verified"
      : "partially-verified";

  const lineageSummary = summarizeLineageBundle(context.lineageBundle);
  const attestationSummary = summarizeAttestationBundle(context.attestationBundle);
  const attestationVerification = context.attestationBundle
    ? await Promise.all(
        context.attestationBundle.attestations.map(async (attestation: AttestationBundle["attestations"][number]) => {
          const { signature, attestationHash, ...unsigned } = attestation;
          const hashMatches = (await computeContentAttestationHash(unsigned)) === attestationHash;
          const signatureValid = selected.trustedOperatorKeys.length ? await verifyContentAttestationSignature(attestation, selected.trustedOperatorKeys) : false;
          return { hashMatches, signatureValid };
        })
      )
    : [];

  const articleObject = context.canonicalContent?.articleObject ?? context.metadata?.articleObject;
  const verifiedCount = attestationVerification.filter((result) => result.hashMatches && result.signatureValid).length;
  const invalidCount = attestationVerification.filter((result) => !result.hashMatches || (selected.trustedOperatorKeys.length > 0 && !result.signatureValid)).length;
  const unverifiedCount = attestationVerification.length - verifiedCount - invalidCount;

  const trustBasis: BrowserVerifierTrustBasis = {
    checkpointSource: selected.checkpointSource,
    operatorKeySource: selected.operatorKeySource,
    independentTrustRootSuppliedByUser: selected.checkpointSource === "user-supplied" || selected.operatorKeySource === "user-supplied",
    operatorKeyFingerprints: selected.trustedOperatorKeys.map((key) => key.publicKeySha256),
    operatorKeyIds: selected.trustedOperatorKeys.map((key) => key.keyId),
    checkpointId: selected.checkpoint?.checkpointId,
    proofBundleHash: context.manifest.proofBundleHash
  };

  return {
    status,
    summary: summarizeStatus(status, issues),
    trustBasisSummary: summarizeTrustBasis(trustBasis, status),
    trustBasis,
    checks,
    packageInfo: {
      captureId: context.manifest.captureId,
      artifactType: context.manifest.artifactType,
      packageType: context.manifest.packageType,
      proofBundleHash: context.manifest.proofBundleHash,
      fileCount: context.allFileNames.length
    },
    appendix: {
      fileReferences: context.allFileNames,
      selectedCheckpointId: selected.checkpoint?.checkpointId,
      selectedCheckpointHash: selected.checkpoint?.checkpointHash,
      selectedCheckpointRootHash: selected.checkpoint?.rootHash,
      selectedCheckpointSource: selected.checkpointSource,
      selectedOperatorKeySource: selected.operatorKeySource,
      transparencyLogEntryHash: context.transparencyLogEntry?.entryHash,
      inclusionProof: context.inclusionProof
        ? {
            mode: context.inclusionProof.mode,
            treeSize: context.inclusionProof.treeSize,
            leafIndex: context.inclusionProof.leafIndex,
            rootHash: context.inclusionProof.rootHash,
            checkpointId: context.inclusionProof.checkpointId
          }
        : undefined,
      approvalReceipt: context.approvalReceipt
        ? {
            id: context.approvalReceipt.id,
            approvalScope: context.approvalReceipt.approvalScope,
            approvalMethod: context.approvalReceipt.approvalMethod,
            actorAccountId: context.approvalReceipt.actorAccountId,
            issuerOperatorId: context.approvalReceipt.issuerOperatorId,
            issuerKeyId: context.approvalReceipt.issuerKeyId
          }
        : undefined
    },
    issues,
    articleSummary: articleObject ? {
      title: context.metadata?.title ?? context.canonicalContent?.title,
      publisher: articleObject.siteIdentifier,
      canonicalUrl: articleObject.canonicalUrl,
      publishedAt: articleObject.publishedAt ?? context.metadata?.publishedAtClaimed,
      updatedAt: articleObject.updatedAt
    } : undefined,
    attestations: attestationSummary.hasAttestations
      ? {
          ...attestationSummary,
          verifiedCount,
          invalidCount,
          unverifiedCount,
          trustedKeyMaterialAvailable: selected.trustedOperatorKeys.length > 0
        }
      : undefined,
    lineage: lineageSummary.hasLineage
      ? {
          ...lineageSummary,
          nodes: context.lineageBundle?.contentObjects,
          edges: context.lineageBundle?.edges
        }
      : undefined,
    generatedAt: new Date().toISOString()
  };
};

export const browserVerifierLimits = {
  maxZipBytes: MAX_ZIP_BYTES,
  maxExtractedBytes: MAX_TOTAL_EXTRACTED_BYTES,
  maxIndividualFileBytes: MAX_INDIVIDUAL_FILE_BYTES
};
















