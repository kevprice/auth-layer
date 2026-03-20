import { describe, expect, it } from "vitest";

import {
  createLineageBundle,
  hashLineageBundle,
  isExactLineageTextMatch,
  isTrimmedLineageTextMatch,
  summarizeLineageBundle,
  validateLineageBundle
} from "../src/index.js";

describe("lineage helpers", () => {
  it("hashes lineage bundles deterministically without normalizing text", async () => {
    const bundleA = createLineageBundle({
      contentObjects: [
        { id: "root", type: "transcript-segment", text: `Line one

Line two`, language: "en" },
        { id: "quote", type: "quote", text: "Line one", language: "en" }
      ],
      edges: [{ from: "root", to: "quote", derivationType: "trimmed" }],
      rootObjectIds: ["root"]
    });
    const bundleB = createLineageBundle({
      contentObjects: [
        { language: "en", text: `Line one

Line two`, type: "transcript-segment", id: "root" },
        { text: "Line one", id: "quote", type: "quote", language: "en" }
      ],
      edges: [{ to: "quote", derivationType: "trimmed", from: "root" }],
      rootObjectIds: ["root"]
    });
    const bundleC = createLineageBundle({
      contentObjects: [
        { id: "root", type: "transcript-segment", text: "Line one Line two", language: "en" },
        { id: "quote", type: "quote", text: "Line one", language: "en" }
      ],
      edges: [{ from: "root", to: "quote", derivationType: "trimmed" }],
      rootObjectIds: ["root"]
    });

    await expect(hashLineageBundle(bundleA)).resolves.toBe(await hashLineageBundle(bundleB));
    await expect(hashLineageBundle(bundleA)).resolves.not.toBe(await hashLineageBundle(bundleC));
  });

  it("rejects missing edge references and cycles", () => {
    const missingRef = createLineageBundle({
      contentObjects: [{ id: "root", type: "quote", text: "alpha" }],
      edges: [{ from: "root", to: "child", derivationType: "verbatim" }]
    });
    const cycle = createLineageBundle({
      contentObjects: [
        { id: "a", type: "quote", text: "alpha" },
        { id: "b", type: "quote", text: "beta" }
      ],
      edges: [
        { from: "a", to: "b", derivationType: "paraphrased" },
        { from: "b", to: "a", derivationType: "paraphrased" }
      ]
    });

    expect(validateLineageBundle(missingRef).ok).toBe(false);
    expect(validateLineageBundle(missingRef).errors.some((warning) => warning.code === "missing-edge-node")).toBe(true);
    expect(validateLineageBundle(cycle).ok).toBe(false);
    expect(validateLineageBundle(cycle).errors.some((warning) => warning.code === "cycle-detected")).toBe(true);
  });

  it("warns on disconnected graphs, multiple roots, and semantic-only derivations", () => {
    const bundle = createLineageBundle({
      contentObjects: [
        { id: "root", type: "transcript-segment", text: "Original line" },
        { id: "headline", type: "headline", text: "Headline version" },
        { id: "orphan", type: "claim", text: "Separate claim" }
      ],
      edges: [{ from: "root", to: "headline", derivationType: "headline" }]
    });

    const summary = summarizeLineageBundle(bundle);
    expect(summary.hasLineage).toBe(true);
    expect(summary.lineageWarnings.some((warning) => warning.code === "multiple-roots")).toBe(true);
    expect(summary.lineageWarnings.some((warning) => warning.code === "disconnected-graph")).toBe(true);
    expect(summary.lineageWarnings.some((warning) => warning.code === "semantic-equivalence-not-proven")).toBe(true);
  });

  it("supports exact and trimmed deterministic text checks", () => {
    expect(isExactLineageTextMatch("Exact quote", "Exact quote")).toBe(true);
    expect(isExactLineageTextMatch("Exact quote", "exact quote")).toBe(false);
    expect(isTrimmedLineageTextMatch("The full original sentence.", "full original")).toBe(true);
    expect(isTrimmedLineageTextMatch("The full original sentence.", "changed wording")).toBe(false);
  });
});
