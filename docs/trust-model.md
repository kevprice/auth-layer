# Trust Model

This project treats Postgres as the operational store, not the trust anchor.

## What the system is designed to prove

A completed capture can support these claims:
- our system fetched the requested URL by the recorded capture timestamp
- the preserved raw snapshot, canonical content, metadata, and optional rendered-evidence hashes match the exported artifacts
- the proof bundle hash was witnessed by a transparency log entry that is included in a signed Merkle checkpoint
- exported proof packages can be re-verified without the web UI or API

## What the system does not prove

The MVP does not prove:
- when the publisher originally created the page
- that a claimed publication date is true
- that an extracted author field is genuine
- that content was unchanged before the capture occurred
- that one operator should be trusted forever

## Evidence layers

The system can preserve several layers of evidence, each with a different job:
- `Raw snapshot` captures what the operator actually fetched or ingested.
- `Canonical content` captures the deterministic semantic representation used for change detection.
- `Metadata` captures extracted citation-like fields that can drift independently of body text.
- `Rendered evidence` captures optional screenshot-based visual evidence under recorded viewport and device settings.

Rendered evidence is valuable for human inspection, but it is not the canonical semantic layer and screenshot equality is not expected across captures.

## Current trust anchors

Independent verification today depends on:
- deterministic canonicalization and hashing rules
- a portable proof package
- an operator public key that the verifier chooses to trust
- a signed checkpoint file matching the package's transparency receipt
- a Merkle inclusion proof linking the package's log entry to the checkpoint root

The trust boundary is no longer the database alone. A verifier can check exported artifacts, checkpoint signatures, and inclusion proofs offline. PDF approval receipts are additive provenance on top of this baseline: they can strengthen authorship or approval claims later, but they are not required for capture validity.

## Legacy compatibility

Older checkpoints may still use the legacy exact-entry hash-chain model. The verifier keeps a backwards-compatible path for those checkpoints, but they provide weaker guarantees than the Merkle model and should be treated as legacy evidence.

## Operator accountability

Each checkpoint includes:
- `operatorId`
- `operatorKeyId`
- `operatorPublicKeySha256`
- `signatureAlgorithm`
- `logMode`
- `checkpointHash`
- previous-checkpoint references

That makes checkpoint issuance attributable to a specific operator key instead of to a shared secret buried in server config.

## Key rotation model

Operator key rotation should preserve continuity by:
1. publishing the new operator public key before it is used
2. keeping older public keys available for historic checkpoint verification
3. documenting when a key was introduced or superseded
4. never rewriting old checkpoints after rotation

## Long-term direction

The long-term goal is a protocol with a reference server, not a single canonical operator. The roadmap is:
1. deterministic exports and an offline verifier CLI
2. append-only transparency log plus signed checkpoints
3. Merkle checkpoints plus portable inclusion proofs
4. public checkpoint publication and independent mirrors
5. optional external timestamp anchoring and interoperable multi-operator receipts
