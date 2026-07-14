import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  APIRequestContext,
  Page,
  TestInfo,
} from '@playwright/test';

import { DIAGNOSTIC_REPLAYS } from '../../src/shared/diagnostics.js';
import type {
  PersonalizationPreference,
  PreferenceUpdateRequest,
  PreferenceUpdateResponse,
  RunEvidenceLedger,
} from '../../src/shared/types.js';
import {
  runPromiseScenario,
  type ScenarioIds,
  type ScenarioResult,
} from './scenario.js';

interface BackendPreferenceState {
  userId: string;
  preference: PersonalizationPreference;
  updatedAt: string | null;
}

export interface StartupOrderReplayResult {
  replayId: typeof DIAGNOSTIC_REPLAYS.inspectStartupOrder.id;
  scenario: ScenarioResult;
  report: {
    events: string[];
    collectorIndex: number;
    hydrationIndex: number;
    collectorBeforeHydration: boolean;
    activityRequestCount: number;
    activityReceiptCount: number;
    networkEvents: string[];
    activityBeforePreferenceRead: boolean;
  };
}

export interface PreferenceRoundtripReplayResult {
  replayId: typeof DIAGNOSTIC_REPLAYS.inspectPreferenceRoundtrip.id;
  request: PreferenceUpdateRequest;
  write: PreferenceUpdateResponse;
  readback: BackendPreferenceState;
  ledger: RunEvidenceLedger;
  report: {
    requested: 'off';
    acknowledged: PersonalizationPreference;
    authoritativeReadback: PersonalizationPreference;
    receiptRecorded: boolean;
    identityCorrelated: boolean;
    roundtripConsistent: boolean;
  };
}

async function requireOk(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `Unexpected ${response.status()} from ${response.url()}: ${await response.text()}`,
    );
  }
}

async function attachReplay(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
  await testInfo.attach(`${name}.json`, {
    path,
    contentType: 'application/json',
  });
}

export async function runStartupOrderReplay(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  ids: ScenarioIds,
): Promise<StartupOrderReplayResult> {
  const scenario = await runPromiseScenario(page, request, testInfo, 'off', ids);
  const events = scenario.evidence.timestamps.clientTimeline.map(
    (entry) => entry.event,
  );
  const collectorIndex = events.indexOf('collector_started');
  const hydrationIndex = events.indexOf('preference_hydration_started');
  const reloadNetwork = scenario.networkRequestOrder.filter(
    (observation) => observation.phase === 'reload',
  );
  const networkEvents = reloadNetwork.map((observation) => observation.event);
  const activityNetworkIndex = networkEvents.indexOf('activity_post');
  const preferenceReadNetworkIndex = networkEvents.indexOf('preference_read');

  const result: StartupOrderReplayResult = {
    replayId: DIAGNOSTIC_REPLAYS.inspectStartupOrder.id,
    scenario,
    report: {
      events,
      collectorIndex,
      hydrationIndex,
      collectorBeforeHydration:
        collectorIndex >= 0 &&
        hydrationIndex >= 0 &&
        collectorIndex < hydrationIndex,
      activityRequestCount: scenario.evidence.request.activityPayloads.length,
      activityReceiptCount: scenario.evidence.backend.activityReceipts.length,
      networkEvents,
      activityBeforePreferenceRead:
        activityNetworkIndex >= 0 &&
        preferenceReadNetworkIndex >= 0 &&
        activityNetworkIndex < preferenceReadNetworkIndex,
    },
  };

  await attachReplay(
    testInfo,
    `promiseproof-replay-${ids.runId}`,
    { replayId: result.replayId, report: result.report },
  );
  return result;
}

export async function runPreferenceRoundtripReplay(
  request: APIRequestContext,
  testInfo: TestInfo,
  ids: ScenarioIds,
): Promise<PreferenceRoundtripReplayResult> {
  const seed = await request.put(`/api/preferences/${ids.userId}`, {
    data: { preference: 'on', runId: ids.runId },
  });
  await requireOk(seed);

  const clear = await request.delete(`/api/evidence/${ids.runId}`);
  await requireOk(clear);

  const writeResponse = await request.put(`/api/preferences/${ids.userId}`, {
    data: { preference: 'off', runId: ids.runId },
  });
  await requireOk(writeResponse);
  const write = (await writeResponse.json()) as PreferenceUpdateResponse;

  const readResponse = await request.get(`/api/preferences/${ids.userId}`);
  await requireOk(readResponse);
  const readback = (await readResponse.json()) as BackendPreferenceState;

  const ledgerResponse = await request.get(`/api/evidence/${ids.runId}`);
  await requireOk(ledgerResponse);
  const ledger = (await ledgerResponse.json()) as RunEvidenceLedger;
  const writeRequest: PreferenceUpdateRequest = {
    targetUserId: ids.userId,
    payload: { preference: 'off', runId: ids.runId },
  };

  const result: PreferenceRoundtripReplayResult = {
    replayId: DIAGNOSTIC_REPLAYS.inspectPreferenceRoundtrip.id,
    request: writeRequest,
    write,
    readback,
    ledger,
    report: {
      requested: 'off',
      acknowledged: write.preference,
      authoritativeReadback: readback.preference,
      receiptRecorded: ledger.preferenceReceipts.some(
        (receipt) => receipt.receiptId === write.receipt.receiptId,
      ),
      identityCorrelated:
        writeRequest.targetUserId === ids.userId &&
        write.userId === ids.userId &&
        write.receipt.userId === ids.userId &&
        readback.userId === ids.userId,
      roundtripConsistent:
        write.preference === 'off' && readback.preference === 'off',
    },
  };

  await attachReplay(
    testInfo,
    `promiseproof-replay-${ids.runId}`,
    result,
  );
  return result;
}
