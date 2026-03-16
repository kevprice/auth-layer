# Example Artifacts

- `operator-keys/dev-operator.public-key.json`: trusted public key for the valid example operator
- `operator-keys/wrong-operator.public-key.json`: non-matching operator key for negative verification tests
- `checkpoints/valid-checkpoint.json`: signed Merkle checkpoint for the valid example package
- `checkpoints/wrong-checkpoint.json`: valid but mismatched checkpoint from a later log state
- `proof-packages/valid`: valid exported proof package with a Merkle inclusion proof
- `proof-packages/tampered-canonical-content`: canonical content modified after export
- `proof-packages/tampered-inclusion-proof`: inclusion proof modified after export
- `proof-packages/bad-receipt`: receipt references the wrong proof bundle hash
- `proof-packages/bad-checkpoint-signature`: checkpoint signature has been tampered

Verify the valid example with:

`npm run proof:verify -- examples/proof-packages/valid --checkpoint examples/checkpoints/valid-checkpoint.json --operator-key examples/operator-keys/dev-operator.public-key.json`

Negative checks:

- wrong checkpoint: `npm run proof:verify -- examples/proof-packages/valid --checkpoint examples/checkpoints/wrong-checkpoint.json --operator-key examples/operator-keys/dev-operator.public-key.json`
- wrong operator key: `npm run proof:verify -- examples/proof-packages/valid --checkpoint examples/checkpoints/valid-checkpoint.json --operator-key examples/operator-keys/wrong-operator.public-key.json`
- tampered inclusion proof: `npm run proof:verify -- examples/proof-packages/tampered-inclusion-proof --checkpoint examples/checkpoints/valid-checkpoint.json --operator-key examples/operator-keys/dev-operator.public-key.json`
