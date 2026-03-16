# Transparency Log

The transparency layer records completed proof bundles in an append-only operator log and signs public checkpoints over the log state.

## Merkle model

Each completed capture appends a `TransparencyLogEntry` containing:
- `schemaVersion`
- `logIndex`
- `captureId`
- `proofBundleHash`
- `previousEntryHash`
- `entryHash`
- `createdAt`

Checkpoints are now Merkle-based. For a checkpointed log state, the operator computes:
- `treeSize`
- `rootHash`
- `lastLogIndex`
- `lastEntryHash`

The checkpoint is then signed with the operator's Ed25519 key.

## Checkpoint fields

A `TransparencyCheckpoint` contains:
- `schemaVersion`
- `checkpointId`
- `treeSize`
- `lastLogIndex`
- `lastEntryHash`
- `rootHash`
- `issuedAt`
- `operatorId`
- `operatorKeyId`
- `operatorPublicKeySha256`
- `signatureAlgorithm`
- `logMode`
- `checkpointHash`
- `previousCheckpointId`
- `previousCheckpointHash`
- `signature`

`logMode` is `merkle-tree-v1` for the current model.

## Inclusion proofs

Proof packages now include or reference a `TransparencyInclusionProof` for the package's log entry. The proof contains:
- `mode`
- `algorithm`
- `checkpointId`
- `treeSize`
- `leafIndex`
- `logEntryHash`
- `leafHash`
- `rootHash`
- `steps`

This lets an offline verifier prove that a specific log entry is included in the signed checkpoint root without calling the operator's server.

## Verification flow

A verifier can now check, offline:
1. proof-package artifact hashes
2. the trusted operator public key
3. the checkpoint signature
4. the Merkle inclusion proof against the checkpoint root

That is stronger than the previous exact-entry checkpoint model because a verifier can validate inclusion against a checkpointed log root instead of only checking whether one checkpoint exactly matched one entry.

## Legacy mode

Older checkpoints may still appear in `legacy-hash-chain` mode. Those legacy checkpoints are supported for backwards compatibility, but they are limited:
- they attest only to an exact entry/log-head relationship
- they do not provide compact inclusion proofs for arbitrary earlier entries
- they should be treated as legacy evidence, not the preferred model for new captures

## CLI

Export the latest checkpoint:

```bash
npm run transparency:checkpoint -- [output-path]
```

Export the operator public key:

```bash
npm run transparency:operator-key -- [output-path]
```

## Trust properties

The Merkle checkpoint model gives the system:
- append-only sequencing for completed proof bundles
- signed attestation to log size and Merkle root
- portable inclusion proofs for offline verification
- checkpoint continuity through previous-checkpoint references
- a path toward mirrored checkpoints and independent monitoring

It still does not provide, by itself:
- ecosystem-wide gossip or consistency proofs
- public checkpoint distribution by default
- external timestamp anchoring
- trust in any operator without an explicit verifier trust decision
