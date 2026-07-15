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

## Current milestone — Milestone 03 live-verified checkpoint

Milestone 03 passed both manually inspected live smokes and its strict three-run
stability cohort per defect. Preserve and checkpoint only the verified bounded
investigation described below. Update its evidence record, rerun the final
verifier, explicitly stage reviewed files, commit, tag, and push. Do not begin
Milestone 04 repair work until this checkpoint exists.

The verified Milestone 03 invariants are:

1. Preserve the unchanged evaluator, OFF contract, seeded defects, evidence
   capture, and two existing factual replays.
2. Build initial `InvestigationDossierV1` only from normalized evidence,
   deterministic clause results, stable violation codes, and registered replay
   descriptions. Add the normalized replay report only to the second response
   continuation. Strictly reparse each allowlisted object at the outbound request
   builder before canonical serialization.
3. Make the first GPT-5.6 Responses API call expose exactly one strict function,
   `run_diagnostic_replay`, with only `inspect_startup_order` and
   `inspect_preference_roundtrip` accepted as replay IDs.
4. Require exactly one individually completed function call. GPT-5.6 proposes
   the initial ranked hypothesis titles and evidence; deterministic code owns
   the opaque ordered identity slots `h1` through `h4` and validates the
   function name, strict arguments, titles, evidence references, and replay ID before
   recursively freezing the complete accepted argument object and executing
   anything. Both live responses must identify either the requested `gpt-5.6`
   alias or its documented resolved model, `gpt-5.6-sol`; the offline provider
   retains its separate deterministic identity.
5. Use a closed deterministic dispatcher to execute exactly one validated
   existing replay. Reject unknown tools, unknown IDs, unexpected arguments,
   multiple replay requests, malformed reports, and a second replay round.
6. Make the second and final GPT-5.6 response return strict
   `InvestigationResultV1`: the existing hypothesis IDs with relative model
   confidence estimates, replay-cited statuses and evidence references,
   `mostLikelyHypothesisId`, replay performed, conclusion evidence, and
   exactly the ordered limitation codes `single_replay_scope`,
   `synthetic_evidence_scope`, and `diagnostic_not_verdict`. Project-owned code
   maps those codes to fixed prose; the model cannot author caveats. It must not
   return rewritten hypothesis titles, a free-form cause, or a verdict. The
   accepted final object is recursively frozen.
7. Record a sanitized versioned artifact containing the frozen initial
   hypothesis IDs/titles, final ID-linked updates, selected replay, factual
   replay result, model/response IDs, token usage, latency, bounds, and
   validation decisions. Never record the API key.
8. Verify deterministic provider and exact serialized-input leakage tests
   without credits or network, then run the separately invoked live smoke path
   only when `OPENAI_API_KEY` is explicitly available.
9. After manually inspecting one correct live smoke per defect, run three fresh
   repetitions per defect in output directories separate from the smokes. The
   stability command must remove any stale receipt and both prior stability
   output directories, capture the executable source manifest before the first
   paid run, require the same manifest after the last run, require both
   Playwright `.last-run.json` files to report a clean pass, and strictly
   revalidate exactly six artifacts before atomically
   writing `artifacts/milestone-03-live-stability.json`. Canonical hashes are
   consistency checks, not provider-origin attestation. The receipt may contain
   safe IDs, models, usage, latency, factual signature summaries, opaque leading
   IDs, and hashes, but no model prose, local paths, request/response bodies,
   headers, environment values, or credentials.

The loop is bounded to at most two provider calls and one replay execution. The
first call selects a replay; deterministic code validates and executes it; the
second call updates the hypothesis set from its factual report. There is no
third provider turn, arbitrary tool execution, or fallback replay.

The final provider response must contain exactly one individually completed
structured message with exactly one `output_text` content item, plus optional
completed reasoning metadata, with no function call, refusal, incomplete
reason, provider error, or other output kind. Any attempted second tool call is
a deterministic rejection and is never dispatched.

Hypothesis confidence values are relative model estimates, not calibrated
probabilities. A final `supported` hypothesis must cite supporting evidence from
the executed replay, and a final `weakened` hypothesis must cite contradicting
evidence from that replay. Confidence movement alone is not a material causal
update. `mostLikelyHypothesisId` must identify one of the frozen initial
hypotheses, be the first maximum-confidence final hypothesis, carry the
`supported` status, and cite at least one executed-replay reference in its
supporting array. Reference placement is a structural citation check, not a
deterministic proof that model-authored hypothesis prose is semantically true.

Every model-supplied reference array must contain unique IDs. Within each
initial or final hypothesis, supporting and contradicting reference sets must
also be disjoint. Startup replay indices must equal the first matching event
indices, both startup/network ordering booleans must agree with their event
arrays, and the preference-roundtrip consistency flag must agree with its
acknowledgement and authoritative readback.

Initial model input is limited to the dossier version, canonical promise,
deterministic clause descriptions/expectations/observations/results, stable
violation codes, UI state, browser-storage state, backend preference state,
activity counts, recommendation mode/functionality, allowlisted event ordering,
sanitized evidence references, and registered replay names/descriptions. The
second input adds only the normalized report and references from the one
executed replay.

The boundary must exclude fixture selection and root-cause labels,
configuration and health contents, environment variables, identity-bearing
run/user values, source paths and code, server logs, screenshots, videos, and
Playwright traces. GPT-5.6 may investigate, propose the initial hypothesis
titles, select a replay, and update those hypotheses from replay facts.
Deterministic code prescribes and freezes the accepted opaque IDs and titles,
and the final schema has no
field through which the model can return an overall pass, fixed, approval, or
compliance verdict. The final schema also contains no model-authored limitation
prose: artifacts store the three canonical codes and consumers render a fixed
deterministic mapping. Defensive prose validation remains in place for the
model-authored initial hypotheses and replay purpose, but verdict ownership is
structural: deterministic TypeScript and Playwright alone retain it.

The live provider deliberately uses `store: true` so the second Responses API
call can continue the first. OpenAI retains stored Response objects for 30 days
by default. Only the sanitized synthetic dossier and normalized synthetic replay
report may cross that boundary in this milestone; use with real customer data
would require a separately designed storage and retention policy.

The current product uses only its built-in synthetic Signal Shelf sample. It
must not create user accounts or import, upload, or crawl external customer
projects or data in this milestone.

Do not implement Codex repair, regression-patch generation, disposable-worktree
execution, human approval, repaired-state verification, other browsers/mobile,
CI/hosting, visual redesign, generic contracts, or another product promise in
this milestone.

## Quality requirements

- TypeScript.
- Clear scripts for build, test, and development.
- No console errors.
- Seeded deterministic demo mode.
- Small, understandable modules.
- Commit after every verified milestone.
- Keep BUILD_WEEK.md updated with decisions and completed work.
