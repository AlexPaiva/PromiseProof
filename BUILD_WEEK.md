# PromiseProof Build Week Log

## Project baseline — 2026-07-14

PromiseProof begins as a new OpenAI Build Week project. `AGENTS.md` is the canonical product and engineering specification.

### Decisions

- Enter the Developer Tools track as a solo entrant.
- Prove one narrow, observable promise before expanding scope.
- Keep verdict ownership deterministic: models may investigate and later propose
  repairs, but their schemas do not contain an overall-verdict field; only the
  deterministic evaluator and Playwright can establish verification success.
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

## Project audit and Milestone 03 handoff — 2026-07-14

### Audited status

Milestone 02 is complete and is the current deterministic foundation:

- Both strict server-selected defects are implemented.
- The same unchanged OFF contract fails with one distinct stable code per defect.
- The shared ON control passes through a real activity HTTP boundary in both fixtures.
- Green health, manual-demo, detector, control, and replay suites passed 10/10.
- Five fresh OFF and five fresh ON contexts per fixture passed 20/20 structural checks.
- Both production fixture scripts returned healthy API responses and bundled pages.
- Six isolated local artifact directories retain both expected-red traces and all
  determinism evidence sets.

The retained artifacts are intentionally ignored generated output. A fresh clone
can reproduce them with the documented commands, but they are not part of the Git
history or a submission bundle yet.

### Full architecture still outstanding

The completed work covers Playwright journey execution and deterministic evidence
collection/evaluation. The remaining canonical architecture is:

1. GPT-5.6 ranked hypotheses and validated whitelisted replay selection.
2. Codex preparation of a minimal source patch and regression test.
3. Repair execution in a disposable Git worktree.
4. A real human diff-approval or rejection gate.
5. Launch of the approved worktree and an unchanged Playwright repair verdict.
6. One retained end-to-end audit bundle for the complete loop.

No OpenAI SDK or runtime API call exists yet. The current deterministic replay
selector is a test oracle and temporary baseline, not the final model-driven
investigation path.

### Trust-boundary findings to preserve

- Enforce the future model-input allowlist in code; documentation alone is not a
  security boundary.
- Never expose fixture mode, configuration, environment, source, logs, or media
  to GPT-5.6 before replay selection.
- Validate model output at runtime and reject arbitrary actions or replay IDs.
- Keep the canonical evaluator and contract outside model and repair write scope.
- The contextual endpoint currently receives an opaque test run header. It is
  not a user ID or activity payload, but final hardening should either prove it
  non-identifying or move correlation into the external observer.
- The logical product, services, and recorder share one process; independent
  Playwright network capture remains the current trust anchor.
- Browser/API response evidence is TypeScript-cast in several places. Introduce
  versioned runtime schemas before consuming it as model input.

### Submission readiness

The canonical publication target is
`git@github.com:AlexPaiva/PromiseProof.git`. A hosted demo, license, CI, narrated
video, and final judge command remain outstanding. Only Windows x64 and Chromium
have been verified. The project description and reproducible setup exist in
draft form, but submission packaging must wait until the canonical
investigate-repair-approve-verify loop works.

The core implementation was produced in this continuing Codex task. Preserve
this task for the organizer-requested feedback/session identifier.

### Milestone 03 acceptance boundary

Build the GPT-5.6 investigation layer only:

- Construct a versioned allowlisted investigation dossier.
- Request structured ranked hypotheses and exactly one replay ID.
- Reject malformed output and non-whitelisted actions deterministically.
- Execute one registered replay and append its factual report.
- Keep the loop bounded, auditable, and unable to declare a contract pass.
- Provide deterministic offline provider tests and a separate live smoke command.
- Record cost/token and latency metadata without recording the API key.

Codex repair, worktree mutation, and human approval remain the following
milestone so that model investigation can be stabilized independently.

## Milestone 02 deterministic-foundation checkpoint — 2026-07-14

Before model integration, the complete published foundation was rerun from a
clean worktree. `HEAD` was `752866d`, a documentation-only successor to the
Milestone 02 implementation commit `e8d49f8`; every frozen implementation file
matched `e8d49f8` exactly.

### Fresh checkpoint results

| Command | Fresh result |
| --- | --- |
| `npm.cmd run build` | PASS — strict typecheck plus client and server bundles |
| `npm.cmd test` | PASS — 10/10 green cases across both fixtures |
| `npm.cmd run test:determinism` | PASS — 20/20 fresh browser contexts |
| `npm.cmd run verify:promise:race` | EXPECTED FAIL — exit 1, only `PP_IDENTIFIABLE_EVENT_LEAK` |
| `npm.cmd run verify:promise:propagation` | EXPECTED FAIL — exit 1, only `PP_PREFERENCE_NOT_PERSISTED` |

Both direct expected-red runs retained schema-version-2 normalized evidence,
an attached evidence copy, screenshot, video, Playwright trace, error context,
and a `.last-run.json` containing exactly one failed test.

### Automated expected-red guard

Added `npm run test:expected-red`, a green cross-platform wrapper around the two
unchanged canonical verifiers. It deletes only each known ignored output
directory before execution, runs the fixtures sequentially, and accepts a run
only when all of these hold:

- The child exits exactly `1` without a signal or spawn error.
- Terminal output contains exactly the expected singleton `PP_` code.
- Playwright reports status `failed` with exactly one failed test.
- Exactly one primary and one byte-equal attached evidence JSON exist.
- Evidence schema version, deterministic clause, verdict, and single violation
  exactly match the fixture contract.
- Normalized observations contain zero browser errors.
- Evidence and error context contain no unrelated `PP_` code.
- Nonempty screenshot, video, trace, and error-context artifacts exist.

Four offline validator cases prove that the wrapper accepts the complete
expected finding and rejects a crash-like exit code, an unrelated extra `PP_`
code, and missing retained media. The real wrapper passed both fixtures and
returned exit `0` while both nested canonical tests independently returned exit
`1`.

The Git tag `milestone-02-deterministic-foundation` identifies this protected
checkpoint. Model integration must not modify the evaluator, contract assertion,
seeded defects, or existing evidence-capture behavior.

## Milestone 03 — bounded GPT-5.6 investigation — live verified — 2026-07-15

### Implemented architecture

Milestone 03 adds a bounded investigation layer around the two existing factual
diagnostic replays. It does not add a general-purpose agent and does not change
the deterministic verdict path.

The implemented sequence is:

1. Parse normalized OFF evidence with a strict runtime schema and call the
   unchanged deterministic evaluator.
2. Build versioned `InvestigationDossierV1` by copying only explicitly
   allowlisted fields.
3. Send the dossier to the Responses API with model `gpt-5.6`, one strict
   function tool named `run_diagnostic_replay`, forced tool choice, and parallel
   tool calls disabled.
4. Require exactly one individually completed function call. GPT-5.6 proposes
   the initial hypothesis titles and evidence in the project-owned opaque slots
   `h1` through `h4`; deterministic code validates the name, JSON shape,
   contiguous confidence-ordered slots/titles, cited evidence IDs, defensive verdict-language
   boundary, and replay ID before recursively freezing the complete accepted
   argument object and executing anything.
5. Dispatch either `inspect_startup_order` or
   `inspect_preference_roundtrip` through a closed branch to the already
   implemented Playwright/API replay. There is no default or arbitrary command
   execution path.
6. Normalize the factual replay report and return it through one
   `function_call_output` continuation tied to the first response and call IDs.
7. Require a strict `InvestigationResultV1` containing the same hypothesis IDs,
   relative model confidence estimates, replay-cited evidence/status updates,
   `mostLikelyHypothesisId`, the replay performed, conclusion evidence, and
   exactly the ordered `single_replay_scope`, `synthetic_evidence_scope`, and
   `diagnostic_not_verdict` limitation codes. The final schema contains neither
   hypothesis titles, model-authored caveats, nor a free-form cause/verdict
   field; deterministic code retains the original model-proposed titles and
   renders fixed project-owned limitation prose.
8. Reject a final response that changes hypothesis or replay identity, selects a
   leading ID other than the first maximum-confidence hypothesis, cites unknown
   facts, fails to place replay citations in the required status-specific arrays
   and the leading hypothesis's supporting array, returns a live model identity other than
   `gpt-5.6` or `gpt-5.6-sol`, repeats or overlaps evidence references, returns a
   refusal/incomplete/error response or any final output other than one
   individually completed message containing one `output_text` item plus absent
   or completed reasoning, or attempts to place reserved outcome language in the
   initial diagnostic prose. The accepted final result is recursively frozen.

The runner hard-codes a maximum of two provider calls and one replay execution.
A rejection or provider/replay failure terminates the loop; no fallback replay,
second tool round, or unvalidated execution is attempted.

Structural output-item validation observes the complete response shape and each
item's completion status. Any second function call, extra message, refusal,
incomplete reason, provider error, incomplete item, unexpected content part, or
unexpected output kind terminates the loop without dispatching another replay.

### Exact model-input boundary

The dossier payload supplied as evidence in the first model request contains
only:

- dossier version and canonical OFF promise statement;
- the three deterministic clause IDs, descriptions, expected values, observed
  values, and boolean clause results;
- stable deterministic violation codes;
- UI preference and toggle state;
- browser-storage preference;
- backend preference;
- total and identifiable activity request/receipt counts;
- recommendation mode, item count, and feed-functionality flag;
- an ordered list of allowlisted event names;
- sanitized evidence-reference IDs and descriptions; and
- the two registered replay IDs and descriptions.

The second request continues the first response. Its only new evidence payload
is the normalized factual report from the one executed replay plus its sanitized
evidence references. Raw `PromiseEvidence`, replay journey objects, and
identity-bearing requests remain on the deterministic side of the boundary.

The model boundary excludes fixture selection and root-cause labels,
configuration and health contents, environment variables, run/user IDs, source
paths and source code, server logs, screenshots, videos, and Playwright traces.
The exact first and second request objects are serializable in the unit suite so
this exclusion can be tested as an executable boundary rather than a prompt
convention.

### Runtime contracts and authority boundary

- Zod strict schemas reject unknown properties in the dossier, function
  arguments, replay reports, and final result.
- The only accepted tool name is `run_diagnostic_replay`; its `replayId` is a
  shared two-value enum.
- Initial and final evidence citations must resolve to dossier or executed-replay
  references. Model-supplied reference arrays must be duplicate-free, and each
  hypothesis's supporting and contradicting reference sets must be disjoint.
- Multiple calls, malformed JSON, unexpected or incomplete response output items, invalid
  metadata, non-contiguous ranks, dangling references, a second replay, and
  malformed replay reports are deterministic rejections.
- Initial hypothesis titles are proposed by GPT-5.6 inside the deterministic
  opaque slots `h1` through `h4`, validated once, and retained inside a
  recursively frozen accepted argument object as the immutable identity
  baseline. The recursively frozen final result can only update the
  existing IDs with relative confidence, status, and evidence references; it
  cannot rename a hypothesis or return a free-form cause.
- `mostLikelyHypothesisId` must resolve to the first maximum-confidence final
  hypothesis. Its status must be `supported` and cite supporting replay facts.
- Every final `supported` status must cite supporting replay evidence, and every
  `weakened` status must cite contradicting replay evidence. Confidence movement
  alone does not count as a material causal update. This is a deterministic
  citation-placement check, not proof that model-authored hypothesis prose is
  semantically entailed by the cited fact.
- Confidence integers are relative model estimates, not calibrated
  probabilities.
- Live selection and conclusion metadata must identify exactly `gpt-5.6` or the
  documented resolved `gpt-5.6-sol` model; arbitrary suffixes are rejected. The
  deterministic offline provider retains its distinct nonempty model identity.
- The final result schema has no overall verdict or model-authored prose field.
  It carries the complete canonical limitation-code sequence, which project
  code maps to fixed prose. Reserved pass/fix/approval/compliance phrases remain
  a defense-in-depth check on the model-authored initial diagnostic content,
  but only the unchanged TypeScript evaluator and Playwright contract own the
  promise verdict.
- Startup replay validation recomputes the first collector/hydration indices and
  startup/network ordering flags from their event arrays. Preference replay
  validation recomputes consistency from acknowledgement and authoritative
  readback. Internally contradictory factual reports are rejected.

### Providers, commands, and artifacts

The ordinary suite uses a deterministic offline provider that sees the same
allowlisted dossier and replay-output boundary as the live provider. It records
its exact inputs, uses zero token metadata, and makes no network request. The
OpenAI provider performs API calls only during explicit live commands and reads
`OPENAI_API_KEY` from the current environment or ignored `.env.local`.

Relevant commands are:

```text
npm run test:investigation:unit
npm run test:investigation:offline
npm test
npm run investigate:live:race
npm run investigate:live:propagation
npm run investigate:live:stability
```

The versioned investigation artifact records the sanitized dossier and its
SHA-256 digest, provider kind, requested/returned model IDs, response IDs and
statuses, latency, per-response and aggregate input/cached/output/reasoning/total
token usage, provider/replay bounds, validation decisions, tool call ID,
sanitized initial output, normalized factual replay report, strict final output,
deterministic limitation codes, final output-shape decision, failure code, and
total timing. It never records the API key.

The live provider deliberately sends `store: true` for both calls so the second
call can continue the first with `previous_response_id`. OpenAI retains stored
Response objects for 30 days by default. This milestone sends only the sanitized
synthetic dossier and normalized synthetic replay report; real customer data
would require a separately designed storage and retention policy.

### Verification status

All non-credit checks below were freshly produced from the Milestone 03 working
tree. The no-key fail-closed path was exercised first. After the credential was
placed only in ignored `.env.local`, both live smokes and the strict 3+3
stability gate passed; the detailed live record follows this table.

| Command or check | Status |
| --- | --- |
| `npm.cmd run build` | PASS — strict typecheck, client bundle, and server bundle after authority hardening |
| Fresh `npm.cmd ci` followed by build/offline investigation | PASS — 110 packages restored from lockfile, 0 vulnerabilities, build and both browser investigations green |
| Production bundle smoke, race mode | PASS — `/` returned 200 and `/api/health` returned `ok: true`, `initialization-race` |
| Production bundle smoke, propagation mode | PASS — `/` returned 200 and `/api/health` returned `ok: true`, `propagation-failure` |
| `npm.cmd run test:investigation:unit` | PASS — 10/10 adversarial provider-boundary groups after second hardening |
| `npm.cmd run test:live-stability:unit` | PASS — 10/10 no-network retained-proof and filesystem-verifier groups |
| `npm.cmd run test:investigation:offline` | PASS — 10/10 provider groups, 10/10 receipt-verifier groups, and both real-browser investigations |
| `npm.cmd test` | PASS — 20/20 unit groups plus 6/6 race and 6/6 propagation browser cases |
| `npm.cmd run test:determinism` | PASS — 20/20 unchanged fresh-context cases after authority hardening |
| `npm.cmd run test:expected-red` | PASS — race leak code only; propagation persistence code only; complete artifacts after authority hardening |
| `npm.cmd audit --audit-level=moderate` | PASS — 0 vulnerabilities |
| Frozen evaluator/contract/defect hash comparison | PASS — seven protected files match the Milestone 02 checkpoint; recorded SHA-256 values unchanged |
| `git diff --check` | PASS — no whitespace errors; only the known `AGENTS.md` CRLF-to-LF warning |
| Exact serialized model-input leakage assertions | PASS — first and second requests excluded every seeded sentinel and forbidden key/value class |
| `npm.cmd run investigate:live:race` | PASS — first paid smoke; `gpt-5.6-sol`; startup replay; leading `h1` supported by all startup replay facts |
| `npm.cmd run investigate:live:propagation` | PASS — first paid smoke; `gpt-5.6-sol`; preference-roundtrip replay; leading `h1` supported by all round-trip facts |
| `npm.cmd run investigate:live:stability` | PASS — fresh source-bound race 3/3 plus propagation 3/3; aggregate verifier wrote the sanitized receipt |
| Sanitized receipt | PASS — 6 investigations, 12 unique response IDs, exact signatures/usage/source binding, and no credential retention |

The ten adversarial test groups cover exact request serialization with network
disabled, strict outbound reparsing, strict schemas, unknown/zero/multiple tool
calls, unexpected or incomplete response output items, unknown replay IDs, unexpected
arguments, invalid JSON/ranks/metadata/evidence references, accepted and
rejected live model identities, missing live usage, sanitized provider failures,
defensive outcome-language synonyms, zero execution after rejection, a
one-replay execution cap, malformed or internally inconsistent replay reports,
hypothesis/replay identity mismatch, invented leading IDs, an incorrect leading
ID, attempted title or free-cause fields, dangling final references, uncited
supported/weakened statuses, and failure to materially update hypotheses. The
allowlisted dossier and normalized replay
output are deeply frozen before they cross the provider boundary. The complete
accepted first-call argument object and accepted final result are also deeply
frozen before the runner or artifact can retain them.

The offline and live browser investigation specifications now assert that the
initial observed journey recorded zero browser errors. The browser-backed
startup-order replay also fails before report normalization if its diagnostic
journey records a browser error. The preference-roundtrip replay is API-only and
therefore has no browser-error channel.

The harmless Node warning about `NO_COLOR` being ignored while `FORCE_COLOR` is
set is emitted by the local test environment; the application/browser suites
reported no console errors.

### Authority-hardening pass — 2026-07-15

A red-team review found that a finite phrase blacklist could not support the
earlier broad claim that model prose was incapable of declaring success. The
deterministic evaluator was never bypassed, so this was not a false-green path,
but the model-output boundary and documentation were strengthened before any
live API spend:

- GPT-5.6 still proposes the initial causal hypothesis titles and evidence.
  Deterministic validation prescribes opaque IDs `h1` through `h4` by rank and
  preserves the IDs, titles, order, and replay request as the continuity baseline.
- The final schema no longer accepts hypothesis titles or the free-form
  `mostLikelyCause` field. It accepts only the existing IDs, relative confidence,
  status/evidence updates, `mostLikelyHypothesisId`, replay identity, conclusion
  references, and the three canonical limitation codes. Fixed project-owned
  prose replaces model-authored caveats.
- The leading ID must be the first maximum-confidence hypothesis and must be
  `supported` by a supporting reference from the executed replay.
- Every non-`unresolved` status is checked against the corresponding replay
  evidence list. A confidence-number change alone is insufficient.
- Both live response phases accept only exact `gpt-5.6` or documented resolved
  `gpt-5.6-sol` identities. Offline provider identity remains independently
  accepted for network-free tests.
- The exact outbound dossier and replay report are strictly reparsed immediately
  before serialization, closing a future unsafe-cast path.
- Reserved success/fix/approval/compliance prose checks remain as defense in
  depth and gained adversarial synonym coverage; the structural schema and
  unchanged deterministic evaluator remain the real authority boundary.

### Second red-team hardening — 2026-07-15

A second adversarial review found no route to a false Playwright pass, arbitrary
replay execution, fixture leakage, or API-key exposure, but identified six
boundary claims that needed stronger executable enforcement before live API use:

- accepted initial arguments and the accepted final result are now recursively
  frozen, including nested arrays and objects;
- free-form final caveats were replaced by three required ordered limitation
  codes and a deterministic code-to-prose mapping;
- the provider now exposes structural summaries for every output item plus
  refusal, incomplete, and error presence; validation requires an individually
  completed function call and exactly one individually completed final message
  with one `output_text` part, so a second call or partial item is visible and
  rejected;
- live returned-model validation now accepts only exact `gpt-5.6` or documented
  resolved `gpt-5.6-sol`;
- model-supplied reference arrays must be unique, and supporting/contradicting
  sets must be disjoint within each initial and final hypothesis; and
- startup indices/order flags and preference-roundtrip consistency are checked
  against the report fields from which they are deterministically derived.
- response and call IDs are bounded to a safe identifier form, token totals must
  exactly equal input plus output, opaque hypothesis IDs cannot carry verdict
  prose, and provider failures are projected twice onto four safe fields.

These changes do not broaden the milestone or alter the deterministic promise
verdict. Live outcomes were held unclaimed until the explicit gates ran with a
separately supplied API key; the verified record is below.

Fresh hardening verification produced 10/10 passing provider-boundary groups,
10/10 passing retained-proof-verifier groups, and both passing browser
investigations through `npm.cmd run test:investigation:offline`. The
investigation browser paths now
assert zero observed browser errors, and the startup-order replay rejects a
browser-error-bearing diagnostic journey. The final broader checkpoint also
passed: build; 10/10 unit plus 6/6 race and 6/6 propagation ordinary tests; 20/20
determinism; both exact expected-red signatures and artifacts; the seven-file
frozen-foundation comparison; and the zero-vulnerability moderate audit. This
was the pre-live checkpoint; the subsequent live acceptance did not change the
protected foundation.

### Live-stability retained-proof hardening — 2026-07-15

Before spending API credits, the repeated-live command gained an independent
aggregate acceptance gate. It now removes any stale green receipt and both prior
stability-output cohorts, then captures a canonical pre-run digest over
executable source, tests, scripts, package files, and build/test configuration,
and requires the same digest after all six runs.
Race and propagation repetitions use isolated output directories and must each
leave a clean Playwright `.last-run.json` plus exactly three distinct full
artifacts with the exact expected basename outside attachment-copy directories.

The verifier strictly reparses every retained artifact and independently checks
the exact 28 accepted validation decisions; response and output-item shapes;
positive and internally consistent token use; finite latency and timing;
singleton defect signatures and factual replay reports; initial ranking and
dossier grounding; final hypothesis continuity, replay citations, and leading
ID; limitation codes; cohort hashes; unique investigation/response IDs; and
fixture, credential, local-path, and verdict-language exclusion. It writes only
an atomic sanitized projection to `artifacts/milestone-03-live-stability.json`.
Canonical hashes are explicitly consistency checks, not provider attestation.

A final independent red-team initially found that deleting only the receipt and
snapshot would let the standalone verifier reuse old successful cohorts. The
preflight now recursively deletes both cohort directories too; a targeted unit
test seeds stale passed outputs and proves they are gone before the source
snapshot is captured. The reviewer re-audited the fix and reported no remaining
P0/P1 issue in the temporal-binding path.

The new no-network verifier suite passed 10/10 adversarial groups, including a
valid synthetic 3+3 cohort, cardinality/identity tampering, wrong defect and
replay signatures, malformed provider/timing/usage fields, altered ranks and
validation decisions, fixture/key/verdict leakage, exact artifact discovery,
stale-receipt/cohort removal, pre/post source mismatch, and an end-to-end atomic
receipt write. The complete fresh matrix then passed: build; 20/20 unit groups;
both offline browser investigations; 6/6 race and 6/6 propagation ordinary browser
cases; 20/20 deterministic contexts; both exact expected-red signatures with
complete evidence; seven unchanged protected hashes; `git diff --check`; and a
zero-vulnerability moderate dependency audit. Both single live commands and the
aggregate stability command fail closed before server/API use when the key is
absent. They subsequently passed with the ignored credential, as recorded next.

### Live GPT-5.6 acceptance — 2026-07-15

Both paid smoke investigations passed on their first attempt. The earlier
missing-key executions were intentional zero-request boundary checks, not failed
paid investigations.

- Race smoke: investigation `10702fc3-a0dd-40da-b566-067bebb07dd0`;
  `inspect_startup_order`; leading `h1` supported; returned model
  `gpt-5.6-sol` twice; response IDs
  `resp_00e302531917885c006a572f965288819381bc705d09b26289` and
  `resp_00e302531917885c006a572fa09f648193b0986abcb5bd4bbf`; 3,898 total
  tokens; 15,082.922 ms summed provider latency; dossier SHA-256
  `5b00ab36a0aee62666c9907003f1521496c485ec8bf9a78b79b069ed0547172a`.
- Propagation smoke: investigation `aa19f3b2-d7b9-4f91-bf1e-d93517e445c4`;
  `inspect_preference_roundtrip`; leading `h1` supported; returned model
  `gpt-5.6-sol` twice; response IDs
  `resp_0b8c6597206d2da8006a572ff85a988193a5ce7c9705b320ae` and
  `resp_0b8c6597206d2da8006a573000e8888193be05a5941fdb4d04`; 3,846 total
  tokens; 13,920.318 ms summed provider latency; dossier SHA-256
  `bbed3cbdff16bdb6923ff599ece0e8ce207cdf57899e2f6acb32a59e8c3c18a0`.

After manual inspection, `npm.cmd run investigate:live:stability` removed old
cohorts, captured the execution-source snapshot, ran race 3/3 and propagation
3/3, required both clean Playwright run markers, revalidated all six complete
artifacts, confirmed the post-run source snapshot, and atomically wrote
`artifacts/milestone-03-live-stability.json`.

The receipt records three `inspect_startup_order` selections and three
`inspect_preference_roundtrip` selections, six supported replay-cited leading
IDs, twelve unique `gpt-5.6-sol` response IDs, 18,847 input tokens including
5,944 cached, 4,871 output tokens including 1,061 reasoning, 23,718 total
tokens, and 87,842.468 ms summed provider latency. Its source manifest covers 64
files with digest
`3de910ab131c54389f0583cfcb11ddfe37e6abeafc17b48db95ed41a169f5a50`.
The receipt file SHA-256 is
`1a28dade48671e05e81dd07525f7a6a0c2da312a2cea8d574fc5ba86c6b90b57`.

Across both smokes and stability, the complete exercise contains eight
investigations, sixteen unique Responses, 25,078 input tokens including 5,944
cached, 6,384 output tokens including 1,359 reasoning, 31,462 total tokens, and
116,845.708 ms summed provider latency. All eight returned `gpt-5.6-sol`; every
run chose the defect-appropriate replay. The model never supplied the product
verdict, and no credential was found in either smoke artifact, any stability
artifact, or the aggregate receipt.

### Frozen foundation and deferred work

Milestone 03 must preserve the evaluator, unchanged OFF contract assertion,
both seeded defects, existing evidence capture, and the two existing replay
implementations. A model response is investigation evidence, never a replacement
for the canonical evaluator.

The following remain explicitly out of scope: Codex patch generation,
regression-test preparation, disposable Git worktrees, human diff approval,
repaired-state execution, a same-process architecture refactor, other browsers
or mobile coverage, immutable external logging, comprehensive accessibility
work, JUnit or artifact-upload infrastructure, correlation-header redesign, a
generic contract framework, CI, hosting, a visual redesign or architecture
diagram, and any second product promise.

With both single live investigations and their three-run stability checks now
recorded, the smallest next milestone is Codex preparation of one minimal source
patch and regression test in a disposable worktree, followed by a real human
approval gate and the unchanged Playwright verdict. It begins only after this
Milestone 03 evidence is committed, tagged, and pushed.

## Milestone 04 — bounded Codex repair infrastructure

Milestone 03 was committed as `65a5dd6a0bb23465b776c2010c1d8e6048ac46b0`,
tagged `milestone-03-gpt56-investigation`, and pushed before repair work began.
Milestone 04 supports only the initialization-race journey. The propagation
failure remains deliberately broken and must continue producing only
`PP_PREFERENCE_NOT_PERSISTED` during repaired-state verification.

### Repair eligibility and frozen authority

Repair eligibility is derived deterministically from the committed Milestone 03
3+3 live-stability receipt, read from the frozen commit rather than the current
checkout. It requires the exact race signature, `PP_IDENTIFIABLE_EVENT_LEAK`,
`inspect_startup_order`, one request and receipt, collector-before-hydration and
activity-before-preference-read facts, stable dossier identity, unique response
and investigation IDs, six allowlisted completed GPT-5.6 responses, and no
model-owned verdict.

The repair runner verifies that its base descends from the exact Milestone 03
tag and that every base change is repair infrastructure. Critical evaluator,
contract, application, defect, replay-binding, investigation, scenario, and
live-receipt blobs must remain byte-identical to the frozen checkpoint. The
retained state binds this foundation manifest to the exact base commit and tree.

### Candidate-generation boundary

The live provider uses pinned `@openai/codex-sdk` and CLI version `0.144.4`, one
`gpt-5.6-sol` thread, one turn, high reasoning effort, `workspace-write`, no
approval adapter, no network or web search, no MCP/apps/subagents/hooks, an
isolated `CODEX_HOME`, and a scrubbed command environment. Unknown top-level SDK
events, unknown or forbidden item types, failed commands, path escapes, secret
values, multiple turns/messages, excess events/bytes, and authoritative final
claims fail closed. The model's final JSON is a bounded activity summary, never
a pass result. Immediately after that sanitized result is accepted, the isolated
Codex home and tool-temporary directories are safely removed; raw session,
prompt, reasoning, and CLI-log state is not retained through human review.
Candidate baseline and repaired-state commands also use fresh empty npm user and
global configuration files, a disposable npm cache, a fixed public registry,
and an environment that does not inherit API keys, auth tokens, npm credentials,
or proxy credentials. The complete command runtime is removed after each phase.

Only two unstaged paths may differ:

- `src/client/main.ts` as one tracked modification; and
- `tests/regression/initialization-order.spec.ts` as one new regular file.

The patch is limited to 32 KiB and 160 changed lines, rejects staged, ignored,
binary, mode, rename, delete, symlink, hard-link, Unicode-direction, terminal
control, and unexpected-path content, and is validated twice before retention.
The source edit is confined to the startup-race branch body: a truthful status,
preference hydration, then collector startup. This is a deliberately narrow
causal repair policy, not a claim of general autonomous source repair.

The new regression is parsed as TypeScript before execution. It may import only
`expect`/`test` from Playwright and the existing scenario helper, execute exactly
one literal OFF journey, derive the two event indices directly from the captured
timeline, and make direct hard assertions for event order, browser errors,
activity requests and receipts, the unchanged evaluator, reload, and contextual
recommendations. Filesystem, process, network, dynamic-code, interception,
fixture-label, skip/only/fixme, assignment, control-flow, and comment-only
assertion bypasses are rejected.

### Human and verification boundaries

The candidate runs outside the main checkout. Its complete retained patch is
UTF-8/control checked again immediately before display. Production review
accepts no injected stream, pipe, flag, or automatic adapter: both stdin and
stdout must be real TTYs, and the operator must type exactly `APPROVE` or
`REJECT` followed by the full repair UUID and full patch SHA-256. The immutable
decision record binds the exact phrase digest, repair ID, patch digest, and byte
count. A valid retained decision is reconciled idempotently after an interrupted
write without prompting for a different decision.

Approval never applies the patch to `main`. Verification creates a second fresh
detached worktree, freshly installs with `npm ci --ignore-scripts`, applies the
exact retained digest, and revalidates the two-file policy. It then runs, on an
isolated loopback port: build; canonical race OFF and ON once; race OFF five
times; race ON five times; the propagation expected-red contract; all six
propagation green cases; and finally the AST-bounded startup regression. The
model-authored regression runs last. Playwright JSON discovery, run markers,
fresh artifact times, evidence copies, canonical runtime schemas, and the
deterministic evaluator are independently checked. The seeded race expected-red
test is intentionally not reused as repaired acceptance because it asserts the
presence of the original defect.

Lifecycle events are SHA-256 chained with explicit legal transitions. Patch,
approval, command, artifact, success, and failure receipts are retained before
cleanup. Interrupted approval, verification, evidence-finalization, and cleanup
windows reconcile without duplicate lifecycle events; a pre-PASS interruption
is conservatively retired, while a valid retained deterministic PASS receipt is
preserved as PASS during cleanup recovery. Both candidate and verification
checkout paths are planned as exact UUID locations and persisted before their
directories are materialized, closing the crash window in which Git could retain
an unknown disposable checkout. Recovery safely distinguishes an absent intent,
an empty owned UUID root, and a registered materialized worktree.

The PASS receipt path and SHA-256 are persisted before the lifecycle advances to
`verification_passed`. Restart recovery rehashes the exact regular receipt,
revalidates its repair/base/patch/check sequence, and compares its evidence
manifest with the retained verification files. A shape-compatible post-PASS
receipt mutation fails closed and cannot be recovered as authoritative PASS. A
stale orchestration lock can be
removed only by an explicit command after its strict record is old enough and
its PID is confirmed dead. Missing checkout directories cannot be called clean
while Git still registers their worktrees.

### Current checkpoint

No live Codex repair candidate has been requested, no candidate diff has been
approved, no patch has been applied to `main`, and no repaired-state PASS is
claimed in this infrastructure checkpoint. The production approval boundary
will stop on the first unseen live diff for Alex's real human review.

The infrastructure checkpoint was committed as
`8211db42dd111e0d8cb3d5998436532205800137` and pushed to `origin/main` before
the complete offline journey ran. It passes `npm.cmd run build` and all 87/87
repair tests. Those tests include the SDK event/provider boundary,
eligibility, lifecycle and approval immutability, exact PASS-receipt anchoring,
post-anchor tamper rejection, four interrupted preparation states, interrupted
verification and cleanup recovery, absent/empty/materialized worktree intents,
nonempty/malformed/registered-intent rejection, repository-bound local state,
repair-role-bound UUID paths, inherited Git-redirection rejection, fresh
second-worktree verification, command-environment credential isolation,
the TypeScript regression firewall, Git/ref/path boundaries, patch limits, and
adversarial bypasses.

The clean-HEAD checkpoint then passed the complete deterministic repair and
regression matrix:

| Command | Result |
| --- | --- |
| `npm.cmd run test:repair:offline` | PASS — 87/87 repair boundary tests plus one complete two-worktree browser journey; the deterministic test provider repaired only the race, the second fresh worktree passed every repaired-state gate, cleanup completed, and `main` remained unchanged |
| `npm.cmd test` | PASS — 10/10 investigation units, 10/10 live-receipt verifier units, 87/87 repair tests, 6/6 race browser cases, and 6/6 propagation browser cases |
| `npm.cmd run test:determinism` | PASS — 20/20 unchanged fresh-context cases: five OFF and five ON for each seeded defect |
| `npm.cmd run test:expected-red` | PASS — 4/4 wrapper adversarial tests; race produced only `PP_IDENTIFIABLE_EVENT_LEAK`, propagation produced only `PP_PREFERENCE_NOT_PERSISTED`, and both retained complete expected-red evidence |
| Frozen Milestone 03 `npm.cmd run verify:investigation:live-stability` | PASS — rerun at commit `65a5dd6` with the original retained synthetic evidence and a non-secret verification sentinel; the verifier reproduced the committed sanitized receipt exactly |
| `npm.cmd run build` | PASS — strict typecheck, Vite client bundle, and production server bundle after the offline journey |
| `npm.cmd audit --audit-level=moderate` | PASS — 0 vulnerabilities |
| Repository integrity | PASS — clean `main`, local and remote at the same commit, one registered worktree, and `git fsck --no-dangling` clean |

The original Milestone 03 stability command is a live-cohort finalizer, not a
cross-milestone receipt checker. Invoking it directly at the Milestone 04 HEAD
correctly failed closed with `PP_LIVE_STABILITY_INVALID: Execution sources
changed after the live-stability preflight` because the snapshot deliberately
covers every file below `src`, `tests`, and `scripts`. It removes the prior
output receipt before recomputation, so the exact committed receipt was restored
byte-for-byte from `HEAD`. The isolated frozen-commit rerun above is the valid
receipt reproduction. Windows required explicit long-path cleanup for the
copied Playwright evidence after Git deregistered that temporary checkout; no
temporary worktree, source change, or receipt drift remains.
