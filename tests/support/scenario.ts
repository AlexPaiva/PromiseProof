import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  expect,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from '@playwright/test';

import { evaluatePromise } from '../../src/shared/evaluator.js';
import type {
  ActivityPayload,
  ClientTimelineEntry,
  PersonalizationPreference,
  PromiseEvaluation,
  PromiseEvidence,
  PreferenceUpdatePayload,
  PreferenceUpdateRequest,
  PreferenceUpdateResponse,
  RecommendationSource,
  RunEvidenceLedger,
} from '../../src/shared/types.js';

const ACTIVITY_PATH = '/api/recommendations/activity';
const PREFERENCE_PATH = /^\/api\/preferences\/[^/]+$/;

interface BackendPreferenceState {
  userId: string;
  preference: PersonalizationPreference;
  updatedAt: string | null;
}

interface CapturedActivityResponse {
  accepted: boolean;
  receipt: unknown;
}

interface RenderedRecommendation {
  itemId: string | null;
  text: string;
  title: string;
  description: string;
  visible: boolean;
  titleVisible: boolean;
  descriptionVisible: boolean;
}

export type NetworkObservationPhase = 'opt_out' | 'reload' | 'startup';

export interface NetworkRequestObservation {
  sequence: number;
  phase: NetworkObservationPhase;
  event: 'activity_post' | 'preference_read' | 'preference_write';
  targetUserId?: string;
}

export interface ScenarioIds {
  runId: string;
  userId: string;
}

export interface ScenarioResult {
  evidence: PromiseEvidence;
  evaluation: PromiseEvaluation;
  ledger: RunEvidenceLedger;
  backendPreferenceState: BackendPreferenceState;
  networkActivityResponses: CapturedActivityResponse[];
  networkPreferenceResponses: PreferenceUpdateResponse[];
  networkRequestOrder: NetworkRequestObservation[];
  renderedRecommendations: RenderedRecommendation[];
  displayedBackendPreference: PersonalizationPreference;
  browserErrors: string[];
}

function isActivityRequest(request: Request): boolean {
  return (
    request.method() === 'POST' && new URL(request.url()).pathname === ACTIVITY_PATH
  );
}

function isActivityResponse(response: Response): boolean {
  return isActivityRequest(response.request());
}

function isPreferenceRequest(request: Request): boolean {
  return (
    request.method() === 'PUT' &&
    PREFERENCE_PATH.test(new URL(request.url()).pathname)
  );
}

function isPreferenceRead(request: Request): boolean {
  return (
    request.method() === 'GET' &&
    PREFERENCE_PATH.test(new URL(request.url()).pathname)
  );
}

function preferenceTarget(request: Request): string {
  const segment = new URL(request.url()).pathname.split('/').at(-1);
  if (segment === undefined) {
    throw new Error(`Preference request has no target: ${request.url()}`);
  }
  return decodeURIComponent(segment);
}

function isPreferenceResponse(response: Response): boolean {
  return isPreferenceRequest(response.request());
}

function startActivityCapture(page: Page): {
  payloads: ActivityPayload[];
  responses: CapturedActivityResponse[];
  stop: () => Promise<void>;
} {
  const payloads: ActivityPayload[] = [];
  const responses: CapturedActivityResponse[] = [];
  const responseTasks: Promise<void>[] = [];

  const onRequest = (request: Request): void => {
    if (isActivityRequest(request)) {
      payloads.push(request.postDataJSON() as ActivityPayload);
    }
  };
  const onResponse = (response: Response): void => {
    if (!isActivityResponse(response)) {
      return;
    }

    responseTasks.push(
      response.json().then((body: CapturedActivityResponse) => {
        responses.push(body);
      }),
    );
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  return {
    payloads,
    responses,
    stop: async () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      await Promise.all(responseTasks);
    },
  };
}

function startPreferenceCapture(page: Page): {
  requests: PreferenceUpdateRequest[];
  responses: PreferenceUpdateResponse[];
  stop: () => Promise<void>;
} {
  const requests: PreferenceUpdateRequest[] = [];
  const responses: PreferenceUpdateResponse[] = [];
  const responseTasks: Promise<void>[] = [];

  const onRequest = (request: Request): void => {
    if (isPreferenceRequest(request)) {
      requests.push({
        targetUserId: preferenceTarget(request),
        payload: request.postDataJSON() as PreferenceUpdatePayload,
      });
    }
  };
  const onResponse = (response: Response): void => {
    if (!isPreferenceResponse(response)) {
      return;
    }

    responseTasks.push(
      response.json().then((body: PreferenceUpdateResponse) => {
        responses.push(body);
      }),
    );
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  return {
    requests,
    responses,
    stop: async () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      await Promise.all(responseTasks);
    },
  };
}

function startNetworkOrderCapture(
  page: Page,
  initialPhase: NetworkObservationPhase,
): {
  observations: NetworkRequestObservation[];
  setPhase: (phase: NetworkObservationPhase) => void;
  stop: () => void;
} {
  const observations: NetworkRequestObservation[] = [];
  let phase = initialPhase;

  const onRequest = (request: Request): void => {
    let event: NetworkRequestObservation['event'] | undefined;
    if (isActivityRequest(request)) {
      event = 'activity_post';
    } else if (isPreferenceRequest(request)) {
      event = 'preference_write';
    } else if (isPreferenceRead(request)) {
      event = 'preference_read';
    }

    if (event === undefined) {
      return;
    }

    const targetsPreference = event !== 'activity_post';
    observations.push({
      sequence: observations.length + 1,
      phase,
      event,
      ...(targetsPreference ? { targetUserId: preferenceTarget(request) } : {}),
    });
  };

  page.on('request', onRequest);
  return {
    observations,
    setPhase: (nextPhase) => {
      phase = nextPhase;
    },
    stop: () => page.off('request', onRequest),
  };
}

function observeBrowserErrors(page: Page): {
  errors: string[];
  stop: () => void;
} {
  const errors: string[] = [];
  const onConsole = (message: { type: () => string; text: () => string }): void => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  };
  const onPageError = (error: Error): void => {
    errors.push(`pageerror: ${error.message}`);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    errors,
    stop: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

async function requireOk(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `Unexpected ${response.status()} from ${response.url()}: ${await response.text()}`,
    );
  }
}

async function putPreference(
  request: APIRequestContext,
  ids: ScenarioIds,
  preference: PersonalizationPreference,
): Promise<BackendPreferenceState> {
  const response = await request.put(`/api/preferences/${ids.userId}`, {
    data: { preference, runId: ids.runId },
  });
  await requireOk(response);
  return (await response.json()) as BackendPreferenceState;
}

async function clearEvidence(
  request: APIRequestContext,
  runId: string,
): Promise<void> {
  const response = await request.delete(`/api/evidence/${runId}`);
  await requireOk(response);
}

async function readPreference(
  request: APIRequestContext,
  userId: string,
): Promise<BackendPreferenceState> {
  const response = await request.get(`/api/preferences/${userId}`);
  await requireOk(response);
  return (await response.json()) as BackendPreferenceState;
}

async function readLedger(
  request: APIRequestContext,
  runId: string,
): Promise<RunEvidenceLedger> {
  const response = await request.get(`/api/evidence/${runId}`);
  await requireOk(response);
  return (await response.json()) as RunEvidenceLedger;
}

function scenarioUrl(ids: ScenarioIds): string {
  return `/?runId=${encodeURIComponent(ids.runId)}&userId=${encodeURIComponent(ids.userId)}`;
}

async function waitUntilReady(page: Page): Promise<void> {
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('personalization-toggle')).toBeVisible();
  await expect(page.getByTestId('recommendation-source')).toBeVisible();
}

function parsePreference(value: string | null): PersonalizationPreference | null {
  if (value === 'on' || value === 'off') {
    return value;
  }
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === 'on' || parsed === 'off') {
      return parsed;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'preference' in parsed &&
      (parsed.preference === 'on' || parsed.preference === 'off')
    ) {
      return parsed.preference;
    }
  } catch {
    // The raw value remains evidence, but it is not a recognized preference.
  }
  return null;
}

async function readStoredPreference(
  page: Page,
  userId: string,
): Promise<PersonalizationPreference | null> {
  const key = `promiseproof:personalization:${userId}`;
  const raw = await page.evaluate(
    (storageKey) => window.localStorage.getItem(storageKey),
    key,
  );
  return parsePreference(raw);
}

async function readTimeline(page: Page): Promise<ClientTimelineEntry[]> {
  return page.evaluate(() => {
    const timeline = (
      window as Window & { __PP_TIMELINE__?: ClientTimelineEntry[] }
    ).__PP_TIMELINE__;
    return timeline === undefined ? [] : structuredClone(timeline);
  });
}

async function readRenderedRecommendations(
  page: Page,
): Promise<RenderedRecommendation[]> {
  const items = page.getByTestId('recommendation-item');
  const count = await items.count();
  const rendered: RenderedRecommendation[] = [];

  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const title = item.getByTestId('recommendation-item-title');
    const description = item.getByTestId('recommendation-item-description');
    rendered.push({
      itemId: await item.getAttribute('data-item-id'),
      text: (await item.innerText()).trim(),
      title: (await title.innerText()).trim(),
      description: (await description.innerText()).trim(),
      visible: await item.isVisible(),
      titleVisible: await title.isVisible(),
      descriptionVisible: await description.isVisible(),
    });
  }
  return rendered;
}

async function collectResult(
  page: Page,
  request: APIRequestContext,
  ids: ScenarioIds,
  scenario: PersonalizationPreference,
  activityPayloads: ActivityPayload[],
  activityResponses: CapturedActivityResponse[],
  preferenceUpdates: PreferenceUpdateRequest[],
  preferenceResponses: PreferenceUpdateResponse[],
  networkRequestOrder: NetworkRequestObservation[],
  reloadObserved: boolean,
  browserErrors: string[],
): Promise<ScenarioResult> {
  const [ledger, backendPreferenceState, storagePreference, clientTimeline] =
    await Promise.all([
      readLedger(request, ids.runId),
      readPreference(request, ids.userId),
      readStoredPreference(page, ids.userId),
      readTimeline(page),
    ]);

  const renderedRecommendations = await readRenderedRecommendations(page);
  const preferenceValue = await page
    .getByTestId('preference-state')
    .getAttribute('data-state');
  const sourceValue = await page
    .getByTestId('recommendation-source')
    .getAttribute('data-source');
  const displayedBackendPreference = await page
    .getByTestId('backend-preference')
    .getAttribute('data-state');
  const toggleChecked = await page
    .getByTestId('personalization-toggle')
    .isChecked();

  if (preferenceValue !== 'on' && preferenceValue !== 'off') {
    throw new Error(`UI exposed an invalid preference state: ${String(preferenceValue)}`);
  }
  if (sourceValue !== 'contextual' && sourceValue !== 'behavioral') {
    throw new Error(`UI exposed an invalid recommendation source: ${String(sourceValue)}`);
  }
  if (
    displayedBackendPreference !== 'on' &&
    displayedBackendPreference !== 'off'
  ) {
    throw new Error(
      `UI exposed an invalid backend preference: ${String(displayedBackendPreference)}`,
    );
  }

  const recommendationSource: RecommendationSource = sourceValue;
  const matchingReceipt = [...ledger.recommendationReceipts]
    .reverse()
    .find((receipt) => receipt.source === recommendationSource);
  const renderedIds = renderedRecommendations.flatMap((item) =>
    item.itemId === null ? [] : [item.itemId],
  );
  if (renderedIds.length !== renderedRecommendations.length) {
    throw new Error('A rendered recommendation is missing its independent item ID.');
  }
  const itemIds = renderedIds;
  const feedFunctional =
    renderedRecommendations.length > 0 &&
    renderedRecommendations.every(
      (item) =>
        item.visible &&
        item.titleVisible &&
        item.descriptionVisible &&
        item.title.length > 0 &&
        item.description.length > 0,
    );

  const evidence: PromiseEvidence = {
    scenario,
    runId: ids.runId,
    userId: ids.userId,
    ui: {
      preference: preferenceValue,
      toggleChecked,
      feedFunctional,
    },
    storage: { preference: storagePreference },
    request: {
      activityPayloads: [...activityPayloads],
      preferenceUpdates: [...preferenceUpdates],
    },
    response: { preferenceUpdates: [...preferenceResponses] },
    backend: {
      preference: backendPreferenceState.preference,
      activityReceipts: ledger.activityReceipts,
      recommendationReceipts: ledger.recommendationReceipts,
      preferenceReceipts: ledger.preferenceReceipts,
    },
    recommendation: {
      source: recommendationSource,
      itemIds,
    },
    timestamps: {
      clientTimeline,
      activityReceivedAt: ledger.activityReceipts.map((receipt) => receipt.receivedAt),
      preferenceReceivedAt: ledger.preferenceReceipts.map(
        (receipt) => receipt.receivedAt,
      ),
      recommendationReceivedAt: ledger.recommendationReceipts.map(
        (receipt) => receipt.receivedAt,
      ),
    },
    journey: { reloadObserved },
  };

  return {
    evidence,
    evaluation: evaluatePromise(evidence),
    ledger,
    backendPreferenceState,
    networkActivityResponses: [...activityResponses],
    networkPreferenceResponses: [...preferenceResponses],
    networkRequestOrder: [...networkRequestOrder],
    renderedRecommendations,
    displayedBackendPreference,
    browserErrors: [...browserErrors],
  };
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeJson(nested)]),
  );
}

async function attachEvidence(testInfo: TestInfo, result: ScenarioResult): Promise<void> {
  const artifact = normalizeJson({
    schemaVersion: 2,
    evidence: result.evidence,
    evaluation: result.evaluation,
    observations: {
      backendPreferenceState: result.backendPreferenceState,
      browserErrors: result.browserErrors,
      networkActivityResponses: result.networkActivityResponses,
      networkPreferenceResponses: result.networkPreferenceResponses,
      networkRequestOrder: result.networkRequestOrder,
      renderedRecommendations: result.renderedRecommendations,
      runEvidenceLedger: result.ledger,
    },
  });

  const attachmentName = `promiseproof-evidence-${result.evidence.runId}.json`;
  const attachmentPath = testInfo.outputPath(attachmentName);
  await mkdir(dirname(attachmentPath), { recursive: true });
  await writeFile(attachmentPath, JSON.stringify(artifact, null, 2), 'utf8');
  await testInfo.attach(attachmentName, {
    path: attachmentPath,
    contentType: 'application/json',
  });
}

export async function runPromiseScenario(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  scenario: PersonalizationPreference,
  ids: ScenarioIds,
): Promise<ScenarioResult> {
  const browserObservation = observeBrowserErrors(page);
  let activityCapture: ReturnType<typeof startActivityCapture> | undefined;
  let preferenceCapture: ReturnType<typeof startPreferenceCapture> | undefined;
  let networkOrderCapture: ReturnType<typeof startNetworkOrderCapture> | undefined;
  let reloadObserved = false;

  try {
    // Every case starts from the same backend state, even when the same stable IDs
    // are reused in a later test invocation.
    await putPreference(request, ids, 'on');
    await clearEvidence(request, ids.runId);

    if (scenario === 'off') {
      const navigation = await page.goto(scenarioUrl(ids));
      expect(navigation?.ok()).toBe(true);
      await waitUntilReady(page);
      await expect(page.getByTestId('personalization-toggle')).toBeChecked();

      // The OFF observation window begins immediately before the user's click.
      // Initial ON traffic is discarded, but no post-click traffic can be hidden.
      await clearEvidence(request, ids.runId);
      activityCapture = startActivityCapture(page);
      preferenceCapture = startPreferenceCapture(page);
      networkOrderCapture = startNetworkOrderCapture(page, 'opt_out');
      await page.getByTestId('personalization-toggle').click();
      await expect(page.getByTestId('personalization-toggle')).not.toBeChecked();
      await expect(page.getByTestId('preference-state')).toHaveAttribute(
        'data-state',
        'off',
      );
      await expect(page.getByTestId('recommendation-source')).toHaveAttribute(
        'data-source',
        'contextual',
      );
      await expect
        .poll(async () => readStoredPreference(page, ids.userId))
        .toBe('off');
      await expect(page.getByTestId('personalization-toggle')).toBeEnabled();
      networkOrderCapture.setPhase('reload');
      const reload = await page.reload();
      expect(reload?.ok()).toBe(true);
      reloadObserved = true;
      await waitUntilReady(page);
    } else {
      activityCapture = startActivityCapture(page);
      preferenceCapture = startPreferenceCapture(page);
      networkOrderCapture = startNetworkOrderCapture(page, 'startup');
      const navigation = await page.goto(scenarioUrl(ids));
      expect(navigation?.ok()).toBe(true);
      await waitUntilReady(page);
    }

    await activityCapture.stop();
    await preferenceCapture.stop();
    networkOrderCapture.stop();
    const result = await collectResult(
      page,
      request,
      ids,
      scenario,
      activityCapture.payloads,
      activityCapture.responses,
      preferenceCapture.requests,
      preferenceCapture.responses,
      networkOrderCapture.observations,
      reloadObserved,
      browserObservation.errors,
    );
    await attachEvidence(testInfo, result);
    return result;
  } finally {
    if (activityCapture !== undefined) {
      await activityCapture.stop();
    }
    if (preferenceCapture !== undefined) {
      await preferenceCapture.stop();
    }
    networkOrderCapture?.stop();
    browserObservation.stop();
  }
}
