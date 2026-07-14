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

## Current milestone

Build only:

1. A GPT-5.6 hypothesis manager for the two existing evidence signatures.
2. A versioned model-input dossier built only from normalized evidence,
   deterministic clause results, registered replay descriptions, and prior
   replay reports.
3. Structured model output containing ranked hypotheses, evidence references,
   and exactly one requested replay ID.
4. Runtime validation that rejects malformed output and every replay ID outside
   the shared whitelist.
5. A closed dispatcher that executes only the validated registered replay.
6. A bounded investigation loop that records hypotheses, the selected replay,
   the factual replay result, token usage, latency, and validation decisions.
7. Deterministic provider tests plus a separately invoked live GPT-5.6 smoke
   path; ordinary tests must not require credits or network access.

The model-input boundary must exclude fixture selection, configuration and
health responses, environment variables, source code, server logs, screenshots,
videos, and Playwright traces. GPT-5.6 may investigate and select a replay, but
it may not declare that the promise passed. Deterministic TypeScript retains
verdict ownership.

Do not implement Codex repair, disposable-worktree execution, or human approval
in this milestone.

## Quality requirements

- TypeScript.
- Clear scripts for build, test, and development.
- No console errors.
- Seeded deterministic demo mode.
- Small, understandable modules.
- Commit after every verified milestone.
- Keep BUILD_WEEK.md updated with decisions and completed work.
