# PromiseProof

PromiseProof is an OpenAI Build Week Developer Tools project that turns a product personalization promise into reproducible browser evidence.

The synthetic product, Signal Shelf, has two independently selectable defects. Both break the same OFF promise in different ways, produce different evidence, and require different diagnostic actions. Playwright captures the journey and network traffic; deterministic TypeScript alone evaluates the contract.

The intended users are product, QA, privacy, and platform engineers responsible for user-facing controls that cross browser and service boundaries. PromiseProof turns an ambiguous report such as “OFF did not behave like OFF” into reproducible evidence and a bounded diagnostic action, helping a team find the responsible subsystem sooner without claiming legal or regulatory compliance.

The Milestone 03 investigation layer is implemented and verified both offline and with live GPT-5.6. It gives GPT-5.6 a versioned, allowlisted dossier, accepts one strictly structured request for one registered diagnostic replay, executes that existing replay through deterministic code, and asks GPT-5.6 for one strictly structured hypothesis update. GPT-5.6 proposes the initial ranked hypothesis titles and evidence, while deterministic code prescribes opaque identity slots (`h1` through `h4`), validates them, and recursively freezes the accepted identities and titles. The final model schema returns only ID-linked updates and has no free-form cause or overall-verdict field. GPT-5.6 never receives the selected fixture; deterministic TypeScript and Playwright alone decide whether the promise passed.

Milestone 04's bounded repair infrastructure is implemented and has one authentic verified initialization-race repair proof. The earlier approved candidate was correctly retired as `not_run` after transient Codex capture-ref rotation prevented verification. A fresh candidate, `c52183ec-2075-47e9-a1fb-7902e028dc42`, was then human-approved and reapplied by exact digest in a second fresh worktree. The unchanged Playwright journey and deterministic evaluator passed the repaired OFF journey, ON control, focused regression, five-run repetitions, and independent propagation control. The tracked [Milestone 04 proof package](docs/evidence/milestone-04-authentic-repair/README.md) contains sanitized provenance, the exact approved patch, and verification facts.

The proof package distinguishes recorded authentic runtime evidence, byte-for-byte original machine receipts, sanitized derivatives, and reproducible offline rehearsals. It establishes internal integrity for this synthetic journey, not external attestation. Main intentionally remains seeded-broken; the approved repair was applied only in a disposable verification worktree, and the unchanged Playwright journey plus deterministic evaluator—not the model or human approval—own the recorded PASS. Fresh candidate preparation is not part of the judge path at this frozen checkpoint.

## Current evidence matrix

| Seeded fixture | OFF evidence after reload | Only violation | Offline- and live-verified replay |
| --- | --- | --- | --- |
| Initialization race | UI/storage/backend OFF; contextual feed; one captured identifiable request and matching service receipt | `PP_IDENTIFIABLE_EVENT_LEAK` | `inspect_startup_order` |
| Propagation failure | UI/storage OFF; backend ON; contextual feed; zero activity | `PP_PREFERENCE_NOT_PERSISTED` | `inspect_preference_roundtrip` |

ON remains a control in both fixtures: one correlated identifiable activity request reaches the recommendation service and the behavioral feed remains functional.

The propagation seed is deliberately stronger than a missing click handler. A real OFF `PUT` crosses HTTP and receives an ordinary OFF acknowledgement and receipt, but an independent `GET` still returns ON. A test that checks only the write response would pass; the replayed write/read round trip catches the broken promise.

## Architecture

PromiseProof is one small TypeScript workspace:

- `src/client` — vanilla TypeScript UI, startup ordering, and visible evidence panel.
- `src/server` — Express API, fixed recommendation data, in-memory state, and isolated fixture injection.
- `src/shared` — evidence schema, canonical evaluator, and whitelisted replay selection.
- `src/investigation` — versioned dossier and result contracts, strict runtime schemas, GPT-5.6 Responses API provider, deterministic validation, closed replay dispatcher, bounded runner, and sanitized audit artifact.
- `src/repair` — frozen live-receipt eligibility, pinned Codex SDK boundary, exact inspection policy, disposable-worktree orchestration, semantic diff firewall, real-TTY approval, fresh-worktree verification, digest-bound `not_run` retirement, recovery, and deterministic receipts.
- `tests` — Playwright journeys, independent network capture, contract tests, existing diagnostic replays, deterministic providers, leakage checks, live smoke paths, repair boundary tests, and the offline two-worktree journey.

The browser and service communicate over real HTTP. Contextual requests contain no user ID and suppress the referrer. Feed assertions require rendered DOM item IDs to match backend recommendation receipts; missing DOM evidence cannot be replaced with server data.

Fixture selection is an out-of-band server setting. It is not accepted through the page URL, is absent from `PromiseEvidence`, and is not an input to the replay selector. Neutral run IDs prevent the evidence itself from revealing a seeded cause.

The investigation has exactly two provider calls and at most one replay execution:

1. Deterministic code builds `InvestigationDossierV1`; GPT-5.6 must call the sole strict function, `run_diagnostic_replay`, with two to four proposed ranked hypothesis titles in the prescribed opaque slots `h1` through `h4`, relative model confidence estimates, evidence references, a purpose, and either `inspect_startup_order` or `inspect_preference_roundtrip`.
2. Runtime validation rejects malformed output, unknown tools, unknown replay IDs, dangling or duplicate evidence references, zero or multiple tool calls, overlapping support/contradiction references, and reserved verdict language. It then recursively freezes the complete accepted argument object—including the initial hypothesis IDs, titles, arrays, purpose, references, and replay selection—before a closed dispatcher executes exactly one existing factual replay.
3. The replay report is normalized and returned in a second Responses API call. GPT-5.6 must return strict `InvestigationResultV1` fields: the existing hypothesis IDs with confidence/status/reference updates, `mostLikelyHypothesisId`, replay performed, conclusion evidence, and exactly the ordered limitation codes `single_replay_scope`, `synthetic_evidence_scope`, and `diagnostic_not_verdict`. Project-owned code renders those codes with fixed prose. Titles, free-form causal conclusions, model-authored caveats, and verdicts are absent from the final schema; artifact consumers join each ID back to its frozen initial title deterministically. The validated final object is recursively frozen.

A `supported` update must cite supporting evidence from the executed replay, and a `weakened` update must cite contradicting replay evidence. Confidence movement by itself is not accepted as a material causal update. The integer confidences are relative model estimates, not calibrated probabilities.

Every model-supplied reference array must contain unique IDs, and each hypothesis's supporting and contradicting reference sets must be disjoint. Replay schemas also verify internal factual consistency: startup indices equal the first matching events, the startup and network ordering flags are derived from their event arrays, and preference-roundtrip consistency agrees with the acknowledgement and authoritative readback.

The exact dossier fields supplied as initial evidence are the dossier version, canonical promise statement, three deterministic clause descriptions/expectations/observations/results, stable violation codes, UI preference and toggle state, browser-storage preference, backend preference, activity request/receipt and identifiable counts, recommendation mode/item count/functionality, allowlisted event ordering, sanitized evidence references, and the two registered replay names/descriptions. The only new evidence payload in the second call is the normalized factual report and sanitized evidence references from the one executed replay.

Fixture selection, configuration and health contents, environment variables, identity-bearing run/user identifiers, source paths or code, server logs, screenshots, videos, Playwright traces, and root-cause labels are excluded from model input. The retained human audit trail may contain richer evidence, but it never crosses this boundary.

The live request builders strictly reparse the dossier and normalized replay report immediately before canonical serialization. Both live response phases must return exactly the requested `gpt-5.6` alias or OpenAI's documented resolved `gpt-5.6-sol` model before the investigation can complete; arbitrary suffixes are rejected and the network-free provider keeps its distinct deterministic model identity. Every returned output item is summarized structurally. The first response requires one individually completed function call; the final response requires exactly one individually completed message containing exactly one `output_text` item, plus only absent or completed reasoning metadata. A refusal, incomplete reason, provider error, function call—including an attempted second replay—or any other output kind is rejected before a result can be retained.

## Requirements and setup

- Node.js 22.12 or newer
- npm 10 or newer
- Playwright Chromium

```bash
npm ci
npx playwright install chromium
```

On Windows systems that block PowerShell's `npm.ps1`, use `npm.cmd` and `npx.cmd`.

No product account, login, GitHub authorization, or imported project is required for the built-in synthetic sample and offline verification path. PromiseProof does not upload, import, or crawl customer applications or data. Only explicitly invoked live GPT-5.6 investigations and authentic Codex repair preparation require a separately configured OpenAI Platform API key.

## Supported platforms

The current checkpoint is directly verified on Windows 10 x64 with Node.js 22
and Playwright Chromium. The implementation uses cross-platform Node.js,
Playwright, and Git primitives, but macOS and Linux are not yet claimed as
verified until the post-canonical-loop CI milestone runs them. The authentic
Codex repair provider is intentionally restricted to the trusted native Windows
PowerShell boundary and the pinned CLI's elevated backend. It requires an
administrator-approved Codex sandbox setup to exist already and fails closed;
it never falls back to the weaker unelevated backend. For every candidate it
creates a blank disposable `CODEX_HOME`, copies only the validated setup marker
and byte-matched pinned command runner with protected ACLs, and links only the
host's protected sandbox-user credential directory. A no-key preflight proves
the command runs as `CodexSandboxOffline`, can read the candidate source, cannot
read the setup marker or provisioning credential, cannot open the command
runner for writing, and receives the Windows access-denied signal on the raw TCP
probe. The setup source
defaults to `%USERPROFILE%\.codex`; an alternate already-provisioned source may
be selected with the absolute `PROMISEPROOF_ELEVATED_SANDBOX_HOME` path. The
judge path is `npm run demo:rehearse`: a deterministic, no-key offline rehearsal
that validates the authentic tracked artifacts, applies the approved patch only
in disposable worktrees, and executes the unchanged verifier. It is a rehearsal
of the recorded repair, not a fresh GPT-5.6 or Codex run. To browse the full
no-key judge experience, build and serve the combined site — `npm run build:site`
then `npx serve dist/site` — which serves the landing at `/` and the interactive
walkthrough at `/walkthrough/`, matching production (so the walkthrough's "Back to
overview" returns to the landing). The dev route (`npm run dev`, then
<http://127.0.0.1:4173/judge>) mounts the walkthrough over the seeded Signal Shelf
app and does not serve the landing at `/`. Either way the walkthrough reads only
tracked evidence and makes no model call. The other local no-key paths remain
`npm run test:investigation:offline` and `npm run test:repair:offline` after the
reproducible installation above.

## OpenAI model and Codex contributions

GPT-5.6 is part of the runtime product architecture. It receives a sanitized,
versioned investigation dossier, proposes ranked diagnostic hypotheses, and
selects exactly one registered factual replay through a strict function call.
After deterministic code executes that replay, GPT-5.6 may update only the
existing hypothesis IDs using allowlisted evidence references. It cannot run an
arbitrary command, choose an unregistered replay, or determine the product
verdict.

Codex is the engineering collaborator used in the primary Build Week task. It
helped implement and review the synthetic application, real HTTP evidence
capture, deterministic evaluator, two distinguishable seeded defects,
Playwright controls and expected-red verification, bounded investigation
schemas/provider/dispatcher, adversarial tests, and milestone documentation.
Codex also performed repeated red-team audits that found the original
free-text-cause and verdict-language weakness; the current ID-only final schema
and replay-citation rules are the resulting design correction. Command output,
retained artifacts, Git diffs, and protected-file hashes—not a model claim—are
used to verify that work. Alex retained final product, scope, sequencing, and
engineering decisions throughout the collaboration.

PromiseProof contains one recorded authentic, human-approved Codex repair that
passed unchanged Playwright and deterministic verification in a fresh disposable
worktree. Main remains intentionally seeded-broken for the red-to-green
demonstration. The integration prepares one minimal patch and regression test in
a disposable Git worktree only from the live-verified Milestone 03 foundation.
One shared prompt/provider policy permits exactly two ordered source reads and
changes to exactly two paths. Pinned SDK lifecycle events are audited after
dispatch and fail closed on broader command or patch behavior; they are not
misrepresented as a pre-execution interceptor. The separate elevated Windows
sandbox supplies the OS-enforced filesystem and network boundary. A human must
review the exact diff and digest in a real terminal; the
unchanged Playwright contracts alone accept or reject the repair in a second
fresh worktree.

Key decisions made during the Codex collaboration are:

- one narrow personalization promise before any generic contract framework;
- real browser/service HTTP evidence instead of fabricated logs;
- one unchanged deterministic evaluator for both defects and repaired states;
- GPT-5.6 hypothesis/replay authority separated from Playwright verdict
  authority;
- strict allowlists, two provider calls, one replay, and fail-closed validation;
- offline deterministic coverage separated from explicit paid live commands;
- milestone commits only after their stated evidence gates pass.

## Development

Run either deterministic fixture:

```bash
npm run dev:race
npm run dev:propagation
```

Both serve Signal Shelf at `http://127.0.0.1:4173`. Production equivalents are `npm run start:race` and `npm run start:propagation` after `npm run build`.

## Verification

Run every green health, control, detector, and replay assertion:

```bash
npm test
```

Run five fresh OFF and five fresh ON browser contexts under each fixture—20 cases total:

```bash
npm run test:determinism
```

Run the unchanged canonical OFF assertion against each fixture:

```bash
npm run verify:promise:race
npm run verify:promise:propagation
```

Both commands intentionally exit non-zero while their defect is seeded. The expected stable codes are respectively:

```text
PP_IDENTIFIABLE_EVENT_LEAK
PP_PREFERENCE_NOT_PERSISTED
```

These failures are product findings, not inverted tests. Green detector tests verify the exact single-violation signatures, while the uncompromised contract continues to expect zero violations.

For automation, run the green expected-red wrapper:

```bash
npm run test:expected-red
```

It removes stale contract output, runs both unchanged verifiers, and passes only when each exits exactly `1`, exposes only its expected `PP_` code, records the matching single normalized violation with zero browser errors, and retains fresh evidence JSON, screenshot, video, trace, and error context.

Verify the network-free investigation layer independently or as part of the ordinary suite:

```bash
npm run test:investigation:unit
npm run test:live-stability:unit
npm run test:investigation:offline
npm test
```

The provider unit suite serializes the exact first and second requests, checks the model-input exclusion boundary, and exercises strict-schema, zero-call, multiple-call, second-call, refusal/incomplete/error, output-item status/content, unexpected-output-kind, invalid-tool, invalid-replay, dispatcher-limit, safe provider-error projection, bounded provider identifiers, exact token accounting, opaque hypothesis identity, evidence-reference uniqueness/disjointness, hypothesis-continuity, immutable accepted-object, replay-report consistency, status-specific replay citation, material-update, deterministic-limitation, exact-model-identity, and verdict-boundary rejection paths. The separate live-stability unit suite constructs synthetic completed artifacts without network access and adversarially tests the retained-proof verifier. Citation placement is validated structurally; it is not a deterministic claim that model-authored hypothesis prose is semantically true. The offline Playwright command runs both real evidence signatures and their existing replays through a deterministic provider; it requires neither network access nor OpenAI credits. Both offline and live browser paths explicitly require zero observed browser errors, and the startup-order replay rejects browser errors before normalizing its report.

Verify the bounded repair system without an API key:

```bash
npm run test:repair:unit
npm run test:repair:offline
npm run test:repair:elevated-sandbox
```

The offline integration requires a clean committed runner checkout. It prepares
the deterministic candidate in one disposable worktree, records an offline-only
approval, applies the exact retained patch in a second fresh worktree, runs the
complete repaired-state Playwright matrix, cleans both worktrees, and proves
that `main` never changed. Offline approval is test infrastructure only and
cannot satisfy the production human gate.

The elevated-sandbox integration is Windows-only, uses no API key, and performs
the same real offline-identity, filesystem, control-file, credential, and raw
network preflight required immediately before an authentic Codex turn. It
requires the administrator-approved native Codex sandbox setup described above.
GitHub-hosted Windows CI verifies the deterministic repair rehearsal and the
sandbox's exact fail-closed behavior when administrator-provisioned setup is
unavailable. Live egress, credential, and ACL enforcement is exercised only on
a provisioned Windows host.

After an authentic preparation reaches human review, the production sequence is:

```bash
npm run repair:race:prepare
npm run repair:race:status -- <repair-id>
npm run repair:race:review -- <repair-id>
npm run repair:race:verify -- <repair-id>
```

`repair:race:review` requires Alex to inspect the complete diff and type the
exact digest-bound decision in a real terminal. Never pipe, script, prefill, or
combine that review command with another command. A model, test adapter, or
non-interactive stream cannot approve the patch. Verification starts only after
that immutable decision exists.

If an approved candidate can no longer start verification because its retained
base changed, retire it separately:

```bash
npm run repair:race:retire -- <repair-id>
```

Retirement requires a real interactive terminal and the exact displayed
`RETIRE_UNVERIFIED` phrase. It preserves the patch, approval, candidate audit,
source-integrity hashes, and lifecycle evidence while recording that verification
was not run. It cannot approve a candidate, invoke Playwright, create a
verification receipt, or relabel verification that already started.

Live GPT-5.6 runs are intentionally separate. Copy `.env.example` to the ignored `.env.local`, set `OPENAI_API_KEY` there, then run one smoke per defect:

```bash
npm run investigate:live:race
npm run investigate:live:propagation
```

Only after both single runs are stable, run three repetitions of each:

```bash
npm run investigate:live:stability
```

The two smoke artifacts remain isolated under `test-results/investigation-live-race` and `test-results/investigation-live-propagation`. The stability command first removes any stale success receipt and both prior stability-output cohorts, then captures a canonical digest of the executable source/configuration set. It writes three fresh race artifacts under `test-results/investigation-live-stability-race` and three fresh propagation artifacts under `test-results/investigation-live-stability-propagation`. The final verifier requires both newly created Playwright `.last-run.json` files to report a clean pass, discovers only the exact artifact basename outside attachment-copy directories, strictly reparses all six full artifacts, and requires the post-run source digest to equal the pre-run digest.

Every retained artifact is independently checked for the exact 28 accepted validation decisions, two completed GPT-5.6 responses, one completed tool call, one completed structured message, positive input/output token usage with exact totals, one replay, the expected singleton defect signature and factual report, ID/reference continuity, deterministic limitation codes, unique cohort IDs, stable per-defect dossier hashes, and absence of fixture, source-path, environment, verdict-authority, and credential material. Only after all checks pass is the projected receipt written atomically to `artifacts/milestone-03-live-stability.json`. That receipt covers the six repeated runs; the complete manual-plus-stability exercise contains eight investigations and sixteen Responses API calls.

The receipt retains only safe IDs, models, token/latency summaries, factual signature summaries, opaque leading IDs, hashes, and the source digest. Its canonical SHA-256 values prove internal consistency, not provider origin or external attestation. Model prose, provider messages, request/response bodies, headers, local paths, and the API key are omitted.

On 2026-07-15, both manually inspected smokes passed on their first paid attempt, followed by three correct fresh runs per defect and the aggregate verifier. All eight investigations returned `gpt-5.6-sol`, selected the expected defect-specific replay, retained a supported replay-cited leading hypothesis, and used exactly two Responses calls plus one replay. Across the complete exercise, 16 unique Responses consumed 31,462 total tokens and 116,845.708 ms of summed provider latency. The committed stability receipt covers the six repeated runs: 23,718 tokens, 87,842.468 ms, source snapshot `3de910ab131c54389f0583cfcb11ddfe37e6abeafc17b48db95ed41a169f5a50`, and receipt file SHA-256 `1a28dade48671e05e81dd07525f7a6a0c2da312a2cea8d574fc5ba86c6b90b57`.

The live provider deliberately sends `store: true` so the second response can continue the first with `previous_response_id`. OpenAI retains stored Response objects for 30 days by default. This milestone sends only the sanitized synthetic dossier and normalized synthetic replay report; using the same design with real customer data would require an explicit storage and retention policy.

Each scenario writes normalized JSON evidence to its Playwright output directory. Failed contracts additionally preserve screenshots, video, traces, and error context. The full milestone record and limitations are in `BUILD_WEEK.md`; canonical scope and forbidden shortcuts are in `AGENTS.md`.

## Current handoff

Milestone 02 remains the frozen deterministic foundation: both seeded defects, both ON controls, the unchanged expected-red contract, two factual diagnostic replays, and five OFF plus five ON repetitions per fixture are implemented and recorded. Milestone 03 now adds a live-verified bounded GPT-5.6 investigation: 10/10 provider-boundary groups, 10/10 live-receipt-verifier groups, both real-browser offline investigations, both manually inspected live smokes, and the strict 3+3 live receipt all pass. The broader build, 6/6 race and 6/6 propagation ordinary browser cases, 20/20 deterministic contexts, exact expected-red wrapper, zero-vulnerability audit, production smokes, and seven-file frozen-foundation comparison also pass.

Milestone 04 now includes live-receipt eligibility, a pinned one-turn Codex provider, two disposable worktrees, an elevated Windows offline-user sandbox, semantic source/test firewalls, digest-bound real-TTY review, deterministic fresh-worktree verification, explicit `not_run` retirement, crash recovery, and tamper-evident receipts. The authentic repair `c52183ec-2075-47e9-a1fb-7902e028dc42` completed its lifecycle through human approval, fresh-worktree verification, evidence retention, and `cleanup_completed`. The unchanged Playwright journey and deterministic evaluator—not the model or human approval—returned the pass. The exact 2,311-byte approved patch and sanitized verification record are tracked in `docs/evidence/milestone-04-authentic-repair`.

The canonical evaluator, contract assertion, seeded defects, and evidence capture remain outside model authority and must stay unchanged. The no-rebuild judge path (`npm run demo:rehearse`, plus the deployed landing page and interactive walkthrough), MIT licensing, and hosting are now in place. The remaining submission gates are the narrated demo video, screenshots, the Devpost write-up, sharing repository access with the judging accounts, and the primary Codex `/feedback` session id.
