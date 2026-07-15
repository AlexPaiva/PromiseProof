import type {
  APIRequestContext,
  Page,
  TestInfo,
} from '@playwright/test';

import type { ReplayExecutors } from '../../src/investigation/dispatcher.js';
import {
  runPreferenceRoundtripReplay,
  runStartupOrderReplay,
} from './diagnostic-replays.js';
import type { ScenarioIds } from './scenario.js';

/**
 * Adapt the existing browser/API diagnostics to the deliberately narrow
 * investigation dispatcher. The model-facing boundary receives only each
 * replay's factual report; journey objects, identity-bearing requests, and the
 * backend ledger remain on the deterministic side of the boundary.
 */
export function createInvestigationReplayExecutors(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  ids: ScenarioIds,
): ReplayExecutors {
  return {
    inspect_startup_order: async () => {
      const result = await runStartupOrderReplay(page, request, testInfo, ids);
      if (result.scenario.browserErrors.length > 0) {
        throw new Error(
          `Startup-order replay encountered browser errors: ${result.scenario.browserErrors.join('; ')}`,
        );
      }
      return result.report;
    },
    inspect_preference_roundtrip: async () => {
      const result = await runPreferenceRoundtripReplay(request, testInfo, ids);
      return result.report;
    },
  };
}
