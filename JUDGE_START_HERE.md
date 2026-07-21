# PromiseProof: Judge Start Here

## 15-second explanation

When AI says "fixed," that is a claim, not a fact. GPT-5.6 investigates. Codex repairs. Neither decides PASS. An unchanged deterministic verifier does.

## Judge in 60 seconds

**1. Watch the recorded repair lifecycle.**
https://promiseproof.alex0paiva0.workers.dev/walkthrough/

Five stages: Observe, Investigate, Replay, Repair, Prove. It replays one authentic run: a user turned personalization off, one identifiable request still reached the recommendation service, GPT-5.6 proposed the diagnosis, Codex proposed a two-file repair, a human approved the exact patch, and an unchanged test decided PASS.

**2. Challenge the proof yourself.**
https://promiseproof.alex0paiva0.workers.dev/verify/?judge=1

This runs the same deterministic evaluator in your browser, with no network call. Expected states:

- On load: `PASS` and `BOUND_AND_REPRODUCED`.
- After you tamper one OFF observation: `BROKEN_PROMISE`, violation `PP_IDENTIFIABLE_EVENT_LEAK`, and the report you sealed a moment earlier becomes `STALE_OR_MISMATCH`.
- After you seal the failing evidence: `BROKEN_PROMISE` and `BOUND_AND_REPRODUCED`. A report can honestly bind a failing verdict; it cannot manufacture a PASS.
- After reset: the original `PASS` and original evidence bindings return.

**3. Inspect the GitHub Action.**
https://github.com/AlexPaiva/PromiseProof/tree/submission-rc-03/.github/actions/verify

A bundled Action that runs the same verifier in CI with no `npm install`, no browser, and no API key.

## Who has authority

| Actor | May investigate | May propose source changes | May approve the exact patch | May decide PASS |
| --- | --- | --- | --- | --- |
| GPT-5.6 | Yes | No | No | No |
| Codex | Yes | Yes, in isolation | No | No |
| Human | Yes | No | Yes | No |
| Unchanged verifier | No | No | No | Yes |

## Recorded versus fresh

- **Recorded and authentic:** the GPT-5.6 investigation, the Codex source repair, and the five-stage walkthrough that presents them. These happened once and are replayed, not re-run live.
- **Fresh every time you interact:** the browser verification, the semantic tamper, the CLI verification, and the GitHub Action verification. These re-run the deterministic evaluator on the evidence in front of you.

## Developer Tool path

One deterministic authority, three surfaces:

- **Hosted verifier** at `/verify/?judge=1`, no login and no key.
- **Repository-local CLI:** `npm run promiseproof -- gate|verify|check`.
- **Bundled GitHub Action:** `uses: AlexPaiva/PromiseProof/.github/actions/verify@submission-rc-03`.

No API key, no browser, and no model call in the verdict path. Exactly one contract family is supported: `activity-personalization/v1`. External evidence is evaluated but not collection-attested.

## Test locally

Requirements: Node.js 22.12+, npm 10+, and (for the walkthrough tests) Playwright Chromium.

```bash
npm ci
npx playwright install chromium

# No-key recorded repair rehearsal: applies the approved patch in a
# disposable worktree and runs the unchanged verifier.
npm run demo:rehearse

# Deterministic external verification from evidence:
npm run promiseproof -- init --out .promiseproof
npm run promiseproof -- gate \
  --off .promiseproof/passing-off.example.json \
  --on .promiseproof/passing-on.example.json \
  --out .promiseproof/report
npm run promiseproof -- check \
  --report .promiseproof/report/report.json \
  --off .promiseproof/passing-off.example.json \
  --on .promiseproof/passing-on.example.json

# Test suites:
npm run test:external      # CLI, bound-report reproduction, strict validation
npm run test:action        # the bundled Action, spawned as a real Action
```

## Scope and limitations

- Signal Shelf is a synthetic reference application. It exists to make one broken promise visible and repairable end to end. This is not a legal or regulatory compliance statement.
- Exactly one external contract family is supported: `activity-personalization/v1`.
- Evidence is externally supplied and is not collection-attested. Content binding proves a report matches its evidence and the pinned evaluator source; it does not prove the evidence was collected honestly.
- The `main` branch stays intentionally seeded-broken so the red-to-green repair can be demonstrated. Production main is not automatically repaired.
- Integrity is repository-level and content-addressed. It is not a signature, notarization, certification, or third-party attestation.
- The CLI is verified on Windows. The bundled Action is exercised on Windows, Ubuntu, and macOS runners.
