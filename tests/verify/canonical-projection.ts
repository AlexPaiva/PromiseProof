import type {
  ActivityPayload,
  PromiseEvidence,
  RecommendationReceipt,
} from "../../src/shared/types.js";
import type { ExternalEvidenceV1 } from "../../src/verify/schema.js";

const USER_ID = "canonical-reader-001";
const ITEM_ID = "canonical-item-001";
const ACTIVITY_TIME = "2026-01-15T12:00:01.000Z";
const RECEIPT_TIME = "2026-01-15T12:00:02.000Z";

function activity(runId: string): ActivityPayload {
  return {
    runId,
    userId: USER_ID,
    eventType: "page_view",
    itemId: "canonical-origin-001",
    clientSequence: 1,
    occurredAt: ACTIVITY_TIME,
  };
}

function recommendationReceipt(
  source: "contextual" | "behavioral",
  userId: string | undefined,
  itemIds: string[],
): RecommendationReceipt {
  return {
    kind: "recommendation",
    receiptId: `canonical-${source}-receipt`,
    sequence: 2,
    receivedAt: RECEIPT_TIME,
    source,
    ...(userId === undefined ? {} : { userId }),
    items: itemIds.map((id) => ({
      id,
      title: "Canonical fixture item",
      description: "Canonical fixture description",
      eyebrow: "Canonical fixture",
    })),
  };
}

function canonicalOff(runId: string): PromiseEvidence {
  return {
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
      activityPayloads: [],
      preferenceUpdates: [],
    },
    response: { preferenceUpdates: [] },
    backend: {
      preference: "off",
      activityReceipts: [],
      recommendationReceipts: [
        recommendationReceipt("contextual", undefined, [ITEM_ID]),
      ],
      preferenceReceipts: [],
    },
    recommendation: {
      source: "contextual",
      itemIds: [ITEM_ID],
    },
    timestamps: {
      clientTimeline: [],
      activityReceivedAt: [],
      preferenceReceivedAt: [],
      recommendationReceivedAt: [],
    },
    journey: { reloadObserved: true },
  };
}

function canonicalOn(runId: string): PromiseEvidence {
  const observedActivity = activity(runId);
  return {
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
      activityPayloads: [observedActivity],
      preferenceUpdates: [],
    },
    response: { preferenceUpdates: [] },
    backend: {
      preference: "on",
      activityReceipts: [
        {
          kind: "activity",
          service: "recommendation",
          receiptId: "canonical-activity-receipt",
          sequence: 1,
          receivedAt: RECEIPT_TIME,
          payload: observedActivity,
        },
      ],
      recommendationReceipts: [
        recommendationReceipt("behavioral", USER_ID, [ITEM_ID]),
      ],
      preferenceReceipts: [],
    },
    recommendation: {
      source: "behavioral",
      itemIds: [ITEM_ID],
    },
    timestamps: {
      clientTimeline: [],
      activityReceivedAt: [RECEIPT_TIME],
      preferenceReceivedAt: [],
      recommendationReceivedAt: [RECEIPT_TIME],
    },
    journey: { reloadObserved: true },
  };
}

const passingOff = canonicalOff("canonical-passing-off");
const initializationRace = structuredClone(passingOff);
initializationRace.runId = "canonical-initialization-race";
const leakedActivity = activity(initializationRace.runId);
initializationRace.request.activityPayloads = [leakedActivity];
initializationRace.backend.activityReceipts = [
  {
    kind: "activity",
    service: "recommendation",
    receiptId: "canonical-leak-receipt",
    sequence: 1,
    receivedAt: RECEIPT_TIME,
    payload: leakedActivity,
  },
];

const propagationFailure = structuredClone(passingOff);
propagationFailure.runId = "canonical-propagation-failure";
propagationFailure.backend.preference = "on";

const passingOn = canonicalOn("canonical-passing-on");
const brokenOnMissingActivity = structuredClone(passingOn);
brokenOnMissingActivity.runId = "canonical-broken-on";
brokenOnMissingActivity.backend.activityReceipts = [];

const contextualFeedFailure = structuredClone(passingOff);
contextualFeedFailure.runId = "canonical-contextual-feed-failure";
contextualFeedFailure.backend.recommendationReceipts = [];

const behavioralFeedFailure = structuredClone(passingOn);
behavioralFeedFailure.runId = "canonical-behavioral-feed-failure";
behavioralFeedFailure.backend.recommendationReceipts = [];

const reloadPersistenceFailure = structuredClone(passingOff);
reloadPersistenceFailure.runId = "canonical-reload-failure";
reloadPersistenceFailure.journey.reloadObserved = false;

export const canonicalCases = {
  initializationRace,
  passingOff,
  propagationFailure,
  passingOn,
  brokenOnMissingActivity,
  contextualFeedFailure,
  behavioralFeedFailure,
  reloadPersistenceFailure,
} as const;

export function projectCanonicalEvidence(
  evidence: PromiseEvidence,
): ExternalEvidenceV1 {
  return {
    scenario: evidence.scenario,
    subjectId: evidence.userId,
    control: {
      uiPreference: evidence.ui.preference,
      toggleChecked: evidence.ui.toggleChecked,
      storedPreference: evidence.storage.preference,
      backendPreference: evidence.backend.preference,
      reloadObserved: evidence.journey.reloadObserved,
    },
    activity: {
      capturedActivities: evidence.request.activityPayloads.map((payload) => ({
        runId: payload.runId,
        subjectId: payload.userId,
        eventType: payload.eventType,
        itemId: payload.itemId,
        clientSequence: payload.clientSequence,
        occurredAt: payload.occurredAt,
      })),
      recommendationServiceReceipts: evidence.backend.activityReceipts.map(
        (receipt) => ({
          runId: receipt.payload.runId,
          subjectId: receipt.payload.userId,
          eventType: receipt.payload.eventType,
          itemId: receipt.payload.itemId,
          clientSequence: receipt.payload.clientSequence,
          occurredAt: receipt.payload.occurredAt,
        }),
      ),
    },
    recommendations: {
      feedFunctional: evidence.ui.feedFunctional,
      renderedSource: evidence.recommendation.source,
      renderedItemIds: [...evidence.recommendation.itemIds],
      recommendationServiceReceipts:
        evidence.backend.recommendationReceipts.map((receipt) => ({
          source: receipt.source,
          ...(receipt.userId === undefined
            ? {}
            : { subjectId: receipt.userId }),
          itemIds: receipt.items.map((item) => item.id),
        })),
    },
  };
}
