import { afterEach, describe, expect, it } from "vitest";

import { requireDatabaseUrl, resolveEmbeddedWorkerEnabled } from "../src/runtime.js";

const originalEmbeddedWorker = process.env.EMBEDDED_WORKER;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalEmbeddedWorker === undefined) {
    delete process.env.EMBEDDED_WORKER;
  } else {
    process.env.EMBEDDED_WORKER = originalEmbeddedWorker;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("resolveEmbeddedWorkerEnabled", () => {
  it("defaults to true when no override is present", () => {
    delete process.env.EMBEDDED_WORKER;

    expect(resolveEmbeddedWorkerEnabled()).toBe(true);
  });

  it("respects an explicit false environment override", () => {
    process.env.EMBEDDED_WORKER = "false";

    expect(resolveEmbeddedWorkerEnabled()).toBe(false);
  });

  it("prefers the direct option over the environment", () => {
    process.env.EMBEDDED_WORKER = "false";

    expect(resolveEmbeddedWorkerEnabled(true)).toBe(true);
  });
});

describe("requireDatabaseUrl", () => {
  it("throws when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;

    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL is required/);
  });

  it("returns the configured DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://example.test/auth_layer";

    expect(requireDatabaseUrl()).toBe("postgres://example.test/auth_layer");
  });
});
