# Verification Guarantees

## What verification guarantees

When a proof package verifies successfully, the verifier can say:
- the included artifacts are internally consistent under the documented hash rules
- the proof bundle matches the captured raw snapshot, canonical content, and metadata included in the package
- the timestamp receipt references the same proof bundle hash
- the transparency checkpoint was signed by a trusted operator key
- the package's transparency log entry is included in the checkpoint's signed Merkle root when a Merkle inclusion proof is present

## What verification does not guarantee

Verification does not establish:
- the original creation time of the page by the publisher
- the truth of any author or publication-date claim inside the page
- that the publisher approved or signed the content
- that the content was unchanged before the capture happened
- ecosystem-wide transparency properties such as gossip or universal consistency

## Merkle vs legacy checkpoints

The current preferred checkpoint model is `merkle-tree-v1`. Compared with the older exact-entry hash-chain mode, it gives a stronger guarantee because the verifier can validate inclusion of a specific log entry against a signed log root and tree size.

Legacy `legacy-hash-chain` checkpoints are still supported where practical for backwards compatibility, but they only prove that one checkpoint matched one exact log entry or log head. They do not provide portable inclusion proofs for arbitrary earlier entries.
