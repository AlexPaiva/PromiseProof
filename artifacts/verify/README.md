# PromiseProof external evidence scaffold

This scaffold supports exactly one contract family:
`activity-personalization/v1`.

The public `ExternalEvidenceV1` contract contains only facts used by the
unchanged PromiseProof evaluator:

- scenario and subject identifier;
- UI, toggle, storage, backend, and reload control state;
- captured activities and recommendation-service activity receipts;
- rendered feed state and recommendation-service recommendation receipts.

Use `broken-off.example.json`, `passing-off.example.json`, and
`passing-on.example.json` as fixed-shape examples. `producer-template.mjs`
wraps an `ExternalEvidenceV1` JSON object; it does not collect or attest
evidence. Then verify one bundle:

```text
npm run promiseproof -- verify --evidence <bundle.json> --out <directory>
```

Or gate OFF and ON together:

```text
npm run promiseproof -- gate --off <off.json> --on <on.json> --out <directory>
```

The OFF contract checks zero identifiable recommendation activity, a functional
contextual feed, and witnessed OFF persistence across UI, toggle, storage, and
backend state. The ON control checks correlated identifiable activity and a
functional behavioral feed.

Evidence is externally supplied. PromiseProof does not attest how it was
collected. The deterministic PromiseProof evaluator alone evaluates a bundle
that passes strict validation.

These examples prove externally supplied evidence ingestion for one contract
family. They do not prove arbitrary evidence collection or arbitrary promise
support. Article Atlas is a neutral synthetic example product.
