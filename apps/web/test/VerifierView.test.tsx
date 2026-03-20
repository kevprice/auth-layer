import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyProofPackageZip } = vi.hoisted(() => ({
  verifyProofPackageZip: vi.fn()
}));

vi.mock("../src/browserVerifier", async () => {
  const actual = await vi.importActual<typeof import("../src/browserVerifier")>("../src/browserVerifier");
  return {
    ...actual,
    verifyProofPackageZip,
    browserVerifierLimits: {
      maxZipBytes: 25 * 1024 * 1024,
      maxExtractedBytes: 75 * 1024 * 1024,
      maxIndividualFileBytes: 25 * 1024 * 1024
    }
  };
});

import { VerifierView } from "../src/VerifierView";

beforeEach(() => {
  verifyProofPackageZip.mockReset();
});

describe("VerifierView", () => {
  it("renders quote lineage details only when lineage metadata exists", async () => {
    verifyProofPackageZip.mockResolvedValue({
      status: "verified",
      summary: "Verification succeeded using package-provided checkpoint and operator key material.",
      trustBasisSummary: "Package-provided checkpoint and operator key material were used.",
      trustBasis: {
        checkpointSource: "package-provided",
        operatorKeySource: "package-provided",
        independentTrustRootSuppliedByUser: false,
        operatorKeyFingerprints: ["sha256:operator"],
        operatorKeyIds: ["operator-key-1"],
        checkpointId: "checkpoint-1",
        proofBundleHash: "sha256:bundle"
      },
      checks: [
        { id: "proof-package-integrity", label: "Proof package integrity", status: "pass", details: "Package integrity verified." },
        { id: "merkle-inclusion-proof", label: "Merkle inclusion proof", status: "pass", details: "Inclusion proof verified." },
        { id: "checkpoint-signature", label: "Checkpoint signature", status: "pass", details: "Checkpoint signature verified." },
        { id: "pdf-approval-receipt", label: "Optional PDF approval receipt", status: "incomplete", details: "No approval receipt included." }
      ],
      packageInfo: { captureId: "capture-1", artifactType: "url-capture", packageType: "auth-layer-proof-package", proofBundleHash: "sha256:bundle", fileCount: 10 },
      appendix: {
        fileReferences: ["manifest.json", "lineage.json"],
        selectedCheckpointId: "checkpoint-1",
        selectedCheckpointHash: "sha256:checkpoint",
        selectedCheckpointRootHash: "sha256:root",
        selectedCheckpointSource: "package-provided",
        selectedOperatorKeySource: "package-provided",
        transparencyLogEntryHash: "sha256:entry",
        inclusionProof: { mode: "merkle-v1", treeSize: 1, leafIndex: 0, rootHash: "sha256:root", checkpointId: "checkpoint-1" }
      },
      issues: [],
      lineage: {
        hasLineage: true,
        lineageNodeCount: 3,
        lineageEdgeCount: 2,
        lineageRoots: ["transcript-root"],
        lineageWarnings: [
          {
            code: "semantic-equivalence-not-proven",
            severity: "warning",
            edgeFrom: "quote",
            edgeTo: "headline",
            message: "Edge quote -> headline is marked headline. Provenance is declared, but exact semantic equivalence is not proven by deterministic checks."
          }
        ],
        nodes: [
          { id: "transcript-root", type: "transcript-segment", text: "Original transcript segment", contextBefore: "Before", contextAfter: "After" },
          { id: "quote", type: "quote", text: "Original transcript", contextBefore: "Before", contextAfter: "After" },
          { id: "headline", type: "headline", text: "Headline wording" }
        ],
        edges: [
          { from: "transcript-root", to: "quote", derivationType: "trimmed" },
          { from: "quote", to: "headline", derivationType: "headline" }
        ]
      },
      generatedAt: "2026-03-20T10:00:00.000Z"
    });

    const { container } = render(<VerifierView goHome={() => undefined} />);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(fileInput, new File([new Uint8Array([1, 2, 3])], "package.zip", { type: "application/zip" }));
    await userEvent.click(screen.getByRole("button", { name: /verify package/i }));

    expect(await screen.findByRole("heading", { name: /Quote Lineage/i })).toBeInTheDocument();
    expect(screen.getByText((value) => value.includes("3 node(s), 2 edge(s)"))).toBeInTheDocument();
    expect(screen.getByText(/Exactness warning present|No exactness warning/i)).toBeInTheDocument();
    expect(screen.getAllByText(/transcript-root/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/headline/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/exact semantic equivalence is not proven/i)).toBeInTheDocument();
  });
});



