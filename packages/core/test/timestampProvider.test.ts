import { describe, expect, it } from "vitest";

import { InternalHmacTimestampProvider } from "../src/services/timestampProvider.js";

describe("InternalHmacTimestampProvider", () => {
  it("verifies untampered receipts and rejects modified bundle hashes", async () => {
    const provider = new InternalHmacTimestampProvider("test-secret");
    const receipt = await provider.issue("sha256:bundle");

    expect(provider.verify(receipt, "sha256:bundle")).toBe(true);
    expect(provider.verify(receipt, "sha256:other")).toBe(false);
  });
});
