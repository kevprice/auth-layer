# Threat Model

## In scope

This MVP is designed to make these failures visible or survivable:
- database loss or operator shutdown after packages were exported
- accidental mutation of captured artifacts after a package was issued
- tampering with canonical content, metadata, proof bundles, or receipts
- log checkpoint forgery without access to the trusted operator private key
- extractor drift over time through pinned schema and normalization versions

## Not fully solved yet

This MVP does not fully defend against:
- a malicious operator who never publishes a checkpoint
- suppression of checkpoints before they reach mirrors
- an operator who serves inconsistent views to different clients
- compromise of the operator private key before rotation is announced
- universal inclusion proofs for historical entries
- forged publisher claims inside the captured page itself

## Main attacker actions and defenses

`Altered canonical-content.json`
Defense: offline verifier recomputes the canonical content hash and fails.

`Altered proof-bundle.json`
Defense: offline verifier recomputes the proof bundle hash and fails.

`Forged checkpoint file`
Defense: checkpoint signature verification against a trusted operator public key fails.

`Receipt replay or mismatch`
Defense: verifier checks that the receipt references the recomputed proof bundle hash and checkpoint id.

`Extractor/version ambiguity`
Defense: canonical and metadata artifacts carry schema, extractor, and normalization versions.

## Key management risks

Operator keys are now part of the trust boundary. Risks include:
- private key leakage
- silent key replacement
- failure to retain old public keys for historical verification

Operationally, operators should publish key changes clearly and keep old public keys available for historic checkpoint validation.
