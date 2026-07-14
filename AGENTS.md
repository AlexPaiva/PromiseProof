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

1. The propagation-failure defect.
2. Evidence observably distinct from the initialization race.
3. A real preference write, acknowledgement, and authoritative readback.
4. A distinct whitelisted diagnostic replay for each seeded defect.
5. An unchanged failing Playwright contract assertion for each OFF defect.
6. A passing Playwright control assertion for ON in both fixtures.
7. Five consecutive deterministic OFF and ON runs per fixture.

Do not implement GPT-5.6 hypothesis management or Codex repair yet.

## Quality requirements

- TypeScript.
- Clear scripts for build, test, and development.
- No console errors.
- Seeded deterministic demo mode.
- Small, understandable modules.
- Commit after every verified milestone.
- Keep BUILD_WEEK.md updated with decisions and completed work.
