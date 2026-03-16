import { createHash, createPrivateKey, createPublicKey, sign as signDetached, verify as verifyDetached, type KeyObject } from "node:crypto";

import type { OperatorPublicKey, PdfApprovalMethod, PdfApprovalReceipt, PdfApprovalScope } from "@auth-layer/shared";

import { createId } from "../utils/id.js";
import { hashStableValue } from "../utils/stableJson.js";

const normalizePem = (pem: string): string => `${pem.trim()}\n`;
const sha256Hex = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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

export const computePdfApprovalReceiptHash = (receipt: Omit<PdfApprovalReceipt, "signature">): string =>
  hashStableValue(unsignedApprovalPayload(receipt));

export const verifyPdfApprovalReceiptSignature = (
  receipt: PdfApprovalReceipt,
  trustedKeys: OperatorPublicKey[]
): boolean => {
  const matchingKey = trustedKeys.find(
    (key) =>
      key.operatorId === receipt.issuerOperatorId &&
      key.keyId === receipt.issuerKeyId &&
      key.algorithm === receipt.signatureAlgorithm &&
      key.publicKeySha256 === receipt.issuerPublicKeySha256
  );

  if (!matchingKey) {
    return false;
  }

  const { signature, ...unsigned } = receipt;
  const receiptHash = computePdfApprovalReceiptHash(unsigned);
  return verifyDetached(
    null,
    Buffer.from(receiptHash, "utf8"),
    createPublicKey(matchingKey.publicKeyPem),
    Buffer.from(signature, "base64")
  );
};

export class Ed25519PdfApprovalSigner {
  private readonly privateKey: KeyObject;
  private readonly operatorPublicKey: OperatorPublicKey;

  constructor(input: {
    privateKeyPem: string;
    publicKeyPem?: string;
    operatorId: string;
    keyId: string;
    createdAt?: string;
  }) {
    this.privateKey = createPrivateKey(normalizePem(input.privateKeyPem));
    const publicKeyPem = input.publicKeyPem
      ? normalizePem(input.publicKeyPem)
      : createPublicKey(this.privateKey).export({ type: "spki", format: "pem" }).toString();

    this.operatorPublicKey = {
      schemaVersion: 1,
      operatorId: input.operatorId,
      keyId: input.keyId,
      algorithm: "ed25519",
      publicKeyPem,
      publicKeySha256: sha256Hex(publicKeyPem),
      createdAt: input.createdAt ?? new Date().toISOString()
    };
  }

  getPublicKey(): OperatorPublicKey {
    return { ...this.operatorPublicKey };
  }

  issue(input: {
    captureId: string;
    actorAccountId: string;
    approvalType: string;
    approvalScope: PdfApprovalScope;
    approvalMethod: PdfApprovalMethod;
    rawPdfHash: string;
    approvedAt?: string;
  }): PdfApprovalReceipt {
    const unsigned: Omit<PdfApprovalReceipt, "signature"> = {
      schemaVersion: 1,
      receiptType: "pdf-upload-approval",
      id: createId(),
      captureId: input.captureId,
      actorAccountId: input.actorAccountId,
      approvalType: input.approvalType,
      approvalScope: input.approvalScope,
      approvalMethod: input.approvalMethod,
      rawPdfHash: input.rawPdfHash,
      approvedAt: input.approvedAt ?? new Date().toISOString(),
      issuerOperatorId: this.operatorPublicKey.operatorId,
      issuerKeyId: this.operatorPublicKey.keyId,
      issuerPublicKeySha256: this.operatorPublicKey.publicKeySha256,
      signatureAlgorithm: this.operatorPublicKey.algorithm
    };

    const receiptHash = computePdfApprovalReceiptHash(unsigned);
    return {
      ...unsigned,
      signature: signDetached(null, Buffer.from(receiptHash, "utf8"), this.privateKey).toString("base64")
    };
  }

  verify(receipt: PdfApprovalReceipt): boolean {
    return verifyPdfApprovalReceiptSignature(receipt, [this.operatorPublicKey]);
  }
}

export class PdfApprovalService {
  constructor(private readonly signer: Ed25519PdfApprovalSigner) {}

  getOperatorPublicKey(): OperatorPublicKey {
    return this.signer.getPublicKey();
  }

  issue(input: {
    captureId: string;
    actorAccountId: string;
    approvalType: string;
    approvalScope: PdfApprovalScope;
    approvalMethod: PdfApprovalMethod;
    rawPdfHash: string;
  }): PdfApprovalReceipt {
    return this.signer.issue(input);
  }

  verify(receipt: PdfApprovalReceipt, trustedKeys?: OperatorPublicKey[]): boolean {
    return trustedKeys ? verifyPdfApprovalReceiptSignature(receipt, trustedKeys) : this.signer.verify(receipt);
  }
}
