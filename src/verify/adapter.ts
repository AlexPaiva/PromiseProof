import type {
  ActivityPayload,
  PromiseEvidence,
  RecommendationReceipt,
} from "../shared/types.js";
import type {
  ExternalActivity,
  ExternalEvidenceV1,
  ExternalRecommendationReceipt,
} from "./schema.js";

const PLACEHOLDER_RUN_ID = "promiseproof-external-adapter";
const PLACEHOLDER_TIMESTAMP = "2000-01-01T00:00:00.000Z";
const PLACEHOLDER_TEXT = "Not part of externally supplied evidence";

function adaptActivity(activity: ExternalActivity): ActivityPayload {
  return {
    runId: activity.runId,
    userId: activity.subjectId,
    eventType: activity.eventType,
    itemId: activity.itemId,
    clientSequence: activity.clientSequence,
    occurredAt: activity.occurredAt,
  };
}

function adaptRecommendationReceipt(
  receipt: ExternalRecommendationReceipt,
  index: number,
): RecommendationReceipt {
  return {
    kind: "recommendation",
    receiptId: `external-recommendation-receipt-${index + 1}`,
    sequence: index + 1,
    receivedAt: PLACEHOLDER_TIMESTAMP,
    source: receipt.source,
    ...(receipt.subjectId === undefined
      ? {}
      : { userId: receipt.subjectId }),
    items: receipt.itemIds.map((id) => ({
      id,
      title: PLACEHOLDER_TEXT,
      description: PLACEHOLDER_TEXT,
      eyebrow: PLACEHOLDER_TEXT,
    })),
  };
}

export function adaptExternalEvidence(
  external: ExternalEvidenceV1,
): PromiseEvidence {
  return {
    scenario: external.scenario,
    runId: PLACEHOLDER_RUN_ID,
    userId: external.subjectId,
    ui: {
      preference: external.control.uiPreference,
      toggleChecked: external.control.toggleChecked,
      feedFunctional: external.recommendations.feedFunctional,
    },
    storage: {
      preference: external.control.storedPreference,
    },
    request: {
      activityPayloads: external.activity.capturedActivities.map(adaptActivity),
      preferenceUpdates: [],
    },
    response: {
      preferenceUpdates: [],
    },
    backend: {
      preference: external.control.backendPreference,
      activityReceipts:
        external.activity.recommendationServiceReceipts.map(
          (activity, index) => ({
            kind: "activity",
            service: "recommendation",
            receiptId: `external-activity-receipt-${index + 1}`,
            sequence: index + 1,
            receivedAt: PLACEHOLDER_TIMESTAMP,
            payload: adaptActivity(activity),
          }),
        ),
      recommendationReceipts:
        external.recommendations.recommendationServiceReceipts.map(
          adaptRecommendationReceipt,
        ),
      preferenceReceipts: [],
    },
    recommendation: {
      source: external.recommendations.renderedSource,
      itemIds: [...external.recommendations.renderedItemIds],
    },
    timestamps: {
      clientTimeline: [],
      activityReceivedAt: [],
      preferenceReceivedAt: [],
      recommendationReceivedAt: [],
    },
    journey: {
      reloadObserved: external.control.reloadObserved,
    },
  };
}
