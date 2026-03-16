import { createHmac } from "node:crypto";

import type { TransparencyReceipt } from "@auth-layer/shared";

import { createId } from "../utils/id.js";

export interface TimestampProvider {
  issue(proofBundleHash: string): Promise<TransparencyReceipt>;
  verify(receipt: TransparencyReceipt, proofBundleHash: string): boolean;
}

export class InternalHmacTimestampProvider implements TimestampProvider {
  constructor(
    private readonly secret: string,
    private readonly provider = "internal-hmac-v1"
  ) {}

  private sign(proofBundleHash: string, receivedAt: string): string {
    return createHmac("sha256", this.secret).update(`${proofBundleHash}.${receivedAt}`).digest("hex");
  }

  async issue(proofBundleHash: string): Promise<TransparencyReceipt> {
    const receivedAt = new Date().toISOString();
    return {
      id: createId(),
      proofBundleHash,
      receivedAt,
      provider: this.provider,
      signature: this.sign(proofBundleHash, receivedAt)
    };
  }

  verify(receipt: TransparencyReceipt, proofBundleHash: string): boolean {
    return (
      receipt.proofBundleHash === proofBundleHash &&
      receipt.provider === this.provider &&
      receipt.signature === this.sign(proofBundleHash, receipt.receivedAt)
    );
  }
}
