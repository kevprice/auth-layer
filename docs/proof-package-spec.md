# Proof Package Specification

Proof packages are portable capture bundles intended for offline verification.

## Package contents

A package is a directory containing deterministic JSON plus referenced artifacts.

Required files:
- `manifest.json`
- `capture-record.json`
- `transparency-export.json`
- `operator-public-key.json`

Optional files, depending on what the capture produced:
- `raw-snapshot.json`
- `raw-snapshot.html`
- `canonical-content.json`
- `metadata.json`
- `diagnostics.json`
- `proof-bundle.json`
- `receipt.json`
- `transparency-log-entry.json`
- `transparency-checkpoint.json`
- `transparency-inclusion-proof.json`

## Manifest fields

`manifest.json` includes:
- `schemaVersion`
- `packageType`
- `exportedAt`
- `captureId`
- `requestedUrl`
- `finalUrl`
- `rawSnapshotHash`
- `canonicalContentHash`
- `metadataHash`
- `proofBundleHash`
- `hashAlgorithm`
- `extractorVersion`
- `normalizationVersion`
- `files`

The `files` object lists package paths, media types, and whether a file is optional.

The package keeps a clear boundary between the compact verifier-facing `proof-bundle.json` and the human-oriented `diagnostics.json`. Diagnostics are exported for auditability and review, but they are not the root object that the receipt and transparency log attest. Rich render settings, screenshot references, and approval-display fields belong in the manifest and diagnostics layer unless they are directly required for integrity verification.

## Evidence layers

Proof packages may describe several evidence layers:
- `Raw snapshot`: the fetched response or uploaded file preserved exactly as observed.
- `Canonical content`: the normalized semantic representation used for comparisons.
- `Metadata`: the normalized extracted facts that can change independently from body text.
- `Rendered evidence`: optional screenshot-based visual evidence recorded under explicit viewport and device settings.

Rendered evidence improves human inspection, but it is not canonical content and verifiers should not treat screenshot equality as a semantic equality check. Diagnostics may also include evidence-layer summaries and conservative PDF quality signals so exported packages remain legible without changing the attested proof-bundle schema.

## Verification rules

A verifier should:
1. read `manifest.json`
2. recompute the raw snapshot hash from `raw-snapshot.json` plus `raw-snapshot.html`
3. recompute the canonical content hash from `canonical-content.json`
4. recompute the metadata hash from `metadata.json`
5. recompute the proof bundle hash from `proof-bundle.json`
6. verify that the receipt references the recomputed proof bundle hash
7. recompute the transparency log entry hash, if present
8. verify the inclusion proof against the checkpoint Merkle root when `logMode` is `merkle-tree-v1`
9. verify the signed transparency checkpoint against a trusted operator public key
10. optionally verify the PDF approval receipt when present
11. fall back to legacy exact-entry validation only for `legacy-hash-chain` checkpoints

## Merkle portability

For Merkle checkpoints, the proof package should carry enough information to verify inclusion without contacting the operator:
- the transparency log entry
- the signed checkpoint
- the inclusion proof
- the trusted operator public key obtained out of band

This is what allows the package to remain independently checkable after export.

## CLI

Export a package:

```bash
npm run proof:export -- <capture-id> <output-directory>
```

Verify a package against a published checkpoint and trusted operator key:

```bash
npm run proof:verify -- <package-directory> --checkpoint <checkpoint.json> --operator-key <operator-public-key.json>
```

Multiple `--operator-key` flags may be supplied so verifiers can maintain a small trust store.

## Backward compatibility

Existing captures without screenshots or richer render metadata remain valid. Existing PDF approval receipts that do not explicitly declare `approvalScope` or `approvalMethod` should be interpreted with the v1 defaults for display purposes, while newly written approval receipts should include both fields.

## Trust note

The packaged `operator-public-key.json` is informational. Verifiers should trust keys they obtained through an out-of-band trust decision, not just because a package included them.
