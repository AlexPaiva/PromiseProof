import { expect, test } from '@playwright/test';

import { runPromiseScenario } from '../support/scenario.js';
import {
  expectedOnSignature,
  expectedPropagationOffSignature,
  structuralSignature,
} from '../support/signatures.js';

const repetitions = [1, 2, 3, 4, 5] as const;
const onTimeline = [
  'preference_hydration_started',
  'preference_hydration_completed',
  'collector_started',
  'activity_dispatched',
  'activity_received',
  'recommendation_rendered',
];

for (const repetition of repetitions) {
  const suffix = String(repetition).padStart(2, '0');

  test(`OFF repetition ${suffix} matches the complete round-trip signature`, async ({
    browser,
    request,
  }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const result = await runPromiseScenario(page, request, testInfo, 'off', {
        runId: `determinism-off-${suffix}`,
        userId: `synthetic-subject-${suffix}`,
      });

      expect(structuralSignature(result)).toEqual(
        expectedPropagationOffSignature,
      );
    } finally {
      await context.close();
    }
  });
}

for (const repetition of repetitions) {
  const suffix = String(repetition).padStart(2, '0');

  test(`ON repetition ${suffix} matches the complete behavioral signature`, async ({
    browser,
    request,
  }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const result = await runPromiseScenario(page, request, testInfo, 'on', {
        runId: `determinism-on-${suffix}`,
        userId: `synthetic-control-${suffix}`,
      });

      expect(structuralSignature(result)).toEqual(
        expectedOnSignature(onTimeline),
      );
    } finally {
      await context.close();
    }
  });
}
