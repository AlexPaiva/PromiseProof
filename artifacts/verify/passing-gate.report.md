# PromiseProof OFF + ON gate report

Contract family: activity-personalization/v1
Outcome: PASS

OFF input canonicalization: promiseproof-canonical-json/v1
OFF input digest algorithm: SHA-256
OFF input evidence SHA-256: ec899c353c8808392a2d5bc820870a78c95ff31bdc0cf6f6e350274bb65cf0d6
ON input canonicalization: promiseproof-canonical-json/v1
ON input digest algorithm: SHA-256
ON input evidence SHA-256: dc211e0a71396caa7bd7aa4765143158c6cb4e1c0c4fbee4f34d8772d7195a3c

## OFF evaluation

Scenario: OFF
Canonical verdict: pass

| Clause | Result | Expected | Observed |
| --- | --- | --- | --- |
| no_identifiable_activity | PASS | 0 identifiable activity requests and 0 receipts at the recommendation service | 0 captured request(s), 0 backend receipt(s) |
| contextual_feed_functional | PASS | a non-empty contextual recommendation feed | contextual feed with 1 item(s); backend receipt match=true |
| preference_survives_reload | PASS | a witnessed reload followed by OFF in the UI, browser storage, and backend | reload=true, ui=off, toggleChecked=false, storage=off, backend=off |

### Violations

None.

## ON evaluation

Scenario: ON
Canonical verdict: pass

| Clause | Result | Expected | Observed |
| --- | --- | --- | --- |
| expected_activity_received | PASS | activity for article-atlas-reader-001 at the recommendation service | 1 captured request(s), 1 backend receipt(s), correlated=true |
| behavioral_feed_functional | PASS | a non-empty behavioral recommendation feed | behavioral feed with 1 item(s); backend receipt match=true |

### Violations

None.

## Authority

Evidence source: externally supplied
Collection integrity: not attested by PromiseProof
Evaluation authority: deterministic PromiseProof evaluator
Evaluator source SHA-256 (canonical UTF-8/LF): fca20925861d1de2772ad0297a2465029678c4f34faa7a4755592f37aef9f87f
