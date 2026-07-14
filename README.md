# PromiseProof

PromiseProof is an OpenAI Build Week Developer Tools project that turns a product personalization promise into reproducible browser evidence.

The synthetic product, Signal Shelf, has two independently selectable defects. Both break the same OFF promise in different ways, produce different evidence, and require different diagnostic actions. Playwright captures the journey and network traffic; deterministic TypeScript alone evaluates the contract.

GPT-5.6 diagnosis and Codex repair automation are not implemented at the current HEAD. The next scoped milestone adds only GPT-5.6 hypothesis management and validated replay selection; Codex repair remains deferred. The completed deterministic foundation proves that both root causes can be discriminated without giving a model the selected fixture or authority to declare success.

## Current evidence matrix

| Seeded fixture | OFF evidence after reload | Only violation | Selected replay |
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
- `tests` — Playwright journeys, independent network capture, contract tests, diagnostic replays, and determinism signatures.

The browser and service communicate over real HTTP. Contextual requests contain no user ID and suppress the referrer. Feed assertions require rendered DOM item IDs to match backend recommendation receipts; missing DOM evidence cannot be replaced with server data.

Fixture selection is an out-of-band server setting. It is not accepted through the page URL, is absent from `PromiseEvidence`, and is not an input to the replay selector. Neutral run IDs prevent the evidence itself from revealing a seeded cause.

The future model-input allowlist is narrower than the retained human audit trail: normalized evidence, deterministic clause results, registered replay descriptions, and replay reports only. Health/configuration responses, environment variables, server logs, screenshots, videos, and Playwright traces are excluded because they can reveal the fixture.

## Requirements and setup

- Node.js 22
- npm 10 or newer
- Playwright Chromium

```bash
npm install
npx playwright install chromium
```

On Windows systems that block PowerShell's `npm.ps1`, use `npm.cmd` and `npx.cmd`.

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

Each scenario writes normalized JSON evidence to its Playwright output directory. Failed contracts additionally preserve screenshots, video, traces, and error context. The full milestone record and limitations are in `BUILD_WEEK.md`; canonical scope and forbidden shortcuts are in `AGENTS.md`.

## Current handoff

Milestone 02 is complete: both seeded defects, both ON controls, the unchanged expected-red contract, two factual diagnostic replays, and five OFF plus five ON repetitions per fixture are implemented and recorded.

The repository is not yet a complete Build Week submission. GPT-5.6 investigation, Codex repair in a disposable worktree, human diff approval, repaired-state Playwright verification, cross-platform CI, a judge-accessible repository, and demo packaging remain outstanding. `AGENTS.md` defines the next bounded implementation milestone; `BUILD_WEEK.md` records the audit and sequencing rationale.
