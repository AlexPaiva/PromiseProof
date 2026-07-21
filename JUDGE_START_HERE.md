# PromiseProof: Judge Start Here

## 15-second explanation

When AI says "fixed," that is a claim, not a fact. GPT-5.6 investigates. Codex repairs. Neither decides PASS. An unchanged deterministic verifier does.

## Judge in 60 seconds

**1. Watch the recorded repair lifecycle.**
https://promiseproof.alex0paiva0.workers.dev/walkthrough/

Five stages: Observe, Investigate, Replay, Repair, Prove. It replays one authentic run: a user turned personalization off, one identifiable request still reached the recommendation service, GPT-5.6 ranked competing hypotheses and selected one allowlisted factual replay, Codex proposed a two-file repair, a human approved the exact patch, and an unchanged test decided PASS.

**2. Challenge the proof yourself.**
https://promiseproof.alex0paiva0.workers.dev/verify/?judge=1

After the page loads, verification runs entirely in the browser. The verdict path uses no backend API, evidence upload, or model call. Expected states:

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

## The model cannot award itself PASS

This split is enforced in code and covered by tests, not merely asserted:

- **No verdict field exists.** The final investigation contract in `src/investigation/contracts.ts` has no overall-verdict field; the only verdict-adjacent limitation code is `diagnostic_not_verdict` ("Diagnostic hypotheses do not determine the product promise verdict.").
- **Verdict language from the model is rejected.** `tests/investigation/investigation.unit.ts` asserts `PP_INV_VERDICT_LANGUAGE_REJECTED` when model output uses reserved verdict wording.
- **A claimed model verdict is ignored by the matrix.** `tests/judge/rehearsal.unit.ts`, "verification matrix rejects missing propagation control, browser errors, and model verdict claims," proves a supplied `modelVerificationVerdict` cannot turn a fail into a pass.
- **Approval is human and digest-bound.** `tests/repair/artifact-approval.unit.ts`, "accepts only the exact APPROVE or REJECT phrase for the current digest," proves the patch is approved by a human against its exact fingerprint, and the lifecycle records `modelVerdictUsed: false`.
- **The verdict path needs no model at all.** `tests/judge/rehearsal.unit.ts`, "offline rehearsal environment removes model credentials and Codex configuration," runs the whole verification with no model present.

This is deterministic, code-level separation. It is not a formal or mathematical proof.

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
