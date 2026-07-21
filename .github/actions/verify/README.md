# PromiseProof Verify Action

Run the frozen PromiseProof evaluator in a GitHub Actions workflow. The Action
is a single bundled Node file. It needs no `npm install` in your repository, no
browser, no OpenAI key, and it makes no model call in the verdict path.

It supports one contract family: `activity-personalization/v1`. Evidence is
supplied by you and is not collection-attested.

## Usage

Gate an OFF and an ON evidence bundle (both must pass):

```yaml
- uses: AlexPaiva/PromiseProof/.github/actions/verify@submission-rc-03
  with:
    mode: gate
    off_evidence: artifacts/personalization-off.json
    on_evidence: artifacts/personalization-on.json
    output_directory: artifacts/promiseproof
```

Verify a single bundle:

```yaml
- uses: AlexPaiva/PromiseProof/.github/actions/verify@submission-rc-03
  with:
    mode: verify
    evidence: artifacts/personalization-off.json
```

Reproduce a report from its evidence:

```yaml
- uses: AlexPaiva/PromiseProof/.github/actions/verify@submission-rc-03
  with:
    mode: check
    report: artifacts/promiseproof/report.json
    off_evidence: artifacts/personalization-off.json
    on_evidence: artifacts/personalization-on.json
```

The examples pin `@submission-rc-03`, the immutable release that contains this Action. Use `@main` only if you intentionally want to track later changes on the default branch.

## Inputs

| Input | Used by | Description |
| --- | --- | --- |
| `mode` | all | `verify`, `gate`, or `check`. Required. |
| `evidence` | verify, single check | Path to one evidence bundle. |
| `off_evidence` | gate, gate check | Path to the OFF bundle. |
| `on_evidence` | gate, gate check | Path to the ON bundle. |
| `report` | check | Path to a `report.json` to reproduce. |
| `output_directory` | verify, gate | Where `report.json` and `report.md` are written. Default `promiseproof-report`. |

Input combinations are strict. `verify` takes only `evidence`. `gate` takes only
`off_evidence` and `on_evidence`. `check` takes `report` with either `evidence`,
or both `off_evidence` and `on_evidence`. Any other combination is a usage error.

## Outputs

| Output | Description |
| --- | --- |
| `status` | The result, see below. |
| `mode` | The resolved mode. |
| `report_json` | Workspace-relative path to `report.json` (verify, gate). |
| `report_markdown` | Workspace-relative path to `report.md` (verify, gate). |
| `evaluator_sha256` | The pinned evaluator source SHA-256. |
| `evidence_sha256` | Evidence digest (verify, single check). |
| `off_evidence_sha256` | OFF evidence digest (gate, gate check). |
| `on_evidence_sha256` | ON evidence digest (gate, gate check). |

Outputs are written before the step fails, so a `continue-on-error` consumer can
still read `status` and the report paths on a broken verdict. Evidence contents
are never exposed as outputs.

## Status and exit codes

Verify and gate:

| status | exit | meaning |
| --- | --- | --- |
| `PASS` | 0 | Every clause held. |
| `BROKEN_PROMISE` | 2 | A clause failed. The reports are still written. |
| `INVALID_EVIDENCE` | 3 | Strict validation failed. No report is produced. |
| `EXECUTION_ERROR` | 1 | Usage, path, or I/O error. |

Check:

| status | exit | meaning |
| --- | --- | --- |
| `BOUND_AND_REPRODUCED` | 0 | The report regenerates exactly from the evidence. |
| `STALE_OR_MISMATCH` | 4 | A well-formed report that does not reproduce. |
| `INVALID_REPORT_OR_EVIDENCE` | 3 | Malformed or wrong-kind report, or invalid evidence. |
| `EXECUTION_ERROR` | 1 | Usage, path, or I/O error. |

A broken promise fails the step; it is never turned into a passing workflow
because a report was produced. `check` re-runs the evaluator and compares the
complete regenerated report, not only the embedded hashes.

## Regenerating the bundle

`dist/index.js` is generated. Do not edit it by hand. From the repository root:

```bash
npm run build:action
npm run check:action-bundle
```
