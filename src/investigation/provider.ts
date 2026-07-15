import type {
  InvestigationDossierV1,
  NormalizedReplayOutputV1,
} from './contracts.js';

export interface ModelTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface SafeProviderFailureDetails {
  status: number | null;
  code: string | null;
  type: string | null;
  requestId: string | null;
}

const SAFE_PROVIDER_IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,128}$/;

function sanitizedIdentifier(value: unknown): string | null {
  return typeof value === 'string' && SAFE_PROVIDER_IDENTIFIER.test(value)
    ? value
    : null;
}

/**
 * Project an arbitrary provider failure onto the only fields that may be
 * retained in an investigation artifact. The projection is deliberately
 * repeated at both error construction and artifact recording boundaries.
 */
export function sanitizeProviderFailureDetails(
  value: unknown,
): SafeProviderFailureDetails {
  const candidate =
    value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return Object.freeze({
    status:
      typeof candidate.status === 'number' &&
      Number.isInteger(candidate.status) &&
      candidate.status >= 100 &&
      candidate.status <= 599
        ? candidate.status
        : null,
    code: sanitizedIdentifier(candidate.code),
    type: sanitizedIdentifier(candidate.type),
    requestId: sanitizedIdentifier(candidate.requestId),
  });
}

export class InvestigationProviderError extends Error {
  readonly details: SafeProviderFailureDetails;

  constructor(details: unknown) {
    super('Investigation provider request failed.');
    this.name = 'InvestigationProviderError';
    this.details = sanitizeProviderFailureDetails(details);
  }
}

export interface RawFunctionToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ProviderOutputItemSummary {
  type: string;
  status: string | null;
  contentTypes: string[];
}

export interface ProviderResponseMetadata {
  responseId: string;
  model: string;
  status: string;
  latencyMs: number;
  usage: ModelTokenUsage;
}

export interface ReplaySelectionProviderResponse
  extends ProviderResponseMetadata {
  outputItems: ProviderOutputItemSummary[];
  refusalPresent: boolean;
  incompleteReason: string | null;
  errorPresent: boolean;
  toolCalls: RawFunctionToolCall[];
}

export interface InvestigationConclusionRequest {
  previousResponseId: string;
  callId: string;
  replayOutput: NormalizedReplayOutputV1;
}

export interface ConclusionProviderResponse extends ProviderResponseMetadata {
  outputItems: ProviderOutputItemSummary[];
  refusalPresent: boolean;
  incompleteReason: string | null;
  errorPresent: boolean;
  outputText: string;
}

export interface InvestigationProvider {
  readonly kind: 'offline' | 'openai';
  requestReplay(
    dossier: InvestigationDossierV1,
  ): Promise<ReplaySelectionProviderResponse>;
  requestConclusion(
    request: InvestigationConclusionRequest,
  ): Promise<ConclusionProviderResponse>;
}

export const ZERO_TOKEN_USAGE: ModelTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};
