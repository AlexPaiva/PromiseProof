import type { ExternalBundle } from "./schema.js";
import {
  SUPPORTED_CONTRACT_FAMILY,
  SUPPORTED_SCHEMA_VERSION,
} from "./outcome.js";

const USER_ID = "article-atlas-reader-001";
const ITEM_ID = "article-atlas-story-101";
const TIME_PREFERENCE = "2026-01-15T12:00:00.000Z";
const TIME_ACTIVITY = "2026-01-15T12:00:01.000Z";
const TIME_RECOMMENDATION = "2026-01-15T12:00:02.000Z";

function recommendationItem() {
  return {
    id: ITEM_ID,
    title: "A field guide to urban trees",
    description: "A synthetic Article Atlas recommendation.",
    eyebrow: "Article Atlas",
  };
}

function preferenceState(runId: string, preference: "on" | "off") {
  const receipt = {
    kind: "preference" as const,
    receiptId: `${runId}-preference-receipt`,
    sequence: 1,
    receivedAt: TIME_PREFERENCE,
    userId: USER_ID,
    preference,
  };

  return {
    request: {
      targetUserId: USER_ID,
      payload: { runId, preference },
    },
    response: {
      userId: USER_ID,
      preference,
      updatedAt: TIME_PREFERENCE,
      receipt,
    },
    receipt,
  };
}

function activityState(runId: string) {
  const payload = {
    runId,
    userId: USER_ID,
    eventType: "page_view" as const,
    itemId: "article-atlas-origin-001",
    clientSequence: 1,
    occurredAt: TIME_ACTIVITY,
  };

  return {
    payload,
    receipt: {
      kind: "activity" as const,
      service: "recommendation" as const,
      receiptId: `${runId}-activity-receipt`,
      sequence: 2,
      receivedAt: TIME_ACTIVITY,
      payload,
    },
  };
}

function offBundle(includeActivity: boolean): ExternalBundle {
  const runId = includeActivity
    ? "article-atlas-broken-off"
    : "article-atlas-passing-off";
  const preference = preferenceState(runId, "off");
  const activity = activityState(runId);

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    evidence: {
      scenario: "off",
      runId,
      userId: USER_ID,
      ui: {
        preference: "off",
        toggleChecked: false,
        feedFunctional: true,
      },
      storage: { preference: "off" },
      request: {
        activityPayloads: includeActivity ? [activity.payload] : [],
        preferenceUpdates: [preference.request],
      },
      response: {
        preferenceUpdates: [preference.response],
      },
      backend: {
        preference: "off",
        activityReceipts: includeActivity ? [activity.receipt] : [],
        recommendationReceipts: [
          {
            kind: "recommendation",
            receiptId: `${runId}-recommendation-receipt`,
            sequence: 3,
            receivedAt: TIME_RECOMMENDATION,
            source: "contextual",
            items: [recommendationItem()],
          },
        ],
        preferenceReceipts: [preference.receipt],
      },
      recommendation: {
        source: "contextual",
        itemIds: [ITEM_ID],
      },
      timestamps: {
        clientTimeline: [
          {
            sequence: 1,
            event: "preference_restored",
            timestamp: TIME_PREFERENCE,
          },
          {
            sequence: 2,
            event: "recommendations_loaded",
            timestamp: TIME_RECOMMENDATION,
          },
        ],
        activityReceivedAt: includeActivity ? [TIME_ACTIVITY] : [],
        preferenceReceivedAt: [TIME_PREFERENCE],
        recommendationReceivedAt: [TIME_RECOMMENDATION],
      },
      journey: { reloadObserved: true },
    },
  };
}

function onBundle(): ExternalBundle {
  const runId = "article-atlas-passing-on";
  const preference = preferenceState(runId, "on");
  const activity = activityState(runId);

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    evidence: {
      scenario: "on",
      runId,
      userId: USER_ID,
      ui: {
        preference: "on",
        toggleChecked: true,
        feedFunctional: true,
      },
      storage: { preference: "on" },
      request: {
        activityPayloads: [activity.payload],
        preferenceUpdates: [preference.request],
      },
      response: {
        preferenceUpdates: [preference.response],
      },
      backend: {
        preference: "on",
        activityReceipts: [activity.receipt],
        recommendationReceipts: [
          {
            kind: "recommendation",
            receiptId: `${runId}-recommendation-receipt`,
            sequence: 3,
            receivedAt: TIME_RECOMMENDATION,
            source: "behavioral",
            userId: USER_ID,
            items: [recommendationItem()],
          },
        ],
        preferenceReceipts: [preference.receipt],
      },
      recommendation: {
        source: "behavioral",
        itemIds: [ITEM_ID],
      },
      timestamps: {
        clientTimeline: [
          {
            sequence: 1,
            event: "preference_restored",
            timestamp: TIME_PREFERENCE,
          },
          {
            sequence: 2,
            event: "activity_recorded",
            timestamp: TIME_ACTIVITY,
          },
          {
            sequence: 3,
            event: "recommendations_loaded",
            timestamp: TIME_RECOMMENDATION,
          },
        ],
        activityReceivedAt: [TIME_ACTIVITY],
        preferenceReceivedAt: [TIME_PREFERENCE],
        recommendationReceivedAt: [TIME_RECOMMENDATION],
      },
      journey: { reloadObserved: true },
    },
  };
}

export const brokenOffExample = offBundle(true);
export const passingOffExample = offBundle(false);
export const passingOnExample = onBundle();

export const producerTemplate = `import { readFile, writeFile } from "node:fs/promises";

const [evidenceFile = "promise-evidence.json", outputFile = "bundle.json"] =
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

Use \`broken-off.example.json\`, \`passing-off.example.json\`, and
\`passing-on.example.json\` as fixed-shape examples for producing a complete
external evidence bundle. \`producer-template.mjs\` is a small wrapper for a
complete \`PromiseEvidence\` JSON object; it does not collect or attest evidence.
Then verify one bundle:

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
