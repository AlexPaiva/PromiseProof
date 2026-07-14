import type {
  ActivityPayload,
  PromiseClauseResult,
  PromiseEvaluation,
  PromiseEvidence,
  PromiseViolation,
} from "./types.js";

function clause(
  id: PromiseClauseResult["id"],
  passed: boolean,
  expected: string,
  observed: string,
): PromiseClauseResult {
  return { id, passed, expected, observed };
}

function violation(
  code: PromiseViolation["code"],
  clauseId: PromiseViolation["clause"],
  message: string,
): PromiseViolation {
  return { code, clause: clauseId, message };
}

function sameItemIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((itemId, index) => itemId === right[index])
  );
}

function sameActivity(left: ActivityPayload, right: ActivityPayload): boolean {
  return (
    left.runId === right.runId &&
    left.userId === right.userId &&
    left.eventType === right.eventType &&
    left.itemId === right.itemId &&
    left.clientSequence === right.clientSequence &&
    left.occurredAt === right.occurredAt
  );
}

export function evaluatePromise(evidence: PromiseEvidence): PromiseEvaluation {
  const clauses: PromiseClauseResult[] = [];
  const violations: PromiseViolation[] = [];

  if (evidence.scenario === "off") {
    const identifiableReceipts = evidence.backend.activityReceipts.filter(
      (receipt) => receipt.service === "recommendation" && receipt.payload.userId.length > 0,
    );
    const identifiableRequests = evidence.request.activityPayloads.filter(
      (payload) => payload.userId.length > 0,
    );
    const noIdentifiableActivity =
      identifiableRequests.length === 0 && identifiableReceipts.length === 0;

    clauses.push(
      clause(
        "no_identifiable_activity",
        noIdentifiableActivity,
        "0 identifiable activity requests and 0 receipts at the recommendation service",
        `${identifiableRequests.length} captured request(s), ${identifiableReceipts.length} backend receipt(s)`,
      ),
    );
    if (!noIdentifiableActivity) {
      violations.push(
        violation(
          "PP_IDENTIFIABLE_EVENT_LEAK",
          "no_identifiable_activity",
          "Activity-based personalization was OFF, but the recommendation service received identifiable activity.",
        ),
      );
    }

    const contextualReceipt = evidence.backend.recommendationReceipts.find(
      (receipt) =>
        receipt.source === "contextual" &&
        receipt.userId === undefined &&
        sameItemIds(
          receipt.items.map((item) => item.id),
          evidence.recommendation.itemIds,
        ),
    );
    const contextualFeed =
      evidence.ui.feedFunctional &&
      evidence.recommendation.source === "contextual" &&
      evidence.recommendation.itemIds.length > 0 &&
      contextualReceipt !== undefined;
    clauses.push(
      clause(
        "contextual_feed_functional",
        contextualFeed,
        "a non-empty contextual recommendation feed",
        `${evidence.recommendation.source} feed with ${evidence.recommendation.itemIds.length} item(s); backend receipt match=${String(contextualReceipt !== undefined)}`,
      ),
    );
    if (!contextualFeed) {
      violations.push(
        violation(
          "PP_CONTEXTUAL_FEED_MISSING",
          "contextual_feed_functional",
          "The OFF experience did not retain a functional contextual feed.",
        ),
      );
    }

    const preferencePersisted =
      evidence.journey.reloadObserved &&
      evidence.ui.preference === "off" &&
      !evidence.ui.toggleChecked &&
      evidence.storage.preference === "off" &&
      evidence.backend.preference === "off";
    clauses.push(
      clause(
        "preference_survives_reload",
        preferencePersisted,
        "a witnessed reload followed by OFF in the UI, browser storage, and backend",
        `reload=${String(evidence.journey.reloadObserved)}, ui=${evidence.ui.preference}, toggleChecked=${String(evidence.ui.toggleChecked)}, storage=${String(evidence.storage.preference)}, backend=${evidence.backend.preference}`,
      ),
    );
    if (!preferencePersisted) {
      violations.push(
        violation(
          "PP_PREFERENCE_NOT_PERSISTED",
          "preference_survives_reload",
          "The OFF preference did not survive reload across all state boundaries.",
        ),
      );
    }
  } else {
    const expectedRequest = evidence.request.activityPayloads.find(
      (payload) => payload.userId === evidence.userId,
    );
    const expectedActivity =
      expectedRequest !== undefined &&
      evidence.backend.activityReceipts.some(
        (receipt) =>
          receipt.payload.userId === evidence.userId &&
          sameActivity(receipt.payload, expectedRequest),
    );
    clauses.push(
      clause(
        "expected_activity_received",
        expectedActivity,
        `activity for ${evidence.userId} at the recommendation service`,
        `${evidence.request.activityPayloads.length} captured request(s), ${evidence.backend.activityReceipts.length} backend receipt(s), correlated=${String(expectedActivity)}`,
      ),
    );
    if (!expectedActivity) {
      violations.push(
        violation(
          "PP_EXPECTED_ACTIVITY_MISSING",
          "expected_activity_received",
          "Personalization was ON, but expected behavioral activity was not received.",
        ),
      );
    }

    const behavioralReceipt = evidence.backend.recommendationReceipts.find(
      (receipt) =>
        receipt.source === "behavioral" &&
        receipt.userId === evidence.userId &&
        sameItemIds(
          receipt.items.map((item) => item.id),
          evidence.recommendation.itemIds,
        ),
    );
    const behavioralFeed =
      evidence.ui.feedFunctional &&
      evidence.recommendation.source === "behavioral" &&
      evidence.recommendation.itemIds.length > 0 &&
      behavioralReceipt !== undefined;
    clauses.push(
      clause(
        "behavioral_feed_functional",
        behavioralFeed,
        "a non-empty behavioral recommendation feed",
        `${evidence.recommendation.source} feed with ${evidence.recommendation.itemIds.length} item(s); backend receipt match=${String(behavioralReceipt !== undefined)}`,
      ),
    );
    if (!behavioralFeed) {
      violations.push(
        violation(
          "PP_BEHAVIORAL_FEED_MISSING",
          "behavioral_feed_functional",
          "The ON experience did not produce a functional behavioral feed.",
        ),
      );
    }
  }

  return {
    verdict: violations.length === 0 ? "pass" : "fail",
    clauses,
    violations,
  };
}

export function formatViolations(evaluation: PromiseEvaluation): string {
  if (evaluation.violations.length === 0) {
    return "Promise verified.";
  }

  return evaluation.violations
    .map((item) => `${item.code}: ${item.message}`)
    .join("\n");
}
