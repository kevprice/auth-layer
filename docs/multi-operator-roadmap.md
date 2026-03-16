# Multi-Operator Roadmap

## Goal

The long-term goal is an ecosystem of compatible witnesses, not one canonical server.

## Protocol-level requirements

A multi-operator future needs:
- shared proof package schema
- shared transparency log entry and checkpoint formats
- documented verifier behavior
- operator public keys distributed independently of proof packages
- trust policies that let verifiers decide which operators to trust

## Planned stages

1. Single-operator reference implementation with portable packages and offline verification.
2. Public checkpoint publication and mirrored operator public keys.
3. Multiple operators emitting compatible checkpoints and proof packages.
4. Optional cross-logging of the same proof bundle to several operators.
5. Merkle inclusion proofs and monitor tooling for stronger transparency guarantees.

## Trust policy direction

Verifiers should eventually be able to:
- trust one operator
- trust a curated set of operators
- require cross-logging to several operators
- accept packages only from operators whose keys are known and not revoked

## Current status

This repo is still a reference implementation, but the key export, package format, and checkpoint schema are now designed so independent operators can implement the same protocol later.
