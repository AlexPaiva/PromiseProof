# PromiseProof

PromiseProof is an OpenAI Build Week Developer Tools project that turns a product personalization promise into reproducible browser evidence.

The current milestone contains a deliberately broken synthetic recommendation product. When activity-based personalization is OFF, the saved preference and contextual feed work, but an initialization race sends one identifiable `page_view` to the recommendation service before preference hydration. Playwright captures the request, the backend records a matching receipt, and deterministic TypeScript returns `PP_IDENTIFIABLE_EVENT_LEAK`.

GPT-5.6 diagnosis and Codex repair automation are intentionally not implemented yet. The milestone first establishes an evidence loop that those systems cannot override.

## What is implemented

- A polished synthetic recommendation application named Signal Shelf.
- An accessible activity-personalization ON/OFF switch.
- Browser and backend preference persistence across reloads.
- Real HTTP preference, activity, recommendation, and evidence endpoints.
- Contextual recommendations when OFF and behavioral recommendations when ON.
- A deterministic seeded initialization race with no timing sleeps.
- Normalized evidence covering UI state, browser storage, captured request payloads, backend receipts, recommendation source/items, and client/server timestamps.
- A green health/control suite, a green detector meta-test, a genuine red promise verifier, and five fresh-context repetitions of both OFF and ON.

## Architecture

PromiseProof uses one small TypeScript workspace:

- `src/client` — vanilla TypeScript UI and seeded startup ordering defect.
- `src/server` — Express application, deterministic recommendation endpoints, and in-memory evidence ledger.
- `src/shared` — evidence schema and deterministic contract evaluator.
- `tests` — Playwright journeys, evidence capture, detector, contract, and determinism suites.

The browser and recommendation service communicate over actual HTTP. Contextual recommendation requests contain no user ID and use a no-referrer policy. Test verdicts come only from `src/shared/evaluator.ts`; the UI and any future model cannot declare a pass.

## Requirements

- Node.js 22
- npm
- Playwright Chromium

Verified platform: Windows x64. The code is designed to be portable, but macOS and Linux have not yet been verified.

## Setup

```bash
npm install
npx playwright install chromium
```

On Windows systems that block PowerShell's `npm.ps1`, use `npm.cmd` and `npx.cmd` instead.

## Development and production

```bash
npm run dev
npm run build
npm start
```

The application runs at `http://127.0.0.1:4173`.

## Verification

Run the normal green suite:

```bash
npm test
```

Run the real OFF contract verifier:

```bash
npm run verify:promise
```

While the initialization race is seeded, this command must exit non-zero and report:

```text
PP_IDENTIFIABLE_EVENT_LEAK
```

That failure is the product finding, not a broken test harness. The green detector meta-test proves the verifier finds the seeded defect without weakening the contract.

Run five fresh-browser-context repetitions for each state:

```bash
npm run test:determinism
```

Each scenario stores a normalized JSON attachment in its Playwright output directory. Failed contract runs additionally preserve a screenshot, video, and trace.

## Build Week collaboration

The human entrant defined the canonical promise, safety boundaries, and expected-red testing structure. Codex implemented the current core milestone in the primary project task, selected the single-workspace architecture, built the application and evidence evaluator, created the Playwright harness, ran the verification matrix, and tightened the implementation after an independent integration review found lifecycle and evidence-correlation gaps.

Decisions and exact milestone results are recorded in `BUILD_WEEK.md`. The canonical scope and forbidden shortcuts remain in `AGENTS.md`.
