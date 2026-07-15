import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson } from '../../src/investigation/canonical-json.js';
import {
  buildInvestigationDossierV1,
  normalizeReplayOutputV1,
} from '../../src/investigation/dossier.js';
import {
  ReplayDispatcher,
  ReplayDispatchError,
  type ReplayExecutors,
} from '../../src/investigation/dispatcher.js';
import type {
  InvestigationDossierV1,
  InvestigationResultV1,
  NormalizedReplayOutputV1,
  ReplayToolArgumentsV1,
  StartupOrderReplayReportV1,
} from '../../src/investigation/contracts.js';
import type {
  ConclusionProviderResponse,
  InvestigationProvider,
  ReplaySelectionProviderResponse,
} from '../../src/investigation/provider.js';
import { InvestigationProviderError } from '../../src/investigation/provider.js';
import {
  FINAL_INSTRUCTIONS,
  INITIAL_INSTRUCTIONS,
} from '../../src/investigation/prompt.js';
import { runInvestigation } from '../../src/investigation/runner.js';
import {
  investigationDossierV1Schema,
  investigationResultV1Schema,
  replayToolArgumentsV1Schema,
} from '../../src/investigation/schemas.js';
import {
  validateConclusion,
  validateReplaySelection,
} from '../../src/investigation/validation.js';
import type { PromiseEvidence } from '../../src/shared/types.js';
import { DeterministicInvestigationProvider } from '../support/deterministic-investigation-provider.js';

const FORBIDDEN_SENTINELS = [
  'initialization-race',
  'propagation-failure',
  'DEMO_MODE',
  'selectedFixture',
  '/api/configuration',
  '/api/health',
  'OPENAI_API_KEY',
  'process.env',
  'Authorization: Bearer secret',
  'C:\\private\\src\\server\\main.ts',
  'tests/contracts/personalization-off.spec.ts',
  'server log: seeded root cause',
  'evidence-screen.png',
  'journey-video.webm',
  'trace.zip',
  'raw-secret-sentinel',
] as const;

const RAW_SENTINEL = FORBIDDEN_SENTINELS.join(' | ');

function assertDeepFrozen(value: unknown, path = 'value'): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${path}.${key}`);
  }
}

function activityEvidence(): PromiseEvidence {
  const payload = {
    runId: RAW_SENTINEL,
    userId: RAW_SENTINEL,
    eventType: 'page_view' as const,
    itemId: RAW_SENTINEL,
    clientSequence: 1,
    occurredAt: RAW_SENTINEL,
  };
  const recommendationItem = {
    id: 'context-card-1',
    title: RAW_SENTINEL,
    description: RAW_SENTINEL,
    eyebrow: RAW_SENTINEL,
  };

  return {
    scenario: 'off',
    runId: RAW_SENTINEL,
    userId: RAW_SENTINEL,
    ui: {
      preference: 'off',
      toggleChecked: false,
      feedFunctional: true,
    },
    storage: { preference: 'off' },
    request: {
      activityPayloads: [payload],
      preferenceUpdates: [],
    },
    response: { preferenceUpdates: [] },
    backend: {
      preference: 'off',
      activityReceipts: [
        {
          kind: 'activity',
          service: 'recommendation',
          receiptId: RAW_SENTINEL,
          sequence: 1,
          receivedAt: RAW_SENTINEL,
          payload,
        },
      ],
      recommendationReceipts: [
        {
          kind: 'recommendation',
          receiptId: RAW_SENTINEL,
          sequence: 2,
          receivedAt: RAW_SENTINEL,
          source: 'contextual',
          items: [recommendationItem],
        },
      ],
      preferenceReceipts: [],
    },
    recommendation: {
      source: 'contextual',
      itemIds: [recommendationItem.id],
    },
    timestamps: {
      clientTimeline: [
        {
          sequence: 1,
          event: 'collector_started',
          timestamp: RAW_SENTINEL,
          detail: {
            hiddenConfiguration: RAW_SENTINEL,
            hiddenServerLog: RAW_SENTINEL,
          },
        },
        {
          sequence: 2,
          event: 'activity_dispatched',
          timestamp: RAW_SENTINEL,
          detail: { rawArtifactPath: RAW_SENTINEL },
        },
        {
          sequence: 3,
          event: 'preference_hydration_started',
          timestamp: RAW_SENTINEL,
        },
        {
          sequence: 4,
          event: 'preference_hydration_completed',
          timestamp: RAW_SENTINEL,
        },
        {
          sequence: 5,
          event: 'recommendation_rendered',
          timestamp: RAW_SENTINEL,
        },
      ],
      activityReceivedAt: [RAW_SENTINEL],
      preferenceReceivedAt: [],
      recommendationReceivedAt: [RAW_SENTINEL],
    },
    journey: { reloadObserved: true },
  };
}

function preferenceEvidence(): PromiseEvidence {
  const evidence = structuredClone(activityEvidence());
  evidence.request.activityPayloads = [];
  evidence.backend.activityReceipts = [];
  evidence.backend.preference = 'on';
  evidence.timestamps.activityReceivedAt = [];
  evidence.timestamps.clientTimeline = [
    {
      sequence: 1,
      event: 'preference_sync_dispatched',
      timestamp: RAW_SENTINEL,
      detail: { excludedRawContext: RAW_SENTINEL },
    },
    {
      sequence: 2,
      event: 'preference_sync_acknowledged',
      timestamp: RAW_SENTINEL,
    },
    {
      sequence: 3,
      event: 'backend_preference_observed',
      timestamp: RAW_SENTINEL,
    },
    {
      sequence: 4,
      event: 'recommendation_rendered',
      timestamp: RAW_SENTINEL,
    },
  ];
  return evidence;
}

function startupReport(): StartupOrderReplayReportV1 {
  return {
    events: [
      'collector_started',
      'activity_dispatched',
      'preference_hydration_started',
      'preference_hydration_completed',
      'recommendation_rendered',
    ],
    collectorIndex: 0,
    hydrationIndex: 2,
    collectorBeforeHydration: true,
    activityRequestCount: 1,
    activityReceiptCount: 1,
    networkEvents: ['activity_post', 'preference_read'],
    activityBeforePreferenceRead: true,
  };
}

async function validSelection(
  dossier: InvestigationDossierV1,
): Promise<{
  provider: DeterministicInvestigationProvider;
  response: ReplaySelectionProviderResponse;
  arguments: ReplayToolArgumentsV1;
}> {
  const provider = new DeterministicInvestigationProvider();
  const response = await provider.requestReplay(dossier);
  const rawArguments = response.toolCalls[0]?.arguments;
  assert.notEqual(rawArguments, undefined);
  return {
    provider,
    response,
    arguments: JSON.parse(rawArguments as string) as ReplayToolArgumentsV1,
  };
}

function withArguments(
  response: ReplaySelectionProviderResponse,
  value: unknown,
): ReplaySelectionProviderResponse {
  const call = response.toolCalls[0];
  assert.notEqual(call, undefined);
  return {
    ...response,
    toolCalls: [{ ...call!, arguments: JSON.stringify(value) }],
  };
}

function rejectionCodes(
  result: ReturnType<typeof validateReplaySelection>,
): string[] {
  assert.equal(result.accepted, false);
  return result.decisions
    .filter((decision) => !decision.accepted)
    .map((decision) => decision.code);
}

function conclusionRejectionCodes(
  result: ReturnType<typeof validateConclusion>,
): string[] {
  assert.equal(result.accepted, false);
  return result.decisions
    .filter((decision) => !decision.accepted)
    .map((decision) => decision.code);
}

async function validConclusion(
  dossier: InvestigationDossierV1,
): Promise<{
  initial: ReplayToolArgumentsV1;
  replay: NormalizedReplayOutputV1;
  response: ConclusionProviderResponse;
  result: InvestigationResultV1;
}> {
  const selection = await validSelection(dossier);
  assert.equal(selection.arguments.replayId, 'inspect_startup_order');
  const replay = normalizeReplayOutputV1(
    'inspect_startup_order',
    startupReport(),
  );
  const response = await selection.provider.requestConclusion({
    previousResponseId: selection.response.responseId,
    callId: selection.response.toolCalls[0]!.callId,
    replayOutput: replay,
  });
  return {
    initial: selection.arguments,
    replay,
    response,
    result: JSON.parse(response.outputText) as InvestigationResultV1,
  };
}

test('the exact OpenAI requests contain only the allowlisted dossier and replay report', async () => {
  let fetchCalls = 0;
  let fetchedUrl = '';
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/fabricated-openai';
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    fetchedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    throw new Error('Network access is forbidden in ordinary investigation tests.');
  }) as typeof fetch;

  try {
    const providerModule = await import(
      '../../src/investigation/openai-provider.js'
    );
    assert.equal(fetchCalls, 0, 'importing the provider must not access the network');

    assert.deepEqual(
      providerModule.summarizeResponseDiagnostics({
        output: [
          { type: 'reasoning', status: 'completed' },
          { type: 'function_call', status: 'in_progress' },
          {
            type: 'message',
            status: 'incomplete',
            content: [{ type: 'output_text' }, { type: 'refusal' }],
          },
        ],
        incomplete_details: { reason: 'max_output_tokens' },
        error: { code: 'sanitized-to-presence-only' },
      } as never),
      {
        outputItems: [
          { type: 'reasoning', status: 'completed', contentTypes: [] },
          { type: 'function_call', status: 'in_progress', contentTypes: [] },
          {
            type: 'message',
            status: 'incomplete',
            contentTypes: ['output_text', 'refusal'],
          },
        ],
        refusalPresent: true,
        incompleteReason: 'max_output_tokens',
        errorPresent: true,
      },
      'raw provider output must be reduced to structural item summaries only',
    );

    const dossier = buildInvestigationDossierV1(activityEvidence());
    const replay = normalizeReplayOutputV1(
      'inspect_startup_order',
      startupReport(),
    );
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.report), true);
    const initialRequest = providerModule.buildInitialOpenAIRequest(dossier);
    const finalRequest = providerModule.buildFinalOpenAIRequest(
      'response-opaque',
      'call-opaque',
      replay,
    );
    const serialized = JSON.stringify({ initialRequest, finalRequest });

    for (const sentinel of FORBIDDEN_SENTINELS) {
      assert.equal(
        serialized.includes(sentinel),
        false,
        `model request leaked forbidden sentinel: ${sentinel}`,
      );
    }
    assert.doesNotMatch(serialized, /\b(?:fixture|race|propagation)\b/i);
    assert.doesNotMatch(serialized, /(?:\.png|\.webm|trace\.zip|\bsrc[\\/])/i);

    assert.equal(initialRequest.model, 'gpt-5.6');
    assert.equal(initialRequest.instructions, INITIAL_INSTRUCTIONS);
    assert.equal(initialRequest.input, canonicalJson(dossier));
    assert.equal(initialRequest.parallel_tool_calls, false);
    assert.deepEqual(initialRequest.reasoning, { effort: 'low' });
    assert.equal(initialRequest.max_output_tokens, 3_000);
    assert.equal(initialRequest.store, true);
    assert.deepEqual(initialRequest.tool_choice, {
      type: 'function',
      name: 'run_diagnostic_replay',
    });
    assert.equal(initialRequest.tools?.length, 1);
    const tool = initialRequest.tools?.[0] as
      | { type?: string; name?: string; strict?: boolean; parameters?: unknown }
      | undefined;
    assert.equal(tool?.type, 'function');
    assert.equal(tool?.name, 'run_diagnostic_replay');
    assert.equal(tool?.strict, true);
    assert.equal(typeof tool?.parameters, 'object');
    assert.equal(
      (tool?.parameters as { type?: string } | undefined)?.type,
      'object',
    );
    assert.equal(
      (tool?.parameters as { additionalProperties?: boolean } | undefined)
        ?.additionalProperties,
      false,
    );
    assert.equal(finalRequest.model, 'gpt-5.6');
    assert.equal(finalRequest.previous_response_id, 'response-opaque');
    assert.equal(finalRequest.instructions, FINAL_INSTRUCTIONS);
    assert.deepEqual(finalRequest.input, [
      {
        type: 'function_call_output',
        call_id: 'call-opaque',
        output: canonicalJson(replay),
      },
    ]);
    assert.deepEqual(finalRequest.reasoning, { effort: 'low' });
    assert.equal(finalRequest.max_output_tokens, 3_000);
    assert.equal(finalRequest.store, true);
    assert.equal('tools' in finalRequest, false);
    assert.equal('tool_choice' in finalRequest, false);
    assert.equal('parallel_tool_calls' in finalRequest, false);
    const finalFormat = finalRequest.text?.format as
      | {
          type?: string;
          name?: string;
          strict?: boolean;
          schema?: { type?: string };
        }
      | undefined;
    assert.equal(finalFormat?.type, 'json_schema');
    assert.equal(finalFormat?.name, 'investigation_result_v1');
    assert.equal(finalFormat?.strict, true);
    assert.equal(finalFormat?.schema?.type, 'object');

    assert.throws(() =>
      providerModule.buildInitialOpenAIRequest({
        ...dossier,
        unsafeExtraField: RAW_SENTINEL,
      } as InvestigationDossierV1),
    );
    assert.throws(() =>
      providerModule.buildFinalOpenAIRequest(
        'response-opaque',
        'call-opaque',
        {
          ...replay,
          unsafeExtraField: RAW_SENTINEL,
        } as unknown as NormalizedReplayOutputV1,
      ),
    );
    assert.throws(() =>
      providerModule.buildFinalOpenAIRequest(
        'response-opaque',
        'call-opaque',
        {
          ...replay,
          report: {
            ...replay.report,
            unsafeNestedField: RAW_SENTINEL,
          },
        } as unknown as NormalizedReplayOutputV1,
      ),
    );

    const pinnedProvider = new providerModule.OpenAIResponsesProvider(
      'unit-test-key-not-a-secret',
    );
    await assert.rejects(
      pinnedProvider.requestReplay(dossier),
      (error: unknown) => error instanceof InvestigationProviderError,
    );
    assert.equal(fetchCalls, 1);
    assert.equal(
      fetchedUrl,
      `${providerModule.OPENAI_API_BASE_URL}/responses`,
      'OPENAI_BASE_URL must not redirect the live provider away from the official API',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    }
  }
});

test('completed live responses without usage metadata are rejected before normalization', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        id: `response-without-usage-${fetchCalls}`,
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'gpt-5.6',
        output: [],
        usage: null,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const providerModule = await import(
      '../../src/investigation/openai-provider.js'
    );
    const provider = new providerModule.OpenAIResponsesProvider(
      'unit-test-key-not-a-secret',
    );
    const dossier = buildInvestigationDossierV1(activityEvidence());
    const replay = normalizeReplayOutputV1(
      'inspect_startup_order',
      startupReport(),
    );

    await assert.rejects(
      provider.requestReplay(dossier),
      (error: unknown) =>
        error instanceof InvestigationProviderError &&
        error.details.type === 'missing_usage',
      'the first completed response must not synthesize zero token usage',
    );
    await assert.rejects(
      provider.requestConclusion({
        previousResponseId: 'response-opaque',
        callId: 'call-opaque',
        replayOutput: replay,
      }),
      (error: unknown) =>
        error instanceof InvestigationProviderError &&
        error.details.type === 'missing_usage',
      'the final completed response must not synthesize zero token usage',
    );
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dossier and model output schemas are strict', () => {
  const sourceEvidence = activityEvidence();
  const dossier = buildInvestigationDossierV1(sourceEvidence);
  assert.equal(investigationDossierV1Schema.safeParse(dossier).success, true);
  assert.deepEqual(Object.keys(dossier), [
    'version',
    'promiseStatement',
    'contractClauses',
    'violationCodes',
    'uiState',
    'browserStorageState',
    'backendPreferenceState',
    'activity',
    'recommendation',
    'eventOrdering',
    'evidenceReferences',
    'availableReplays',
  ]);
  assert.equal(Object.isFrozen(dossier), true);
  assert.equal(Object.isFrozen(dossier.evidenceReferences), true);
  const originalRequestCount = dossier.activity.requestCount;
  sourceEvidence.request.activityPayloads.length = 0;
  assert.equal(dossier.activity.requestCount, originalRequestCount);
  assert.equal(
    investigationDossierV1Schema.safeParse({ ...dossier, rawEvidence: {} })
      .success,
    false,
  );

  const toolArguments = {
    replayId: 'inspect_startup_order',
    hypotheses: [
      {
        id: 'h1',
        title: 'First causal explanation',
        rank: 1,
        confidence: 70,
        supportingEvidence: ['activity.requests'],
        contradictingEvidence: [],
      },
      {
        id: 'h2',
        title: 'Second causal explanation',
        rank: 2,
        confidence: 30,
        supportingEvidence: ['events.ordering'],
        contradictingEvidence: [],
      },
    ],
    purpose: 'Inspect factual ordering.',
    evidenceReferences: ['activity.requests', 'events.ordering'],
  };
  assert.equal(replayToolArgumentsV1Schema.safeParse(toolArguments).success, true);
  assert.equal(
    replayToolArgumentsV1Schema.safeParse({ ...toolArguments, verdict: 'pass' })
      .success,
    false,
  );
});

test('selection validation rejects malformed or out-of-policy calls', async () => {
  const dossier = buildInvestigationDossierV1(activityEvidence());
  const valid = await validSelection(dossier);
  const acceptedSelection = validateReplaySelection(
    valid.response,
    dossier,
    'offline',
  );
  assert.equal(acceptedSelection.accepted, true);
  if (acceptedSelection.accepted) {
    assertDeepFrozen(acceptedSelection.arguments, 'selection.arguments');
  }

  const zeroCalls = structuredClone(valid.response);
  zeroCalls.outputItems = [];
  zeroCalls.toolCalls = [];
  assert.deepEqual(
    rejectionCodes(validateReplaySelection(zeroCalls, dossier, 'offline')),
    ['PP_INV_TOOL_COUNT_REJECTED'],
  );

  const unexpectedOutput = structuredClone(valid.response);
  unexpectedOutput.outputItems.push({
    type: 'message',
    status: 'completed',
    contentTypes: ['output_text'],
  });
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(unexpectedOutput, dossier, 'offline'),
    ),
    ['PP_INV_UNEXPECTED_OUTPUT'],
  );

  const refusedSelection = structuredClone(valid.response);
  refusedSelection.refusalPresent = true;
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(refusedSelection, dossier, 'offline'),
    ),
    ['PP_INV_SELECTION_CONTENT_REJECTED'],
  );

  const incompleteSelection = structuredClone(valid.response);
  incompleteSelection.incompleteReason = 'max_output_tokens';
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(incompleteSelection, dossier, 'offline'),
    ),
    ['PP_INV_SELECTION_CONTENT_REJECTED'],
  );

  const erroredSelection = structuredClone(valid.response);
  erroredSelection.errorPresent = true;
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(erroredSelection, dossier, 'offline'),
    ),
    ['PP_INV_SELECTION_CONTENT_REJECTED'],
  );

  for (const rejectedStatus of ['incomplete', 'in_progress', null]) {
    const incompleteItem = structuredClone(valid.response);
    incompleteItem.outputItems[0]!.status = rejectedStatus;
    assert.deepEqual(
      rejectionCodes(
        validateReplaySelection(incompleteItem, dossier, 'offline'),
      ),
      ['PP_INV_OUTPUT_ITEM_INCOMPLETE'],
      `selection item status ${String(rejectedStatus)} must be rejected`,
    );
  }

  const incompleteSelectionReasoning = structuredClone(valid.response);
  incompleteSelectionReasoning.outputItems.unshift({
    type: 'reasoning',
    status: 'in_progress',
    contentTypes: [],
  });
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        incompleteSelectionReasoning,
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_OUTPUT_ITEM_INCOMPLETE'],
  );

  const selectionContentMismatch = structuredClone(valid.response);
  selectionContentMismatch.outputItems[0]!.contentTypes = ['output_text'];
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(selectionContentMismatch, dossier, 'offline'),
    ),
    ['PP_INV_OUTPUT_ITEM_INCOMPLETE'],
  );

  const summaryToolMismatch = structuredClone(valid.response);
  summaryToolMismatch.outputItems = [];
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(summaryToolMismatch, dossier, 'offline'),
    ),
    ['PP_INV_UNEXPECTED_OUTPUT'],
  );

  const wrongTool = structuredClone(valid.response);
  wrongTool.toolCalls[0]!.name = 'read_source_file';
  assert.deepEqual(
    rejectionCodes(validateReplaySelection(wrongTool, dossier, 'offline')),
    ['PP_INV_UNKNOWN_TOOL'],
  );

  const missingCallId = structuredClone(valid.response);
  missingCallId.toolCalls[0]!.callId = '';
  assert.deepEqual(
    rejectionCodes(validateReplaySelection(missingCallId, dossier, 'offline')),
    ['PP_INV_TOOL_CALL_ID_REJECTED'],
  );

  const unsafeCallId = structuredClone(valid.response);
  unsafeCallId.toolCalls[0]!.callId = 'call id with spaces';
  assert.deepEqual(
    rejectionCodes(validateReplaySelection(unsafeCallId, dossier, 'offline')),
    ['PP_INV_TOOL_CALL_ID_REJECTED'],
  );

  const invalidMetadata = structuredClone(valid.response);
  invalidMetadata.usage.totalTokens = -1;
  assert.deepEqual(
    rejectionCodes(validateReplaySelection(invalidMetadata, dossier, 'offline')),
    ['PP_INV_RESPONSE_METADATA_REJECTED'],
  );

  const inconsistentTokenTotal = structuredClone(valid.response);
  inconsistentTokenTotal.usage.totalTokens =
    inconsistentTokenTotal.usage.inputTokens +
    inconsistentTokenTotal.usage.outputTokens +
    1;
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(inconsistentTokenTotal, dossier, 'offline'),
    ),
    ['PP_INV_RESPONSE_METADATA_REJECTED'],
  );

  const unsafeResponseId = structuredClone(valid.response);
  unsafeResponseId.responseId = 'response id with spaces';
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(unsafeResponseId, dossier, 'offline'),
    ),
    ['PP_INV_RESPONSE_METADATA_REJECTED'],
  );

  const multipleCalls = structuredClone(valid.response);
  multipleCalls.toolCalls.push(structuredClone(multipleCalls.toolCalls[0]!));
  multipleCalls.outputItems.push(
    structuredClone(multipleCalls.outputItems[0]!),
  );
  assert.deepEqual(
    rejectionCodes(validateReplaySelection(multipleCalls, dossier, 'offline')),
    ['PP_INV_TOOL_COUNT_REJECTED'],
  );

  const invalidJson = structuredClone(valid.response);
  invalidJson.toolCalls[0]!.arguments = '{not-json';
  assert.deepEqual(
    rejectionCodes(validateReplaySelection(invalidJson, dossier, 'offline')),
    ['PP_INV_ARGUMENTS_NOT_JSON'],
  );

  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, {
          ...valid.arguments,
          replayId: 'inspect_unregistered_endpoint',
        }),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, {
          ...valid.arguments,
          unexpectedArgument: true,
        }),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  const badRanks = structuredClone(valid.arguments);
  badRanks.hypotheses[1]!.rank = 3;
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, badRanks),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  const outcomeLikeId = {
    ...valid.arguments,
    hypotheses: valid.arguments.hypotheses.map((hypothesis, index) => ({
      ...hypothesis,
      id: index === 0 ? 'promise_passed' : hypothesis.id,
    })),
  };
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, outcomeLikeId),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  const reorderedOpaqueIds = {
    ...valid.arguments,
    hypotheses: valid.arguments.hypotheses.map((hypothesis, index) => ({
      ...hypothesis,
      id: index === 0 ? 'h2' : 'h1',
    })),
  };
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, reorderedOpaqueIds),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  const dangling = structuredClone(valid.arguments);
  dangling.hypotheses[0]!.supportingEvidence = ['fact.not_in_dossier'];
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, dangling),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_EVIDENCE_REFERENCE_REJECTED'],
  );

  const duplicateSupportingReference = structuredClone(valid.arguments);
  duplicateSupportingReference.hypotheses[0]!.supportingEvidence.push(
    duplicateSupportingReference.hypotheses[0]!.supportingEvidence[0]!,
  );
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, duplicateSupportingReference),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  const duplicateContradictingReference = structuredClone(valid.arguments);
  duplicateContradictingReference.hypotheses[1]!.contradictingEvidence.push(
    duplicateContradictingReference.hypotheses[1]!.contradictingEvidence[0]!,
  );
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, duplicateContradictingReference),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  const overlappingHypothesisReferences = structuredClone(valid.arguments);
  overlappingHypothesisReferences.hypotheses[0]!.contradictingEvidence.push(
    overlappingHypothesisReferences.hypotheses[0]!.supportingEvidence[0]!,
  );
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, overlappingHypothesisReferences),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_ARGUMENTS_SCHEMA_REJECTED'],
  );

  const reservedOutcome = structuredClone(valid.arguments);
  reservedOutcome.purpose = 'The contract passed, so inspect the ordering.';
  assert.deepEqual(
    rejectionCodes(
      validateReplaySelection(
        withArguments(valid.response, reservedOutcome),
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_VERDICT_LANGUAGE_REJECTED'],
  );

  for (const reservedSynonym of [
    'The promise holds, so inspect the ordering.',
    'Verification is successful, so inspect the ordering.',
    'The requirements are met, so inspect the ordering.',
    'The product works correctly, so inspect the ordering.',
    'The issue is fixed, so inspect the ordering.',
  ]) {
    const reservedArguments = structuredClone(valid.arguments);
    reservedArguments.purpose = reservedSynonym;
    assert.deepEqual(
      rejectionCodes(
        validateReplaySelection(
          withArguments(valid.response, reservedArguments),
          dossier,
          'offline',
        ),
      ),
      ['PP_INV_VERDICT_LANGUAGE_REJECTED'],
    );
  }
});

test('live validation accepts only the exact GPT-5.6 aliases', async () => {
  const dossier = buildInvestigationDossierV1(activityEvidence());
  const selection = await validSelection(dossier);

  for (const acceptedModel of ['gpt-5.6', 'gpt-5.6-sol']) {
    const response = structuredClone(selection.response);
    response.model = acceptedModel;
    assert.equal(
      validateReplaySelection(response, dossier, 'openai').accepted,
      true,
      `expected ${acceptedModel} to satisfy the live model policy`,
    );
  }

  for (const rejectedModel of [
    'gpt-5.5',
    'gpt-5.60',
    'gpt-5.6-',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.6-evil',
    'gpt-5.6-not-a-snapshot',
    'gpt-5.6-2026-07-15',
    'offline-evidence-provider-v1',
  ]) {
    const response = structuredClone(selection.response);
    response.model = rejectedModel;
    assert.deepEqual(
      rejectionCodes(validateReplaySelection(response, dossier, 'openai')),
      ['PP_INV_MODEL_IDENTITY_REJECTED'],
      `expected ${rejectedModel} to fail the live model policy`,
    );
  }

  const conclusion = await validConclusion(dossier);
  for (const acceptedModel of ['gpt-5.6', 'gpt-5.6-sol']) {
    const response = structuredClone(conclusion.response);
    response.model = acceptedModel;
    assert.equal(
      validateConclusion(
        response,
        conclusion.initial,
        conclusion.replay,
        dossier,
        'openai',
      ).accepted,
      true,
      `expected ${acceptedModel} to satisfy the final live model policy`,
    );
  }

  for (const rejectedModel of [
    'gpt-4.1',
    'gpt-5.6-',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.6-arbitrary-suffix',
    'gpt-5.6-2026-07-15',
  ]) {
    const wrongFinalModel = structuredClone(conclusion.response);
    wrongFinalModel.model = rejectedModel;
    assert.deepEqual(
      conclusionRejectionCodes(
        validateConclusion(
          wrongFinalModel,
          conclusion.initial,
          conclusion.replay,
          dossier,
          'openai',
        ),
      ),
      ['PP_INV_FINAL_MODEL_IDENTITY_REJECTED'],
      `expected ${rejectedModel} to fail the final live model policy`,
    );
  }

  assert.equal(
    validateConclusion(
      conclusion.response,
      conclusion.initial,
      conclusion.replay,
      dossier,
      'offline',
    ).accepted,
    true,
    'offline validation must retain its explicit non-live provider policy',
  );
});

test('invalid model output executes no replay and valid output executes only the selected replay', async () => {
  const dossier = buildInvestigationDossierV1(activityEvidence());
  const selection = await validSelection(dossier);
  const invalidResponse = structuredClone(selection.response);
  invalidResponse.toolCalls[0]!.name = 'constructor';

  class StaticProvider implements InvestigationProvider {
    readonly kind = 'offline' as const;
    conclusionCalls = 0;

    constructor(private readonly replayResponse: ReplaySelectionProviderResponse) {}

    async requestReplay(): Promise<ReplaySelectionProviderResponse> {
      return structuredClone(this.replayResponse);
    }

    async requestConclusion(): Promise<ConclusionProviderResponse> {
      this.conclusionCalls += 1;
      throw new Error('Conclusion must not run after invalid selection.');
    }
  }

  let startupExecutions = 0;
  let preferenceExecutions = 0;
  const executors: ReplayExecutors = {
    inspect_startup_order: async () => {
      startupExecutions += 1;
      return startupReport();
    },
    inspect_preference_roundtrip: async () => {
      preferenceExecutions += 1;
      return {
        requested: 'off',
        acknowledged: 'off',
        authoritativeReadback: 'on',
        receiptRecorded: true,
        identityCorrelated: true,
        roundtripConsistent: false,
      };
    },
  };
  const invalidProvider = new StaticProvider(invalidResponse);
  const rejected = await runInvestigation({
    evidence: activityEvidence(),
    provider: invalidProvider,
    replayExecutors: executors,
    investigationId: 'opaque-invalid',
  });
  assert.equal(rejected.status, 'model_output_rejected');
  assert.equal(startupExecutions, 0);
  assert.equal(preferenceExecutions, 0);
  assert.equal(invalidProvider.conclusionCalls, 0);

  const completed = await runInvestigation({
    evidence: activityEvidence(),
    provider: new DeterministicInvestigationProvider(),
    replayExecutors: executors,
    investigationId: 'opaque-valid',
  });
  assert.equal(completed.status, 'investigation_completed');
  assert.equal(startupExecutions, 1);
  assert.equal(preferenceExecutions, 0);
  assert.equal(completed.bounds.providerCallsUsed, 2);
  assert.equal(completed.bounds.replayExecutionsUsed, 1);
  assert.deepEqual(
    completed.provider.responses.map((response) => ({
      phase: response.phase,
      outputItems: response.outputItems,
      errorPresent: response.errorPresent,
    })),
    [
      {
        phase: 'replay_selection',
        outputItems: [
          {
            type: 'function_call',
            status: 'completed',
            contentTypes: [],
          },
        ],
        errorPresent: false,
      },
      {
        phase: 'hypothesis_update',
        outputItems: [
          {
            type: 'message',
            status: 'completed',
            contentTypes: ['output_text'],
          },
        ],
        errorPresent: false,
      },
    ],
  );
});

test('provider failures record only sanitized details in the investigation artifact', async () => {
  const secretSentinel =
    'Authorization: Bearer provider-secret | raw response body | private header';
  const providerError = new InvestigationProviderError({
    status: 429,
    code: 'rate_limit_exceeded',
    type: 'api_error',
    requestId: 'req_safe_123',
    body: secretSentinel,
    extraUnsafeField: secretSentinel,
  } as unknown);
  assert.deepEqual(providerError.details, {
    status: 429,
    code: 'rate_limit_exceeded',
    type: 'api_error',
    requestId: 'req_safe_123',
  });
  assert.equal(Object.isFrozen(providerError.details), true);
  assert.deepEqual(Object.keys(providerError.details), [
    'status',
    'code',
    'type',
    'requestId',
  ]);

  // Simulate a hostile or buggy provider subclass replacing the sanitized
  // details after construction. The runner must project the object again.
  (providerError as unknown as { details: unknown }).details = {
    status: 700,
    code: `unsafe code ${secretSentinel}`,
    type: 'api_error',
    requestId: `req/unsafe/${secretSentinel}`,
    body: secretSentinel,
    extraUnsafeField: secretSentinel,
  };
  providerError.message = `Unsafe provider message: ${secretSentinel}`;
  Object.assign(providerError, {
    body: { raw: secretSentinel },
    headers: { authorization: secretSentinel },
    response: { payload: secretSentinel },
  });

  class FailingProvider implements InvestigationProvider {
    readonly kind = 'openai' as const;

    async requestReplay(): Promise<ReplaySelectionProviderResponse> {
      throw providerError;
    }

    async requestConclusion(): Promise<ConclusionProviderResponse> {
      throw new Error('Conclusion must not run after provider failure.');
    }
  }

  let replayExecutions = 0;
  const artifact = await runInvestigation({
    evidence: activityEvidence(),
    provider: new FailingProvider(),
    replayExecutors: {
      inspect_startup_order: async () => {
        replayExecutions += 1;
        return startupReport();
      },
      inspect_preference_roundtrip: async () => {
        replayExecutions += 1;
        return {
          requested: 'off',
          acknowledged: 'off',
          authoritativeReadback: 'on',
          receiptRecorded: true,
          identityCorrelated: true,
          roundtripConsistent: false,
        };
      },
    },
    investigationId: 'opaque-provider-failure',
    now: () => 0,
  });

  assert.equal(artifact.status, 'provider_failed');
  assert.deepEqual(artifact.failure, {
    code: 'PP_INV_SELECTION_PROVIDER_FAILED',
    providerDetails: {
      status: null,
      code: null,
      type: 'api_error',
      requestId: null,
    },
  });
  assert.deepEqual(Object.keys(artifact.failure!.providerDetails!), [
    'status',
    'code',
    'type',
    'requestId',
  ]);
  assert.equal(artifact.provider.responses.length, 0);
  assert.equal(artifact.bounds.providerCallsUsed, 1);
  assert.equal(artifact.bounds.replayExecutionsUsed, 0);
  assert.equal(replayExecutions, 0);
  assertDeepFrozen(artifact, 'providerFailureArtifact');

  const serializedArtifact = JSON.stringify(artifact);
  assert.equal(serializedArtifact.includes(secretSentinel), false);
  assert.doesNotMatch(serializedArtifact, /(?:message|body|headers|authorization)/i);
});

test('dispatcher rejects a second replay and malformed factual reports', async () => {
  let startupExecutions = 0;
  let preferenceExecutions = 0;
  const dispatcher = new ReplayDispatcher({
    inspect_startup_order: async () => {
      startupExecutions += 1;
      return startupReport();
    },
    inspect_preference_roundtrip: async () => {
      preferenceExecutions += 1;
      return {
        requested: 'off',
        acknowledged: 'off',
        authoritativeReadback: 'on',
        receiptRecorded: true,
        identityCorrelated: true,
        roundtripConsistent: false,
      };
    },
  });
  await dispatcher.execute('inspect_startup_order');
  await assert.rejects(
    dispatcher.execute('inspect_preference_roundtrip'),
    (error: unknown) =>
      error instanceof ReplayDispatchError &&
      error.code === 'PP_INV_REPLAY_LIMIT',
  );
  assert.equal(startupExecutions, 1);
  assert.equal(preferenceExecutions, 0);

  let malformedStartupExecutions = 0;
  let malformedPreferenceExecutions = 0;
  const malformed = new ReplayDispatcher({
    inspect_startup_order: async () => {
      malformedStartupExecutions += 1;
      return { rawJourney: RAW_SENTINEL };
    },
    inspect_preference_roundtrip: async () => {
      malformedPreferenceExecutions += 1;
      return { rawLedger: RAW_SENTINEL };
    },
  });
  await assert.rejects(
    malformed.execute('inspect_startup_order'),
    (error: unknown) =>
      error instanceof ReplayDispatchError &&
      error.code === 'PP_INV_REPLAY_REPORT_INVALID',
  );
  assert.equal(malformed.executions, 1);
  assert.equal(malformedStartupExecutions, 1);
  assert.equal(malformedPreferenceExecutions, 0);

  const inconsistent = new ReplayDispatcher({
    inspect_startup_order: async () => ({
      ...startupReport(),
      collectorBeforeHydration: false,
    }),
    inspect_preference_roundtrip: async () => ({
      requested: 'off',
      acknowledged: 'off',
      authoritativeReadback: 'off',
      receiptRecorded: true,
      identityCorrelated: true,
      roundtripConsistent: false,
    }),
  });
  await assert.rejects(
    inconsistent.execute('inspect_startup_order'),
    (error: unknown) =>
      error instanceof ReplayDispatchError &&
      error.code === 'PP_INV_REPLAY_REPORT_INVALID',
  );

  assert.doesNotThrow(() =>
    normalizeReplayOutputV1('inspect_startup_order', {
      ...startupReport(),
      events: [
        'collector_started',
        'collector_started',
        'activity_dispatched',
        'preference_hydration_started',
        'preference_hydration_started',
        'preference_hydration_completed',
        'recommendation_rendered',
      ],
      collectorIndex: 0,
      hydrationIndex: 3,
      collectorBeforeHydration: true,
      networkEvents: [
        'activity_post',
        'activity_post',
        'preference_read',
        'preference_read',
      ],
      activityBeforePreferenceRead: true,
    }),
  );

  const malformedStartupReports: StartupOrderReplayReportV1[] = [
    {
      ...startupReport(),
      collectorIndex: -1,
      collectorBeforeHydration: false,
    },
    {
      ...startupReport(),
      events: [
        'collector_started',
        'collector_started',
        'activity_dispatched',
        'preference_hydration_started',
        'preference_hydration_completed',
        'recommendation_rendered',
      ],
      collectorIndex: 1,
      hydrationIndex: 3,
      collectorBeforeHydration: true,
    },
    {
      ...startupReport(),
      hydrationIndex: -1,
      collectorBeforeHydration: false,
    },
    {
      ...startupReport(),
      events: [
        'collector_started',
        'activity_dispatched',
        'preference_hydration_started',
        'preference_hydration_started',
        'preference_hydration_completed',
        'recommendation_rendered',
      ],
      hydrationIndex: 3,
      collectorBeforeHydration: true,
    },
    {
      ...startupReport(),
      activityBeforePreferenceRead: false,
    },
    {
      ...startupReport(),
      networkEvents: ['activity_post'],
      activityBeforePreferenceRead: true,
    },
    {
      ...startupReport(),
      networkEvents: [
        'preference_read',
        'activity_post',
        'preference_read',
      ],
      activityBeforePreferenceRead: true,
    },
  ];
  for (const malformedReport of malformedStartupReports) {
    assert.throws(
      () =>
        normalizeReplayOutputV1(
          'inspect_startup_order',
          malformedReport,
        ),
      (error: unknown) => error instanceof Error,
      'startup replay indices and derived flags must match first occurrence',
    );
  }
});

test('final validation rejects replay mismatch, dangling references, and ungrounded updates', async () => {
  const dossier = buildInvestigationDossierV1(activityEvidence());
  const valid = await validConclusion(dossier);
  const acceptedConclusion = validateConclusion(
    valid.response,
    valid.initial,
    valid.replay,
    dossier,
    'offline',
  );
  assert.equal(acceptedConclusion.accepted, true);
  if (acceptedConclusion.accepted) {
    assertDeepFrozen(acceptedConclusion.result, 'conclusion.result');
  }

  const acceptedWithReasoning = structuredClone(valid.response);
  acceptedWithReasoning.outputItems = [
    { type: 'reasoning', status: null, contentTypes: [] },
    ...acceptedWithReasoning.outputItems,
  ];
  assert.equal(
    validateConclusion(
      acceptedWithReasoning,
      valid.initial,
      valid.replay,
      dossier,
      'offline',
    ).accepted,
    true,
    'one final message plus reasoning metadata must remain bounded',
  );

  for (const rejectedOutputKinds of [
    [],
    ['reasoning'],
    ['function_call'],
    ['message', 'function_call'],
    ['message', 'computer_call'],
    ['message', 'message'],
  ]) {
    const response = structuredClone(valid.response);
    response.outputItems = rejectedOutputKinds.map((type) => ({
      type,
      status: type === 'message' ? 'completed' : null,
      contentTypes: type === 'message' ? ['output_text'] : [],
    }));
    assert.equal(
      validateConclusion(
        response,
        valid.initial,
        valid.replay,
        dossier,
        'offline',
      ).accepted,
      false,
      `final output kinds must reject ${JSON.stringify(rejectedOutputKinds)}`,
    );
  }

  const refusedConclusion = structuredClone(valid.response);
  refusedConclusion.refusalPresent = true;
  assert.deepEqual(
    conclusionRejectionCodes(
      validateConclusion(
        refusedConclusion,
        valid.initial,
        valid.replay,
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_FINAL_UNEXPECTED_OUTPUT'],
  );

  const incompleteConclusion = structuredClone(valid.response);
  incompleteConclusion.incompleteReason = 'max_output_tokens';
  assert.deepEqual(
    conclusionRejectionCodes(
      validateConclusion(
        incompleteConclusion,
        valid.initial,
        valid.replay,
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_FINAL_UNEXPECTED_OUTPUT'],
  );

  const erroredConclusion = structuredClone(valid.response);
  erroredConclusion.errorPresent = true;
  assert.deepEqual(
    conclusionRejectionCodes(
      validateConclusion(
        erroredConclusion,
        valid.initial,
        valid.replay,
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_FINAL_UNEXPECTED_OUTPUT'],
  );

  for (const rejectedStatus of ['incomplete', 'in_progress', null]) {
    const incompleteItem = structuredClone(valid.response);
    incompleteItem.outputItems[0]!.status = rejectedStatus;
    assert.deepEqual(
      conclusionRejectionCodes(
        validateConclusion(
          incompleteItem,
          valid.initial,
          valid.replay,
          dossier,
          'offline',
        ),
      ),
      ['PP_INV_FINAL_OUTPUT_ITEM_INCOMPLETE'],
      `final message item status ${String(rejectedStatus)} must be rejected`,
    );
  }

  const incompleteConclusionReasoning = structuredClone(valid.response);
  incompleteConclusionReasoning.outputItems.unshift({
    type: 'reasoning',
    status: 'incomplete',
    contentTypes: [],
  });
  assert.deepEqual(
    conclusionRejectionCodes(
      validateConclusion(
        incompleteConclusionReasoning,
        valid.initial,
        valid.replay,
        dossier,
        'offline',
      ),
    ),
    ['PP_INV_FINAL_OUTPUT_ITEM_INCOMPLETE'],
  );

  for (const rejectedContentTypes of [
    [],
    ['refusal'],
    ['output_text', 'output_text'],
    ['output_text', 'refusal'],
  ]) {
    const contentMismatch = structuredClone(valid.response);
    contentMismatch.outputItems[0]!.contentTypes = rejectedContentTypes;
    assert.deepEqual(
      conclusionRejectionCodes(
        validateConclusion(
          contentMismatch,
          valid.initial,
          valid.replay,
          dossier,
          'offline',
        ),
      ),
      ['PP_INV_FINAL_MESSAGE_CONTENT_REJECTED'],
      `final message content ${JSON.stringify(rejectedContentTypes)} must be rejected`,
    );
  }

  const responseFor = (result: unknown): ConclusionProviderResponse => ({
    ...valid.response,
    outputText: JSON.stringify(result),
  });
  const rejectCode = (result: unknown): string => {
    const validation = validateConclusion(
      responseFor(result),
      valid.initial,
      valid.replay,
      dossier,
      'offline',
    );
    assert.equal(validation.accepted, false);
    return validation.decisions.find((item) => !item.accepted)!.code;
  };

  assert.equal(
    rejectCode({
      ...valid.result,
      replayPerformed: 'inspect_preference_roundtrip',
    }),
    'PP_INV_REPLAY_IDENTITY_REJECTED',
  );
  assert.equal(
    rejectCode({
      ...valid.result,
      conclusionEvidenceReferences: ['fact.not_allowlisted'],
    }),
    'PP_INV_FINAL_EVIDENCE_REFERENCE_REJECTED',
  );
  assert.equal(
    rejectCode({
      ...valid.result,
      hypotheses: valid.result.hypotheses.map((hypothesis) => ({
        ...hypothesis,
        status: 'unresolved' as const,
      })),
    }),
    'PP_INV_MATERIAL_UPDATE_REJECTED',
  );

  const unsupportedWithoutReplayGrounding = structuredClone(valid.result);
  unsupportedWithoutReplayGrounding.hypotheses =
    unsupportedWithoutReplayGrounding.hypotheses.map((hypothesis) => ({
      ...hypothesis,
      status: 'unresolved' as const,
      supportingEvidenceReferences:
        valid.initial.hypotheses.find(
          (initial) => initial.id === hypothesis.hypothesisId,
        )?.supportingEvidence ?? [],
      contradictingEvidenceReferences:
        valid.initial.hypotheses.find(
          (initial) => initial.id === hypothesis.hypothesisId,
        )?.contradictingEvidence ?? [],
    }));
  unsupportedWithoutReplayGrounding.hypotheses[0]!.status = 'supported';
  assert.equal(
    rejectCode(unsupportedWithoutReplayGrounding),
    'PP_INV_MATERIAL_UPDATE_REJECTED',
  );

  const weakenedWithoutContradictingReplay = structuredClone(valid.result);
  weakenedWithoutContradictingReplay.hypotheses =
    weakenedWithoutContradictingReplay.hypotheses.map((hypothesis) => ({
      ...hypothesis,
      status: 'unresolved' as const,
      supportingEvidenceReferences:
        valid.initial.hypotheses.find(
          (initial) => initial.id === hypothesis.hypothesisId,
        )?.supportingEvidence ?? [],
      contradictingEvidenceReferences:
        valid.initial.hypotheses.find(
          (initial) => initial.id === hypothesis.hypothesisId,
        )?.contradictingEvidence ?? [],
    }));
  weakenedWithoutContradictingReplay.hypotheses[0]!.status = 'weakened';
  assert.equal(
    rejectCode(weakenedWithoutContradictingReplay),
    'PP_INV_MATERIAL_UPDATE_REJECTED',
  );

  assert.equal(
    rejectCode({
      ...valid.result,
      mostLikelyHypothesisId: 'h3',
      hypotheses: valid.result.hypotheses.map((hypothesis, index) => ({
        ...hypothesis,
        hypothesisId: index === 0 ? 'h3' : hypothesis.hypothesisId,
      })),
    }),
    'PP_INV_HYPOTHESIS_CONTINUITY_REJECTED',
  );

  assert.equal(
    rejectCode({
      ...valid.result,
      mostLikelyHypothesisId: 'h3',
    }),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );

  assert.deepEqual(valid.result.limitationCodes, [
    'single_replay_scope',
    'synthetic_evidence_scope',
    'diagnostic_not_verdict',
  ]);
  assert.equal(
    rejectCode({
      ...valid.result,
      caveats: ['All canonical obligations have been fulfilled.'],
    }),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );
  assert.equal(
    rejectCode({
      ...valid.result,
      caveats: ['This does not establish compliance.'],
    }),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );
  assert.equal(
    rejectCode({
      ...valid.result,
      limitationCodes: [
        'diagnostic_not_verdict',
        'synthetic_evidence_scope',
        'single_replay_scope',
      ],
    }),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );
  assert.equal(
    rejectCode({
      ...valid.result,
      limitationCodes: [
        'single_replay_scope',
        'synthetic_evidence_scope',
        'unregistered_limitation',
      ],
    }),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );

  const duplicateFinalSupportingReference = structuredClone(valid.result);
  duplicateFinalSupportingReference.hypotheses[0]!.supportingEvidenceReferences.push(
    duplicateFinalSupportingReference.hypotheses[0]!
      .supportingEvidenceReferences[0]!,
  );
  assert.equal(
    rejectCode(duplicateFinalSupportingReference),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );

  const duplicateFinalContradictingReference = structuredClone(valid.result);
  duplicateFinalContradictingReference.hypotheses[1]!.contradictingEvidenceReferences.push(
    duplicateFinalContradictingReference.hypotheses[1]!
      .contradictingEvidenceReferences[0]!,
  );
  assert.equal(
    rejectCode(duplicateFinalContradictingReference),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );

  const overlappingFinalReferences = structuredClone(valid.result);
  overlappingFinalReferences.hypotheses[0]!.contradictingEvidenceReferences.push(
    overlappingFinalReferences.hypotheses[0]!
      .supportingEvidenceReferences[0]!,
  );
  assert.equal(
    rejectCode(overlappingFinalReferences),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );

  const nonLeadingHypothesisId = valid.result.hypotheses[1]?.hypothesisId;
  assert.notEqual(nonLeadingHypothesisId, undefined);
  assert.equal(
    rejectCode({
      ...valid.result,
      mostLikelyHypothesisId: nonLeadingHypothesisId!,
    }),
    'PP_INV_LEADING_HYPOTHESIS_REJECTED',
  );

  assert.equal(
    rejectCode({
      ...valid.result,
      hypotheses: valid.result.hypotheses.map((hypothesis, index) =>
        index === 0
          ? { ...hypothesis, title: 'A rewritten causal explanation' }
          : hypothesis,
      ),
    }),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );
  assert.equal(
    rejectCode({
      ...valid.result,
      mostLikelyCause:
        'The promise holds and verification is successful after the replay.',
    }),
    'PP_INV_RESULT_SCHEMA_REJECTED',
  );
  assert.equal(
    investigationResultV1Schema.safeParse({
      ...valid.result,
      verdict: 'pass',
    }).success,
    false,
  );
});

test('offline provider selects from normalized facts for both evidence signatures', async () => {
  const activityDossier = buildInvestigationDossierV1(activityEvidence());
  const stateDossier = buildInvestigationDossierV1(preferenceEvidence());
  const activitySelection = await validSelection(activityDossier);
  const stateSelection = await validSelection(stateDossier);

  assert.equal(activitySelection.arguments.replayId, 'inspect_startup_order');
  assert.equal(
    stateSelection.arguments.replayId,
    'inspect_preference_roundtrip',
  );
  const stateReplay = normalizeReplayOutputV1(
    'inspect_preference_roundtrip',
    {
      requested: 'off',
      acknowledged: 'off',
      authoritativeReadback: 'on',
      receiptRecorded: true,
      identityCorrelated: true,
      roundtripConsistent: false,
    },
  );
  const stateConclusion = await stateSelection.provider.requestConclusion({
    previousResponseId: stateSelection.response.responseId,
    callId: stateSelection.response.toolCalls[0]!.callId,
    replayOutput: stateReplay,
  });
  const stateValidation = validateConclusion(
    stateConclusion,
    stateSelection.arguments,
    stateReplay,
    stateDossier,
    'offline',
  );
  assert.equal(stateValidation.accepted, true);
  if (stateValidation.accepted) {
    assert.equal(stateValidation.result.hypotheses[0]?.status, 'supported');
    assert.equal(
      stateValidation.result.replayPerformed,
      'inspect_preference_roundtrip',
    );
  }
  const exactInputs = JSON.stringify({
    activity: activitySelection.provider.replayRequests,
    state: {
      initial: stateSelection.provider.replayRequests,
      final: stateSelection.provider.conclusionRequests,
    },
  });
  assert.doesNotMatch(exactInputs, /\b(?:fixture|race|propagation)\b/i);
  for (const sentinel of FORBIDDEN_SENTINELS) {
    assert.equal(exactInputs.includes(sentinel), false);
  }
});
