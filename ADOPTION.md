# Adopting PromiseProof Verify

PromiseProof Verify is the reproducible check at the end of the PromiseProof lifecycle. It takes externally supplied evidence for one narrow product promise, runs it through a single unchanged deterministic evaluator, and emits an evidence-bound report you can regenerate byte for byte. No model participates in the verdict.

This guide covers the external evidence contract, the CLI, the report format, the outcomes and exit codes, the binding semantics, the trust boundaries, and the current limits.

## Who this is for

Product, QA, privacy, reliability, and platform engineers who already collect browser and backend evidence for a user-facing control and want a deterministic, re-runnable verdict on one specific promise: when activity-based personalization is off, nothing that identifies the user should reach the recommendation service, and the off preference should survive a reload across UI, storage, and backend.

You bring the evidence. PromiseProof decides, deterministically, whether that evidence keeps the promise.

## Supported contract family

Exactly one:

```
activity-personalization/v1
```

Any other `contractFamily` value is rejected as invalid evidence. There is no arbitrary-contract mode.

## The evidence envelope

Evidence is a JSON bundle with a fixed shape. A passing OFF bundle:

```json
{
  "schemaVersion": "1",
  "contractFamily": "activity-personalization/v1",
  "evidence": {
    "scenario": "off",
    "subjectId": "article-atlas-reader-001",
    "control": {
      "uiPreference": "off",
      "toggleChecked": false,
      "storedPreference": "off",
      "backendPreference": "off",
      "reloadObserved": true
    },
    "activity": {
      "capturedActivities": [],
      "recommendationServiceReceipts": []
    },
    "recommendations": {
      "feedFunctional": true,
      "renderedSource": "contextual",
      "renderedItemIds": ["article-atlas-story-101"],
      "recommendationServiceReceipts": [
        { "source": "contextual", "itemIds": ["article-atlas-story-101"] }
      ]
    }
  }
}
```

An activity object (used in `capturedActivities` and the activity `recommendationServiceReceipts`) has this shape:

```json
{
  "runId": "article-atlas-passing-on",
  "subjectId": "article-atlas-reader-001",
  "eventType": "page_view",
  "itemId": "article-atlas-origin-001",
  "clientSequence": 1,
  "occurredAt": "2026-01-15T12:00:01.000Z"
}
```

`eventType` is the literal `page_view`. `clientSequence` is a non-negative integer. The envelope carries only facts the evaluator reads; it has no verdict field and no free-form cause field.

### OFF requirements

An OFF bundle passes when all three clauses hold:

- `no_identifiable_activity`: zero identifiable captured activity requests and zero identifiable receipts at the recommendation service.
- `contextual_feed_functional`: a functional feed with `renderedSource` `contextual`, a non-empty `renderedItemIds`, and a matching contextual recommendation-service receipt.
- `preference_survives_reload`: a witnessed reload (`reloadObserved` true) followed by off in the UI, toggle, stored preference, and backend.

The single OFF violation surfaced by the seeded demo is `PP_IDENTIFIABLE_EVENT_LEAK`.

### ON requirements

An ON bundle is the control. It passes when:

- `expected_activity_received`: one correlated identifiable activity for the subject reaches the recommendation service.
- `behavioral_feed_functional`: a functional feed with `renderedSource` `behavioral` and a matching behavioral receipt.

The ON control proves a fix cannot simply switch recommendations off to satisfy the OFF promise.

## The CLI

Scaffold the contract, examples, and a producer template:

```bash
npm run promiseproof -- init --out .promiseproof
```

Verify a single bundle:

```bash
npm run promiseproof -- verify \
  --evidence .promiseproof/passing-off.example.json \
  --out .promiseproof/report
```

Gate an OFF and an ON bundle together (both must pass):

```bash
npm run promiseproof -- gate \
  --off .promiseproof/passing-off.example.json \
  --on .promiseproof/passing-on.example.json \
  --out .promiseproof/report
```

Reproduce a report from its evidence:

```bash
npm run promiseproof -- check \
  --report .promiseproof/report/report.json \
  --off .promiseproof/passing-off.example.json \
  --on .promiseproof/passing-on.example.json
```

`check` also accepts a single report with `--report ... --evidence ...`.

## Reports

`verify` and `gate` write two files to `--out`:

- `report.json`: the canonical machine-readable report. It carries the contract family, the outcome, the per-clause results, any violations, the evidence input binding (canonicalization id, digest algorithm, and evidence SHA-256), and an `authority` block that records the evidence source, that collection is not attested, and the evaluator source SHA-256.
- `report.md`: the same content as human-readable Markdown.

## Outcomes and exit codes

Verdict outcomes from `verify` and `gate`:

| Outcome | Meaning | Exit |
| --- | --- | --- |
| `PASS` | Every clause held. | `0` |
| `BROKEN_PROMISE` | At least one clause failed; violations are listed. | `2` |
| `INVALID_EVIDENCE` | The bundle failed strict validation and was not evaluated. | `3` |
| usage or execution error | Bad arguments or I/O failure. | `1` |

Reproduction outcomes from `check`:

| Outcome | Meaning | Exit |
| --- | --- | --- |
| `BOUND_AND_REPRODUCED` | The supplied report regenerates exactly from the supplied evidence. | `0` |
| `STALE_OR_MISMATCH` | The report is a well-formed report that does not reproduce from the evidence. | `4` |
| `INVALID_REPORT_OR_EVIDENCE` | The report is malformed or the wrong kind, or the evidence is invalid. | `3` |
| usage or execution error | Bad arguments or I/O failure. | `1` |

The distinction is deliberate: a structurally valid report that lies about its verdict is `STALE_OR_MISMATCH`, not `INVALID`. A malformed or wrong-shape document is `INVALID_REPORT_OR_EVIDENCE`.

## Binding semantics

Two content digests connect a report to what produced it:

- **Evidence digest.** The SHA-256 of the validated bundle serialized with the `promiseproof-canonical-json/v1` canonicalization. Change any load-bearing observation and this digest changes.
- **Evaluator fingerprint.** The SHA-256 of the evaluator source, normalized to LF line endings. It is pinned to the build and checked against the evaluator source by the repository's own tests.

`check` does not trust these digests on their own. It re-runs the evaluator on the supplied evidence, rebuilds the complete report, and compares the whole canonical document. A forged report that carries the correct digest and fingerprint but an invented verdict, clause, or violation fails to reproduce.

### Why BOUND does not mean PASS

`BOUND_AND_REPRODUCED` is an integrity statement: the report faithfully matches the evidence it was computed from. The verdict inside can be `PASS` or `BROKEN_PROMISE`. A broken-promise report is still bound to its evidence. Binding is about whether the report is honest for its evidence, not about whether the promise was kept.

### Honestly sealing a failing verdict

Because the report is regenerated from evidence rather than asserted, you can seal a report for changed evidence and it will reproduce, carrying the honest `BROKEN_PROMISE` verdict. What you cannot do is carry an earlier `PASS` onto changed evidence: the old report goes `STALE_OR_MISMATCH`, and any newly sealed report reflects the actual, now-broken, verdict.

## Collection is not attested

PromiseProof evaluates evidence that you supply. It does not observe your system and does not claim to know how the evidence was collected or that it is a faithful record of a real session. The `authority` block states this explicitly. Binding proves the report matches the evidence, not that the evidence matches reality.

## Limits

Strict validation applies before evaluation:

- Input is rejected before parsing if it exceeds 256 KiB (262144 bytes).
- Every collection is capped at 100 items.
- String identifiers are capped at 256 characters.
- Unknown fields and wrong single or gate report shapes are rejected.

In the hosted Judge Mode these limits apply in the browser, before the file is read.

## Supported platforms

- Node.js 22.12 or newer and npm 10 or newer for the CLI.
- The CLI is directly verified on Windows 10 x64. It uses cross-platform Node and Web Crypto primitives; macOS and Linux are expected to work but are not yet claimed as verified.
- The hosted Judge Mode runs entirely in a modern browser with no server and no network request in the verdict path.

## CI example

The repository workflow runs the verifier suites on pull requests and pushes to `main`:

```bash
npm run test:external          # CLI, bound-report check, strict validation
npm run test:external:pipeline # real evidence-to-evaluation equivalence
npm run build:site             # assembles /, /walkthrough/, /verify/
npm run test:verify:judge      # hosted Judge Mode, privacy, browser/CLI parity
```

You can run the same commands in your own CI to gate a change against the contract.

## Trust boundaries

Four distinct layers, kept separate on purpose:

1. **Evidence you supply.** You are responsible for the bundle. PromiseProof validates its shape and rejects malformed input, but it does not vouch for the evidence.
2. **Deterministic evaluation.** One fixed evaluator, with no verdict field exposed to any model, decides `PASS` or `BROKEN_PROMISE` from that evidence.
3. **Content binding and complete reproduction.** The report binds the validated evidence by digest to the pinned evaluator source, and `check` regenerates the entire report so a forged verdict cannot survive.
4. **Producer identity and collection integrity.** PromiseProof does not attest who produced the evidence or how it was gathered. That boundary is outside the tool.

## Current limitations

- One contract family only: `activity-personalization/v1`.
- The bundled Signal Shelf example is synthetic. This is not a legal or regulatory compliance statement.
- The hosted Judge Mode supports single-bundle evaluation but exposes report download for gate reports; single-report byte parity with the CLI is therefore not part of the browser surface.
- Integrity is repository-level and content-addressed. It is not a signature, notarization, or third-party attestation.

## Under consideration

Not promised, and none of it blocks the current release:

- A repository GitHub Action wrapping the CLI, to make the check easy to drop into another project's CI.
- Verification on macOS and Linux runners.

PromiseProof does not promise package publication, arbitrary evidence collection, arbitrary promise contracts, or external provenance.
