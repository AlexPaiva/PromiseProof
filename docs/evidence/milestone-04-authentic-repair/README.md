# Milestone 04 authentic repair evidence

This tracked package preserves the evidence chain for authentic initialization-race repair `c52183ec-2075-47e9-a1fb-7902e028dc42`. It establishes internal integrity for the synthetic journey; it is not external attestation, a compliance claim, or a universal-correctness claim.

## Evidence terms

- **Recorded authentic run**: the historical GPT/Codex execution and its retained runtime evidence.
- **Original machine receipt**: byte-for-byte runtime output copied into `original/` with its original SHA-256 retained in `artifact-manifest.json`.
- **Sanitized derivative**: an allowlisted export linked to an original digest. It is never described as an original machine receipt.
- **Reproducible offline rehearsal**: a network-free test of the two-worktree protocol. It is not a fresh GPT-5.6 or Codex execution.

## Artifact chain

1. `summary.json` records the repair identity, safe Codex provenance, approval state, verification authority, cleanup state, and the distinction between artifact classes.
2. `artifact-manifest.json` is the digest and classification inventory. It identifies the exact originals, the one sanitized state derivative, and the detailed runtime outputs that remain recorded by the original verification receipt but are not fully reproduced in Git.
3. `candidate.patch` is the complete approved two-file patch. Its SHA-256 is `62e2924d0d5c6d88d40e5fae47a95607661f900ae0889a4105df58b8e83557f7` and its size is 2,311 bytes.
4. `original/` contains the safe, byte-for-byte human-decision, lifecycle/cleanup, verification, and Playwright result-metadata receipts.
5. `sanitized/candidate-state.json` is a sanitized derivative of the original local state receipt. Its source SHA-256 is retained because the original included local runtime paths and is not tracked.
6. `verification.md` summarizes the unchanged Playwright and deterministic-evaluator observations.

The original verification receipt records hashes for further runtime logs, Playwright evidence, traces, screenshots, and video. Those details are an authentic recorded run but are not fully reproducible from the tracked package. They were not regenerated or relabelled as originals.

## Offline verification

From the repository root:

```powershell
npm run evidence:verify
```

The verifier is deterministic and offline. It validates tracked artifacts and Git objects only: receipt schemas and digests, derivative linkage, the base commit and tree, approved patch bytes and pre-image, the intentionally seeded-broken `main` branch, the absent repaired blobs, and the verification/cleanup facts.

Only the unchanged Playwright journey and deterministic evaluator own the recorded `pass`. The model produced a bounded candidate and the human approved a digest; neither determined PASS.

## Canonical journey and frozen checkpoint

The historical repair was applied only in a disposable verification worktree. `main` intentionally remains seeded-broken, and this package does not merge or apply the repair to it.

The production journey remains human-gated: `prepare`, interactive digest review, then verification in a second fresh worktree. Fresh candidate preparation is not part of the judge path after this frozen checkpoint. New tracked submission files are deliberately outside the Milestone 04 frozen-foundation delta allowlist, so a future `repair:race:prepare` from this checkpoint would fail closed. This package uses the already approved authentic patch instead.

For the network-free rehearsal of the protocol, run:

```powershell
npm run test:repair:offline
```

At this frozen submission checkpoint, that test first proves current packaging
fails closed before candidate creation, then performs its historical
two-worktree rehearsal from the last eligible Milestone 04 code checkpoint.
That rehearsal remains offline-only and does not prepare a fresh live
candidate.
