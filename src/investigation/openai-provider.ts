import { performance } from 'node:perf_hooks';

import OpenAI from 'openai';
import { zodResponsesFunction, zodTextFormat } from 'openai/helpers/zod';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseUsage,
} from 'openai/resources/responses/responses';

import { canonicalJson } from './canonical-json.js';
import type {
  InvestigationDossierV1,
  NormalizedReplayOutputV1,
} from './contracts.js';
import {
  FINAL_INSTRUCTIONS,
  INITIAL_INSTRUCTIONS,
  MODEL_ID,
  TOOL_NAME,
} from './prompt.js';
import { InvestigationProviderError } from './provider.js';
import type {
  ConclusionProviderResponse,
  InvestigationConclusionRequest,
  InvestigationProvider,
  ModelTokenUsage,
  ProviderOutputItemSummary,
  ReplaySelectionProviderResponse,
} from './provider.js';
import {
  investigationDossierV1Schema,
  investigationResultV1Schema,
  normalizedReplayOutputV1Schema,
  replayToolArgumentsV1Schema,
} from './schemas.js';

const MAX_OUTPUT_TOKENS = 3_000;
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1' as const;

function safeProviderError(error: unknown): InvestigationProviderError {
  if (error instanceof InvestigationProviderError) {
    return error;
  }
  if (error instanceof OpenAI.APIError) {
    return new InvestigationProviderError({
      status:
        typeof error.status === 'number' && Number.isInteger(error.status)
          ? error.status
          : null,
      code: error.code,
      type: error.type,
      requestId: error.requestID,
    });
  }
  return new InvestigationProviderError({
    status: null,
    code: null,
    type: 'sdk_or_transport_error',
    requestId: null,
  });
}

export function buildInitialOpenAIRequest(
  dossier: InvestigationDossierV1,
): ResponseCreateParamsNonStreaming {
  const validatedDossier = investigationDossierV1Schema.parse(dossier);
  return {
    model: MODEL_ID,
    instructions: INITIAL_INSTRUCTIONS,
    input: canonicalJson(validatedDossier),
    tools: [
      zodResponsesFunction({
        name: TOOL_NAME,
        description:
          'Request one allowlisted factual replay after ranking evidence-backed technical hypotheses.',
        parameters: replayToolArgumentsV1Schema,
      }),
    ],
    tool_choice: { type: 'function', name: TOOL_NAME },
    parallel_tool_calls: false,
    reasoning: { effort: 'low' },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: true,
  };
}

export function buildFinalOpenAIRequest(
  previousResponseId: string,
  callId: string,
  replayOutput: NormalizedReplayOutputV1,
): ResponseCreateParamsNonStreaming {
  const validatedReplayOutput = normalizedReplayOutputV1Schema.parse(
    replayOutput,
  );
  return {
    model: MODEL_ID,
    previous_response_id: previousResponseId,
    instructions: FINAL_INSTRUCTIONS,
    input: [
      {
        type: 'function_call_output',
        call_id: callId,
        output: canonicalJson(validatedReplayOutput),
      },
    ],
    text: {
      format: zodTextFormat(
        investigationResultV1Schema,
        'investigation_result_v1',
      ),
    },
    reasoning: { effort: 'low' },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: true,
  };
}

export function normalizeRequiredUsage(
  usage: ResponseUsage | null | undefined,
): ModelTokenUsage {
  if (usage === null || usage === undefined) {
    throw new InvestigationProviderError({
      status: null,
      code: null,
      type: 'missing_usage',
      requestId: null,
    });
  }
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

export function summarizeResponseDiagnostics(response: Response): {
  outputItems: ProviderOutputItemSummary[];
  refusalPresent: boolean;
  incompleteReason: string | null;
  errorPresent: boolean;
} {
  return {
    outputItems: response.output.map((item) => ({
      type: item.type,
      status:
        'status' in item && typeof item.status === 'string'
          ? item.status
          : null,
      contentTypes:
        item.type === 'message'
          ? item.content.map((content) => content.type)
          : [],
    })),
    refusalPresent: response.output.some(
      (item) =>
        item.type === 'message' &&
        item.content.some((content) => content.type === 'refusal'),
    ),
    incompleteReason: response.incomplete_details?.reason ?? null,
    errorPresent: response.error !== null && response.error !== undefined,
  };
}

export class OpenAIResponsesProvider implements InvestigationProvider {
  readonly kind = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    if (apiKey.trim().length === 0) {
      throw new Error('OPENAI_API_KEY is required for a live investigation.');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: OPENAI_API_BASE_URL,
      maxRetries: 0,
      timeout: 90_000,
    });
  }

  async requestReplay(
    dossier: InvestigationDossierV1,
  ): Promise<ReplaySelectionProviderResponse> {
    const started = performance.now();
    const response = await this.client.responses
      .create(buildInitialOpenAIRequest(dossier))
      .catch((error: unknown) => {
        throw safeProviderError(error);
      });
    const latencyMs = Math.max(0, performance.now() - started);
    const diagnostics = summarizeResponseDiagnostics(response);
    const toolCalls = response.output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }));

    return {
      responseId: response.id,
      model: response.model,
      status: response.status ?? 'unknown',
      latencyMs,
      usage: normalizeRequiredUsage(response.usage),
      ...diagnostics,
      toolCalls,
    };
  }

  async requestConclusion(
    request: InvestigationConclusionRequest,
  ): Promise<ConclusionProviderResponse> {
    const started = performance.now();
    const response = await this.client.responses
      .create(
        buildFinalOpenAIRequest(
          request.previousResponseId,
          request.callId,
          request.replayOutput,
        ),
      )
      .catch((error: unknown) => {
        throw safeProviderError(error);
      });
    const latencyMs = Math.max(0, performance.now() - started);
    const diagnostics = summarizeResponseDiagnostics(response);

    return {
      responseId: response.id,
      model: response.model,
      status: response.status ?? 'unknown',
      latencyMs,
      usage: normalizeRequiredUsage(response.usage),
      ...diagnostics,
      outputText: response.output_text,
    };
  }
}

export function createOpenAIProviderFromEnvironment(): OpenAIResponsesProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error(
      'OPENAI_API_KEY is missing. Set it only for the explicit live investigation command.',
    );
  }
  return new OpenAIResponsesProvider(apiKey);
}
