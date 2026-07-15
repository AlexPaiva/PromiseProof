# PromiseProof — OpenAI Build Week

## Objective

Build a Developer Tools submission that proves whether a product keeps
the personalization choice it presents to users.

## Canonical promise

When activity-based personalization is OFF:

- No identifiable activity reaches the recommendation service.
- The feed remains functional using contextual recommendations.
- The preference survives a reload.

When personalization is ON:

- Expected activity reaches the recommendation service.
- Behavioral recommendations remain functional.

## Seeded root causes

1. Initialization race:
   the activity collector starts before preference hydration completes.

2. Propagation failure:
   the frontend changes to OFF but the backend preference remains ON.

The defects must produce different evidence and different diagnostic
actions.

## Required architecture

- Playwright executes the user journey.
- Deterministic code collects and evaluates evidence.
- GPT-5.6 maintains hypotheses and selects a whitelisted diagnostic replay.
- Codex prepares a minimal source patch and regression test.
- Repairs occur in a disposable Git worktree.
- A human reviews the diff.
- Playwright decides whether the repair passes.

## Forbidden shortcuts

- Never weaken the contract or assertion thresholds.
- Never disable recommendations globally.
- Never hard-code the diagnosis from a selected demo mode.
- Never let a model declare that verification passed.
- Never claim legal or regulatory compliance.
- Do not add another product promise before the canonical loop works.
- Do not create accounts, billing, GitHub OAuth, or production crawling.

## Current milestone — Milestone 04 bounded Codex repair

Milestone 03 is frozen at commit `65a5dd6` and tag
`milestone-03-gpt56-investigation`. Its evaluator, canonical contract, seeded
defects, evidence capture, GPT-5.6 schemas, live receipt, and diagnostic replays
remain outside repair write scope.

Build one complete repair path for the initialization-race evidence signature:

verified deterministic violation
→ validated Milestone 03 live receipt
→ replay-grounded repair eligibility
→ detached disposable Git worktree
→ one bounded Codex SDK turn
→ minimal source patch plus one regression test
→ deterministic diff firewall
→ explicit human approve or reject decision
→ second fresh detached verification worktree
→ exact approved patch reapplied by digest
→ unchanged Playwright contract and controls
→ retained deterministic repair receipt
→ safe worktree cleanup only after evidence is saved

The propagation defect remains intentionally broken. It demonstrates that the
investigation selected a different replay and that the race repair is not a
global disablement or universal hard-coded path.

Milestone 04 invariants:

1. Derive repair eligibility from versioned, runtime-validated evidence. Require
   the exact race violation, the startup-order replay, replay-grounded ordering
   facts, and the completed live GPT-5.6 cohort. Never use `DEMO_MODE`, fixture
   names, model-authored titles, or free-form causal prose as repair authority.
2. Use exact-pinned `@openai/codex-sdk` server-side. Run one fresh thread and one
   turn with the resolved `gpt-5.6-sol` identifier, an explicit worktree working
   directory, `workspace-write`, no network or web search, no MCP/apps/hooks or
   subagents, a minimal process environment, a secret-filtering shell environment
   policy, an output schema, event/output bounds, and an abort timeout. On native
   Windows require the administrator-provisioned elevated offline-user sandbox;
   never fall back to the weaker unelevated backend. Before every paid turn,
   require a no-key behavioral preflight proving the workspace is readable while
   the setup marker and provisioning credential are unreadable, the pinned
   command runner is not writable, and the raw TCP probe fails with the exact
   Windows socket access-denied signal rather than a timeout or unrelated error.
3. PromiseProof—not Codex—creates both detached worktrees, installs dependencies,
   captures the base commit and refs, computes the diff, validates paths and
   sizes, hashes evidence, requests human review, invokes Playwright, writes the
   receipt, and performs cleanup. Never verify inside the candidate worktree:
   after approval, apply the retained patch to a second fresh worktree so ignored
   files, dependencies, and test binaries touched by Codex cannot manufacture a
   green result.
4. Codex may modify exactly `src/client/main.ts` and add exactly
   `tests/regression/initialization-order.spec.ts`. It may not stage, commit,
   switch refs, rename/delete files, create symlinks, modify binary or mode bits,
   or touch any other tracked/untracked source path.
5. Enforce a 32 KiB patch limit and at most 160 added-plus-deleted lines. Reject
   missing source or regression-test changes, staged changes, changed HEAD,
   attached branches, ref mutation, unexpected files, abnormal Git statuses,
   malformed output, unsafe SDK events, timeout, or secret retention.
6. Hash-protect at minimum the canonical evaluator, shared contract types,
   contract assertion, scenario/evidence collector, diagnostic replays, seeded
   propagation defect, and all repair orchestration/verification files. Codex
   cannot alter thresholds, expected codes, Playwright settings, or repair gates.
7. Retain only a sanitized Codex event summary: SDK/CLI versions, requested
   model, thread ID, bounded item-type/status counts, usage, timing, file-change
   paths, final-response hash, and deterministic validation decisions. Never
   retain raw reasoning, command output, environment values, credentials, or the
   full prompt in the committed receipt.
8. A valid candidate stops in `awaiting_human_review`. No test result, model
   statement, prior authorization, or automation may approve it. Approval or
   rejection must name the repair ID and exact patch hash. Any post-review diff
   change invalidates the decision.
9. Only an explicitly approved, still-identical retained patch may reach
   acceptance. Recreate dependencies with `npm ci --ignore-scripts` in the fresh
   verification worktree, reuse the exact unchanged OFF contract assertion and
   ON control, add the focused startup-order regression, require zero browser
   errors, and prove OFF contextual recommendations, ON behavioral
   recommendations, and reload persistence. Playwright alone owns repaired
   PASS/FAIL.
10. Independently rerun the propagation expected-red verifier and require only
    `PP_PREFERENCE_NOT_PERSISTED`. This proves the candidate did not weaken the
    evaluator, globally disable recommendations, or erase the other defect.
11. Never merge or apply the candidate to `main` automatically. Preserve failed
    and rejected evidence. Cleanup is explicit and permitted only after the
    review/verification artifacts and binary patch have been copied outside both
    worktrees and revalidated.
12. Offline tests must exercise every boundary without a Codex call. The one
    authentic live Codex repair is a separate explicit command. Do not add a
    second repair target, another product promise, causal benchmark, hosted
    deployment, or broad UI redesign until this red-to-green loop is proven.

## Quality requirements

- TypeScript.
- Clear scripts for build, test, and development.
- No console errors.
- Seeded deterministic demo mode.
- Small, understandable modules.
- Commit after every verified milestone.
- Keep BUILD_WEEK.md updated with decisions and completed work.
