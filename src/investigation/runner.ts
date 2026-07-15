import { randomUUID } from 'node:crypto';

import {
  aggregateUsage,
  type InvestigationArtifactV1,
  type InvestigationStatus,
  type RecordedModelResponse,
} from './artifact.js';
import { sha256CanonicalJson } from './canonical-json.js';
import { buildInvestigationDossier } from './dossier.js';
import { deepFreeze } from './immutable.js';
import {
  ReplayDispatcher,
  type ReplayExecutors,
} from './dispatcher.js';
import { MODEL_ID, PROMPT_VERSION } from './prompt.js';
import {
  InvestigationProviderError,
  sanitizeProviderFailureDetails,
} from './provider.js';
import type { InvestigationProvider } from './provider.js';
import {
  validateConclusion,
  validateReplaySelection,
  type ValidationDecision,
} from './validation.js';

export interface RunInvestigationOptions {
  evidence: unknown;
  provider: InvestigationProvider;
  replayExecutors: ReplayExecutors;
  investigationId?: string;
  now?: () => number;
}

interface MutableRunState {
  providerCalls: number;
  responses: RecordedModelResponse[];
  decisions: ValidationDecision[];
  toolCallId: string | null;
  initialOutput: InvestigationArtifactV1['initialOutput'];
  replay: InvestigationArtifactV1['replay'];
  finalOutput: InvestigationArtifactV1['finalOutput'];
  replayMs: number;
}

function recordResponse(
  phase: RecordedModelResponse['phase'],
  response: Omit<RecordedModelResponse, 'phase'>,
): RecordedModelResponse {
  return { phase, ...response };
}

export async function runInvestigation(
  options: RunInvestigationOptions,
): Promise<InvestigationArtifactV1> {
  const now = options.now ?? Date.now;
  const startedMs = now();
  const dossier = buildInvestigationDossier(options.evidence);
  const dispatcher = new ReplayDispatcher(options.replayExecutors);
  const state: MutableRunState = {
    providerCalls: 0,
    responses: [],
    decisions: [],
    toolCallId: null,
    initialOutput: null,
    replay: null,
    finalOutput: null,
    replayMs: 0,
  };

  const finish = (
    status: InvestigationStatus,
    failureCode: string | null,
    providerDetails: InvestigationProviderError['details'] | null = null,
  ): InvestigationArtifactV1 => {
    const completedMs = now();
    return deepFreeze({
      schemaVersion: 'promiseproof.investigation-artifact.v1',
      investigationId: options.investigationId ?? randomUUID(),
      promptVersion: PROMPT_VERSION,
      status,
      dossier,
      dossierSha256: sha256CanonicalJson(dossier),
      provider: {
        kind: options.provider.kind,
        requestedModel: MODEL_ID,
        responses: state.responses,
        aggregateUsage: aggregateUsage(state.responses),
      },
      bounds: {
        maxProviderCalls: 2,
        providerCallsUsed: state.providerCalls,
        maxReplayExecutions: 1,
        replayExecutionsUsed: dispatcher.executions,
      },
      toolValidation: {
        accepted:
          status === 'investigation_completed' &&
          state.decisions.every((item) => item.accepted),
        decisions: state.decisions,
      },
      toolCallId: state.toolCallId,
      initialOutput: state.initialOutput,
      replay: state.replay,
      finalOutput: state.finalOutput,
      failure:
        failureCode === null
          ? null
          : { code: failureCode, providerDetails },
      timing: {
        startedAt: new Date(startedMs).toISOString(),
        completedAt: new Date(completedMs).toISOString(),
        replayMs: state.replayMs,
        totalMs: Math.max(0, completedMs - startedMs),
      },
    });
  };

  let selectionResponse;
  state.providerCalls += 1;
  try {
    selectionResponse = await options.provider.requestReplay(dossier);
  } catch (error) {
    return finish(
      'provider_failed',
      'PP_INV_SELECTION_PROVIDER_FAILED',
      error instanceof InvestigationProviderError
        ? sanitizeProviderFailureDetails(error.details)
        : null,
    );
  }
  state.responses.push(
    recordResponse('replay_selection', {
      responseId: selectionResponse.responseId,
      model: selectionResponse.model,
      status: selectionResponse.status,
      latencyMs: selectionResponse.latencyMs,
      usage: { ...selectionResponse.usage },
      outputItems: selectionResponse.outputItems.map((item) => ({
        ...item,
        contentTypes: [...item.contentTypes],
      })),
      refusalPresent: selectionResponse.refusalPresent,
      incompleteReason: selectionResponse.incompleteReason,
      errorPresent: selectionResponse.errorPresent,
    }),
  );

  const selection = validateReplaySelection(
    selectionResponse,
    dossier,
    options.provider.kind,
  );
  state.decisions.push(...selection.decisions);
  if (!selection.accepted) {
    return finish('model_output_rejected', 'PP_INV_SELECTION_REJECTED');
  }

  state.toolCallId = selection.callId;
  state.initialOutput = selection.arguments;

  const replayStartedMs = now();
  try {
    state.replay = await dispatcher.execute(selection.arguments.replayId);
  } catch {
    state.replayMs = Math.max(0, now() - replayStartedMs);
    return finish('replay_failed', 'PP_INV_REPLAY_EXECUTION_FAILED');
  }
  state.replayMs = Math.max(0, now() - replayStartedMs);

  let conclusionResponse;
  state.providerCalls += 1;
  try {
    conclusionResponse = await options.provider.requestConclusion({
      previousResponseId: selectionResponse.responseId,
      callId: selection.callId,
      replayOutput: state.replay,
    });
  } catch (error) {
    return finish(
      'provider_failed',
      'PP_INV_CONCLUSION_PROVIDER_FAILED',
      error instanceof InvestigationProviderError
        ? sanitizeProviderFailureDetails(error.details)
        : null,
    );
  }
  state.responses.push(
    recordResponse('hypothesis_update', {
      responseId: conclusionResponse.responseId,
      model: conclusionResponse.model,
      status: conclusionResponse.status,
      latencyMs: conclusionResponse.latencyMs,
      usage: { ...conclusionResponse.usage },
      outputItems: conclusionResponse.outputItems.map((item) => ({
        ...item,
        contentTypes: [...item.contentTypes],
      })),
      refusalPresent: conclusionResponse.refusalPresent,
      incompleteReason: conclusionResponse.incompleteReason,
      errorPresent: conclusionResponse.errorPresent,
    }),
  );

  const conclusion = validateConclusion(
    conclusionResponse,
    selection.arguments,
    state.replay,
    dossier,
    options.provider.kind,
  );
  state.decisions.push(...conclusion.decisions);
  if (!conclusion.accepted) {
    return finish('model_output_rejected', 'PP_INV_CONCLUSION_REJECTED');
  }

  state.finalOutput = conclusion.result;
  return finish('investigation_completed', null);
}
