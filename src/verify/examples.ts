import type {
  ExternalActivity,
  ExternalBundle,
  ExternalEvidenceV1,
} from "./schema.js";
import {
  SUPPORTED_CONTRACT_FAMILY,
  SUPPORTED_SCHEMA_VERSION,
} from "./outcome.js";

const SUBJECT_ID = "article-atlas-reader-001";
const ITEM_ID = "article-atlas-story-101";
const TIME_ACTIVITY = "2026-01-15T12:00:01.000Z";

function activity(runId: string): ExternalActivity {
  return {
    runId,
    subjectId: SUBJECT_ID,
    eventType: "page_view",
    itemId: "article-atlas-origin-001",
    clientSequence: 1,
    occurredAt: TIME_ACTIVITY,
  };
}

function bundle(evidence: ExternalEvidenceV1): ExternalBundle {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    evidence,
  };
}

function offEvidence(includeActivity: boolean): ExternalEvidenceV1 {
  const runId = includeActivity
    ? "article-atlas-broken-off"
    : "article-atlas-passing-off";
  const observedActivity = activity(runId);

  return {
    scenario: "off",
    subjectId: SUBJECT_ID,
    control: {
      uiPreference: "off",
      toggleChecked: false,
      storedPreference: "off",
      backendPreference: "off",
      reloadObserved: true,
    },
    activity: {
      capturedActivities: includeActivity ? [{ ...observedActivity }] : [],
      recommendationServiceReceipts: includeActivity
        ? [{ ...observedActivity }]
        : [],
    },
    recommendations: {
      feedFunctional: true,
      renderedSource: "contextual",
      renderedItemIds: [ITEM_ID],
      recommendationServiceReceipts: [
        {
          source: "contextual",
          itemIds: [ITEM_ID],
        },
      ],
    },
  };
}

function onEvidence(): ExternalEvidenceV1 {
  const observedActivity = activity("article-atlas-passing-on");

  return {
    scenario: "on",
    subjectId: SUBJECT_ID,
    control: {
      uiPreference: "on",
      toggleChecked: true,
      storedPreference: "on",
      backendPreference: "on",
      reloadObserved: true,
    },
    activity: {
      capturedActivities: [{ ...observedActivity }],
      recommendationServiceReceipts: [{ ...observedActivity }],
    },
    recommendations: {
      feedFunctional: true,
      renderedSource: "behavioral",
      renderedItemIds: [ITEM_ID],
      recommendationServiceReceipts: [
        {
          source: "behavioral",
          subjectId: SUBJECT_ID,
          itemIds: [ITEM_ID],
        },
      ],
    },
  };
}

export const brokenOffExample = bundle(offEvidence(true));
export const passingOffExample = bundle(offEvidence(false));
export const passingOnExample = bundle(onEvidence());

export const producerTemplate = `import { readFile, writeFile } from "node:fs/promises";

const [evidenceFile = "external-evidence.json", outputFile = "bundle.json"] =
  process.argv.slice(2);
const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
const bundle = {
  schemaVersion: "1",
  contractFamily: "activity-personalization/v1",
  evidence,
};

await writeFile(
  outputFile,
  \`\${JSON.stringify(bundle, null, 2)}\\n\`,
  { encoding: "utf8", flag: "wx" },
);
`;

export const scaffoldReadme = `# PromiseProof external evidence scaffold

This scaffold supports exactly one contract family:
\`activity-personalization/v1\`.

The public \`ExternalEvidenceV1\` contract contains only facts used by the
unchanged PromiseProof evaluator:

- scenario and subject identifier;
- UI, toggle, storage, backend, and reload control state;
- captured activities and recommendation-service activity receipts;
- rendered feed state and recommendation-service recommendation receipts.

Use \`broken-off.example.json\`, \`passing-off.example.json\`, and
\`passing-on.example.json\` as fixed-shape examples. \`producer-template.mjs\`
wraps an \`ExternalEvidenceV1\` JSON object; it does not collect or attest
evidence. Then verify one bundle:

\`\`\`text
npm run promiseproof -- verify --evidence <bundle.json> --out <directory>
\`\`\`

Or gate OFF and ON together:

\`\`\`text
npm run promiseproof -- gate --off <off.json> --on <on.json> --out <directory>
\`\`\`

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
`;
