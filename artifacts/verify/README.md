# PromiseProof external evidence scaffold

This scaffold supports exactly one contract family:
`activity-personalization/v1`.

Use `broken-off.example.json`, `passing-off.example.json`, and
`passing-on.example.json` as fixed-shape examples for producing a complete
external evidence bundle. `producer-template.mjs` is a small wrapper for a
complete `PromiseEvidence` JSON object; it does not collect or attest evidence.
Then verify one bundle:

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
