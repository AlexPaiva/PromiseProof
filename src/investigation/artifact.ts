import type {
  InvestigationDossierV1,
  InvestigationResultV1,
  NormalizedReplayOutputV1,
  ReplayToolArgumentsV1,
} from './contracts.js';
import type {
  ModelTokenUsage,
  ProviderOutputItemSummary,
  ProviderResponseMetadata,
  SafeProviderFailureDetails,
} from './provider.js';
import type { ValidationDecision } from './validation.js';

export type InvestigationStatus =
  | 'investigation_completed'
  | 'model_output_rejected'
  | 'provider_failed'
  | 'replay_failed';

export interface RecordedModelResponse extends ProviderResponseMetadata {
  phase: 'replay_selection' | 'hypothesis_update';
  outputItems: ProviderOutputItemSummary[];
  refusalPresent: boolean;
  incompleteReason: string | null;
  errorPresent: boolean;
}

export interface InvestigationArtifactV1 {
  schemaVersion: 'promiseproof.investigation-artifact.v1';
  investigationId: string;
  promptVersion: string;
  status: InvestigationStatus;
  dossier: InvestigationDossierV1;
  dossierSha256: string;
  provider: {
    kind: 'offline' | 'openai';
    requestedModel: string;
    responses: RecordedModelResponse[];
    aggregateUsage: ModelTokenUsage;
  };
  bounds: {
    maxProviderCalls: 2;
    providerCallsUsed: number;
    maxReplayExecutions: 1;
    replayExecutionsUsed: number;
  };
  toolValidation: {
    accepted: boolean;
    decisions: ValidationDecision[];
  };
  toolCallId: string | null;
  initialOutput: ReplayToolArgumentsV1 | null;
  replay: NormalizedReplayOutputV1 | null;
  finalOutput: InvestigationResultV1 | null;
  failure: {
    code: string;
    providerDetails: SafeProviderFailureDetails | null;
  } | null;
  timing: {
    startedAt: string;
    completedAt: string;
    replayMs: number;
    totalMs: number;
  };
}

export function aggregateUsage(
  responses: readonly RecordedModelResponse[],
): ModelTokenUsage {
  return responses.reduce<ModelTokenUsage>(
    (total, response) => ({
      inputTokens: total.inputTokens + response.usage.inputTokens,
      cachedInputTokens:
        total.cachedInputTokens + response.usage.cachedInputTokens,
      outputTokens: total.outputTokens + response.usage.outputTokens,
      reasoningTokens:
        total.reasoningTokens + response.usage.reasoningTokens,
      totalTokens: total.totalTokens + response.usage.totalTokens,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  );
}
