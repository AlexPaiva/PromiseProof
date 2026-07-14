import { expect, test } from '@playwright/test';

import {
  runPromiseScenario,
  type ScenarioResult,
} from '../support/scenario.js';

const repetitions = [1, 2, 3, 4, 5] as const;
const expectedTimeline = [
  'collector_started',
  'activity_dispatched',
  'activity_received',
  'preference_hydration_started',
  'preference_hydration_completed',
  'recommendation_rendered',
];

function hasValidOrderedTimestamps(result: ScenarioResult): boolean {
  const client = result.evidence.timestamps.clientTimeline;
  const allTimestamps = [
    ...client.map((entry) => entry.timestamp),
    ...result.evidence.timestamps.activityReceivedAt,
    ...result.evidence.timestamps.recommendationReceivedAt,
  ];

  return (
    allTimestamps.length > 0 &&
    allTimestamps.every((timestamp) => Number.isFinite(Date.parse(timestamp))) &&
    client.every(
      (entry, index) =>
        index === 0 ||
        Date.parse(client[index - 1]?.timestamp ?? '') <= Date.parse(entry.timestamp),
    )
  );
}

function structuralSignature(result: ScenarioResult): Record<string, unknown> {
  const activityReceipt = result.evidence.backend.activityReceipts[0];
  const recommendationReceipt = result.evidence.backend.recommendationReceipts[0];
  const hydration = result.evidence.timestamps.clientTimeline.find(
    (entry) => entry.event === 'preference_hydration_completed',
  );

  return {
    scenario: result.evidence.scenario,
    state: {
      ui: result.evidence.ui.preference,
      storage: result.evidence.storage.preference,
      backend: result.evidence.backend.preference,
    },
    activity: {
      requestCount: result.evidence.request.activityPayloads.length,
      responseCount: result.networkActivityResponses.length,
      backendReceiptCount: result.evidence.backend.activityReceipts.length,
      acceptedResponses: result.networkActivityResponses.every(
        (response) => response.accepted,
      ),
      identifiesExpectedUser: result.evidence.request.activityPayloads.every(
        (payload) => payload.userId === result.evidence.userId,
      ),
      payloadReachedBackend:
        activityReceipt !== undefined &&
        JSON.stringify(activityReceipt.payload) ===
          JSON.stringify(result.evidence.request.activityPayloads[0]),
      receiptService: activityReceipt?.service ?? null,
    },
    recommendation: {
      source: result.evidence.recommendation.source,
      renderedItemCount: result.evidence.recommendation.itemIds.length,
      backendReceiptCount:
        result.evidence.backend.recommendationReceipts.length,
      receiptSource: recommendationReceipt?.source ?? null,
      receiptUserId: recommendationReceipt?.userId ?? null,
      renderedItemsMatchReceipt:
        JSON.stringify(recommendationReceipt?.items.map((item) => item.id) ?? []) ===
        JSON.stringify(result.evidence.recommendation.itemIds),
    },
    causalOrder: {
      timeline: result.evidence.timestamps.clientTimeline.map(
        (entry) => entry.event,
      ),
      hydratedPreference: hydration?.detail?.preference ?? null,
      timestampsValidAndOrdered: hasValidOrderedTimestamps(result),
    },
    evaluation: {
      verdict: result.evaluation.verdict,
      violations: result.evaluation.violations.map((item) => item.code),
      clauses: result.evaluation.clauses.map(
        (item) => `${item.id}:${String(item.passed)}`,
      ),
    },
    browserErrorCount: result.browserErrors.length,
  };
}

const expectedOffSignature = {
  scenario: 'off',
  state: { ui: 'off', storage: 'off', backend: 'off' },
  activity: {
    requestCount: 1,
    responseCount: 1,
    backendReceiptCount: 1,
    acceptedResponses: true,
    identifiesExpectedUser: true,
    payloadReachedBackend: true,
    receiptService: 'recommendation',
  },
  recommendation: {
    source: 'contextual',
    renderedItemCount: 3,
    backendReceiptCount: 1,
    receiptSource: 'contextual',
    receiptUserId: null,
    renderedItemsMatchReceipt: true,
  },
  causalOrder: {
    timeline: expectedTimeline,
    hydratedPreference: 'off',
    timestampsValidAndOrdered: true,
  },
  evaluation: {
    verdict: 'fail',
    violations: ['PP_IDENTIFIABLE_EVENT_LEAK'],
    clauses: [
      'no_identifiable_activity:false',
      'contextual_feed_functional:true',
      'preference_survives_reload:true',
    ],
  },
  browserErrorCount: 0,
};

const expectedOnSignature = {
  scenario: 'on',
  state: { ui: 'on', storage: 'on', backend: 'on' },
  activity: {
    requestCount: 1,
    responseCount: 1,
    backendReceiptCount: 1,
    acceptedResponses: true,
    identifiesExpectedUser: true,
    payloadReachedBackend: true,
    receiptService: 'recommendation',
  },
  recommendation: {
    source: 'behavioral',
    renderedItemCount: 3,
    backendReceiptCount: 1,
    receiptSource: 'behavioral',
    receiptUserId: '__expected-user__',
    renderedItemsMatchReceipt: true,
  },
  causalOrder: {
    timeline: expectedTimeline,
    hydratedPreference: 'on',
    timestampsValidAndOrdered: true,
  },
  evaluation: {
    verdict: 'pass',
    violations: [],
    clauses: [
      'expected_activity_received:true',
      'behavioral_feed_functional:true',
    ],
  },
  browserErrorCount: 0,
};

for (const repetition of repetitions) {
  const suffix = String(repetition).padStart(2, '0');

  test(`OFF repetition ${suffix} matches the complete seeded-race signature`, async ({
    browser,
    request,
  }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const result = await runPromiseScenario(page, request, testInfo, 'off', {
        runId: `determinism-off-${suffix}`,
        userId: `demo-user-off-${suffix}`,
      });

      expect(structuralSignature(result)).toEqual(expectedOffSignature);
    } finally {
      await context.close();
    }
  });
}

for (const repetition of repetitions) {
  const suffix = String(repetition).padStart(2, '0');
  const userId = `demo-user-on-${suffix}`;

  test(`ON repetition ${suffix} matches the complete behavioral signature`, async ({
    browser,
    request,
  }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const result = await runPromiseScenario(page, request, testInfo, 'on', {
        runId: `determinism-on-${suffix}`,
        userId,
      });
      const signature = structuralSignature(result);
      const expected = structuredClone(expectedOnSignature);
      expected.recommendation.receiptUserId = userId;

      expect(signature).toEqual(expected);
    } finally {
      await context.close();
    }
  });
}
