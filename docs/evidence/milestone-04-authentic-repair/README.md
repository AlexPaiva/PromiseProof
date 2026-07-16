# Milestone 04 authentic repair evidence

This directory is a sanitized, tracked proof package for the authentic initialization-race repair `c52183ec-2075-47e9-a1fb-7902e028dc42`.

## Artifact chain

1. `summary.json` records the base commit, candidate identity, approved patch digest, bounded Codex provenance already classified as safe, human approval state, fresh-worktree verification result, and cleanup state.
2. `candidate.patch` is the complete approved two-file patch. Its SHA-256 is `62e2924d0d5c6d88d40e5fae47a95607661f900ae0889a4105df58b8e83557f7` and its size is 2,311 bytes.
3. `verification.md` summarizes the Playwright and deterministic-evaluator observations retained by the verification receipt.

The package intentionally excludes local paths, credentials, environment values, private prompts, raw model output, and hidden reasoning. The retained runtime receipt remains the authoritative machine-readable record; this package exposes only its safe provenance and verification facts.

## Integrity check

From the repository root, verify the tracked patch before relying on it:

```powershell
(Get-FileHash -Algorithm SHA256 docs/evidence/milestone-04-authentic-repair/candidate.patch).Hash.ToLower()
```

The result must be `62e2924d0d5c6d88d40e5fae47a95607661f900ae0889a4105df58b8e83557f7`.

## Reproducing the canonical journey

The production repair journey is deliberately human-gated:

```powershell
npm run repair:race:prepare
npm run repair:race:review -- <repair-id>
npm run repair:race:verify -- <repair-id>
```

`prepare` creates one bounded candidate in a disposable worktree. A human must inspect and approve the displayed digest in a real terminal. `verify` then reapplies that approved patch to a second fresh worktree and lets the unchanged Playwright journey and deterministic evaluator decide the result. It does not merge a candidate into `main` automatically.

For the network-free deterministic rehearsal of the same two-worktree protocol, run:

```powershell
npm run test:repair:offline
```

The historical candidate captured here has already completed verification and cleanup. Do not reuse it as a new candidate or use this evidence package to bypass the review gate.
