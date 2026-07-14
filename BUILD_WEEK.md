# PromiseProof Build Week Log

## Project baseline — 2026-07-14

PromiseProof begins as a new OpenAI Build Week project. `AGENTS.md` is the canonical product and engineering specification.

### Decisions

- Enter the Developer Tools track as a solo entrant.
- Prove one narrow, observable promise before expanding scope.
- Keep verdict ownership deterministic: models may later investigate and propose repairs, but they may not declare verification success.
- Use a synthetic recommendation product and synthetic identifiers only.
- Preserve an authentic frontend-to-backend HTTP boundary for activity evidence.
- Keep the ordinary health suite green while exposing the seeded contract violation through a separate non-zero promise verifier.
- Defer GPT-5.6 diagnosis and Codex repair automation until the canonical Playwright loop is deterministic.

### Baseline contents

- `AGENTS.md` — canonical promise, constraints, architecture, and milestone scope.
- `README.md` — repository orientation.
- `BUILD_WEEK.md` — decisions, commands, and verified milestone history.

### Next milestone

Implement and verify the initialization-race milestone defined in `AGENTS.md`, including five clean OFF and ON repetitions.

## Milestone 01 — deterministic initialization-race proof — 2026-07-14

### Architecture chosen

- One TypeScript workspace rather than a monorepo.
- Vanilla TypeScript client served by Vite middleware in development.
- Express backend with real HTTP routes for preferences, activity, recommendations, and evidence.
- In-memory deterministic data with fixed recommendation sets and synthetic identifiers.
- Shared evidence types and a deterministic evaluator used by Playwright.
- One Playwright worker, zero retries, and isolated browser contexts for repeatability.

The seeded defect is explicit startup ordering, not a probabilistic timeout: the collector starts with an unsafe in-memory ON default and awaits a real identifiable activity receipt before preference hydration begins.

### Test design

- `npm test` stays green and runs health, ON control, and detector meta-tests.
- `npm run verify:promise` executes the uncompromised OFF contract and remains genuinely red while the defect is active.
- `npm run test:determinism` compares a complete structural evidence signature across five fresh-context OFF runs and five fresh-context ON runs.
- Playwright captures outbound activity independently and correlates it with backend receipts.
- Feed clauses require backend recommendation receipts whose source and item IDs match the rendered cards.
- The race detector asserts the causal order `collector_started -> activity_dispatched -> activity_received -> preference_hydration_started -> preference_hydration_completed -> recommendation_rendered`.

### Normalized evidence

Every scenario records:

- UI preference and feed functionality.
- Browser-stored preference.
- Captured activity request payloads.
- Backend preference, activity receipts, and recommendation receipts.
- Rendered recommendation source and item IDs.
- Ordered client timeline plus client and server timestamps.
- Deterministic clause results and stable violation codes.
- Browser console and page errors.

JSON evidence is persisted through Playwright attachments. A failing contract also preserves its screenshot, video, trace, and error context.

### Verification commands and results

| Command | Result |
| --- | --- |
| `npm.cmd install` | PASS — 109 packages audited, 0 vulnerabilities reported |
| `npm.cmd exec playwright install chromium` | PASS — pinned Chromium, headless shell, FFmpeg, and Winldd installed |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run build` | PASS — client and production server bundles created |
| `npm.cmd test` | PASS — health + ON control 2/2; detector 1/1 |
| `npm.cmd run verify:promise` | EXPECTED FAIL — exit 1 with `PP_IDENTIFIABLE_EVENT_LEAK` |
| `npm.cmd run test:determinism` | PASS — 10/10 fresh-context cases |
| Production smoke: `/api/health` and `/` | PASS — JSON health response and bundled client returned HTTP 200 |

### Five-run record

| Run | OFF result | OFF requests / receipts | OFF feed / state | ON result | ON requests / receipts | ON feed / state |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | `PP_IDENTIFIABLE_EVENT_LEAK` | 1 / 1, payloads equal | contextual / OFF persisted | PASS | 1 / 1, payloads equal | behavioral / ON |
| 02 | `PP_IDENTIFIABLE_EVENT_LEAK` | 1 / 1, payloads equal | contextual / OFF persisted | PASS | 1 / 1, payloads equal | behavioral / ON |
| 03 | `PP_IDENTIFIABLE_EVENT_LEAK` | 1 / 1, payloads equal | contextual / OFF persisted | PASS | 1 / 1, payloads equal | behavioral / ON |
| 04 | `PP_IDENTIFIABLE_EVENT_LEAK` | 1 / 1, payloads equal | contextual / OFF persisted | PASS | 1 / 1, payloads equal | behavioral / ON |
| 05 | `PP_IDENTIFIABLE_EVENT_LEAK` | 1 / 1, payloads equal | contextual / OFF persisted | PASS | 1 / 1, payloads equal | behavioral / ON |

All OFF runs matched the same six-event causal timeline and passed the contextual-feed and preference-persistence clauses. All ON runs matched the behavioral signature with no violations. Timestamps and run-specific IDs were validated but excluded from structural equality.

### Quality findings resolved during verification

- Expanded the switch hit target after Playwright found that visible label text intercepted pointer input.
- Disabled the preference switch until hydration completes so the only startup race is the intentionally seeded collector defect.
- Added explicit Vite runtime disposal and disabled HMR under tests to prevent leaked development sockets.
- Required both independent browser request evidence and a matching backend activity receipt.
- Required backend receipts to substantiate contextual and behavioral feed claims.
- Persisted normalized JSON attachments by file path rather than relying on transient in-memory reporter data.
- Tightened activity timestamps to canonical millisecond ISO-8601 values.

### Known limitations

- Only the initialization-race root cause is implemented.
- The backend and evidence ledger are in memory and reset when the process restarts.
- Recorder/control endpoints currently share the synthetic application's origin and are mutable; the independent Playwright capture is the trust anchor for this milestone.
- Only Windows x64 has been verified.
- GPT-5.6 hypothesis management, whitelisted diagnostic replay, disposable-worktree repair, human diff approval, and repaired-state Playwright verification remain intentionally deferred.
- Submission packaging, hosting, licensing choice, and demo video remain future work.

### Next smallest milestone

Add the propagation-failure defect with evidence that is observably different from the initialization race, plus a distinct deterministic diagnostic replay. Keep model-driven diagnosis and automated repair deferred until both root causes are discriminable without a model.
