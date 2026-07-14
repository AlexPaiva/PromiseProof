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

## Milestone 02 — deterministic propagation discrimination — 2026-07-14

### Architecture extension

- Added two strict, server-selected fixture values: `initialization-race` and `propagation-failure`.
- Kept fixture selection out of URLs, `PromiseEvidence`, replay inputs, and deterministic evaluation.
- Isolated the second seed in `src/server/preference-service.ts` so a later repair has one narrow source boundary.
- In the propagation fixture, a real OFF write reaches the API and receives an ordinary OFF acknowledgement and receipt, while the authoritative store remains ON.
- The client performs an independent readback, continues honoring its stored OFF choice, suppresses activity, and renders contextual recommendations.
- Added evidence-schema version 2 with independently captured preference writes/responses, backend preference receipts, and a witnessed-reload marker.

No acknowledgement field reveals whether the value persisted. Only the separate write/read observations expose the contradiction.

### Distinct canonical evidence

| Observation | Initialization race | Propagation failure |
| --- | --- | --- |
| UI / storage / backend after reload | OFF / OFF / OFF | OFF / OFF / ON |
| Activity requests / receipts | 1 / 1, payloads equal | 0 / 0 |
| OFF writes in the complete observation window | 1 user write; authoritative readback OFF | 2 writes (user action + reload retry); authoritative readback ON |
| Recommendation feed | contextual, 3 rendered items matching receipt | contextual, 3 rendered items matching receipt |
| Only violation | `PP_IDENTIFIABLE_EVENT_LEAK` | `PP_PREFERENCE_NOT_PERSISTED` |
| ON control | PASS | PASS |

The canonical contract test is unchanged and still expects zero violations. It therefore fails honestly and differently under both seeded fixtures.

### Whitelisted diagnostic replays

Two factual actions are registered in shared code:

- `inspect_startup_order` — reload with an existing OFF choice and report collector/hydration order.
- `inspect_preference_roundtrip` — write OFF, read the authoritative value, and report both observations.

The deterministic chooser accepts only clause results. It cannot receive the fixture value. The replay matrix is:

| Fixture | Startup-order replay | Preference round-trip replay |
| --- | --- | --- |
| Initialization race | collector precedes hydration; activity reproduced | OFF acknowledgement and OFF readback agree |
| Propagation failure | hydration precedes collector; activity suppressed | OFF acknowledgement followed by ON readback |

This is a temporary deterministic discrimination baseline. A later GPT-5.6 hypothesis manager may select from the same whitelist, but it will not execute arbitrary actions or decide whether verification passed.

### Verification commands and results

| Command | Result |
| --- | --- |
| `npm.cmd run build` | PASS — typecheck, Vite client, and production server bundle |
| `npm.cmd test` | PASS — 10/10 health, manual-demo, ON control, detector, and replay cases across both fixtures |
| `npm.cmd run test:determinism` | PASS — 20/20 fresh-context cases |
| `npm.cmd run verify:promise:race` | EXPECTED FAIL — exit 1 with only `PP_IDENTIFIABLE_EVENT_LEAK` |
| `npm.cmd run verify:promise:propagation` | EXPECTED FAIL — exit 1 with only `PP_PREFERENCE_NOT_PERSISTED` |
| Production smoke for both fixture scripts | PASS — health/configuration JSON and bundled client returned HTTP 200 |
| Retained artifact audit | PASS — six isolated suite directories coexist; both contract traces and all 20 determinism evidence sets retained |

### Five-run record

| Run | Race OFF | Propagation OFF | Race ON | Propagation ON |
| --- | --- | --- | --- | --- |
| 01 | 1 activity pair; state matches; leak only | 0 activity; OFF/OFF/ON; persistence only | PASS | PASS |
| 02 | 1 activity pair; state matches; leak only | 0 activity; OFF/OFF/ON; persistence only | PASS | PASS |
| 03 | 1 activity pair; state matches; leak only | 0 activity; OFF/OFF/ON; persistence only | PASS | PASS |
| 04 | 1 activity pair; state matches; leak only | 0 activity; OFF/OFF/ON; persistence only | PASS | PASS |
| 05 | 1 activity pair; state matches; leak only | 0 activity; OFF/OFF/ON; persistence only | PASS | PASS |

All 20 signatures validated canonical timestamps, contiguous client and backend receipt sequences, independent request/receipt/user correlation, authoritative preference readback, visible nonempty rendered cards, rendered-item/receipt equality, Playwright-observed request order, exact clause results, and zero browser errors. Serialized evidence was also checked to contain neither fixture name.

### Quality findings resolved

- Removed root-cause words from detector-facing run and user IDs.
- Required a witnessed reload before the persistence clause can pass.
- Removed a fallback that previously borrowed missing rendered item IDs from backend receipts.
- Captured preference PUT payloads and responses independently in Playwright.
- Made the evidence panel distinguish UI, stored, and backend choices and display `MATCH` or `MISMATCH`.
- Renamed the timeline to “Observed event order” so it remains factual for both failures.
- Avoided a self-reporting persistence flag; an acknowledgement alone cannot prove durable state.
- Began OFF observation immediately before the click so no post-opt-out traffic is discarded.
- Correlated preference request target, response user, receipt user, and authoritative readback user.
- Corroborated the client timeline with independent Playwright request ordering.
- Required every feed card to be visible with a nonempty title and description.
- Scoped the UI counter to activity after the latest OFF receipt, so demo retakes do not mix legitimate earlier ON activity into the finding.
- Assigned separate output directories to both green suites, both determinism suites, and both expected-red contracts so sequential commands retain every artifact.
- Reused identical opaque identifier shapes under separately launched fixtures.

Future model input is explicitly allowlisted to normalized evidence, deterministic clause results, registered replay descriptions, and replay reports. Operator health/configuration data, environment values, logs, screenshots, videos, and traces remain available to humans but are excluded from model input because they can reveal the fixture.

### Known limitations

- State and evidence remain in memory and reset with the server process.
- Fixture selection requires starting the corresponding named development/test script.
- The synthetic recorder, preference API, and recommendation API share one origin; independent Playwright capture remains the external observation point.
- Only Windows x64 has been verified.
- GPT-5.6 hypothesis management, Codex worktree repair, human diff approval, and repaired-state Playwright verification remain deferred.
- Submission hosting, licensing choice, and demo-video packaging remain future work.

### Next smallest milestone

Add GPT-5.6 hypothesis management for the two existing evidence signatures. The model may maintain ranked hypotheses and select exactly one registered replay; deterministic code must validate the selection, execute the replay, and retain verdict ownership. Keep Codex repair deferred until this investigation loop is deterministic.
