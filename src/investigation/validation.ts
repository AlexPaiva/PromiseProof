import type {
  InvestigationDossierV1,
  InvestigationResultV1,
  NormalizedReplayOutputV1,
  ReplayToolArgumentsV1,
} from './contracts.js';
import { containsAuthoritativeOutcomeLanguage } from './authority-boundary.js';
import { deepFreeze } from './immutable.js';
import type {
  ConclusionProviderResponse,
  InvestigationProvider,
  ReplaySelectionProviderResponse,
} from './provider.js';
import {
  investigationResultV1Schema,
  replayToolArgumentsV1Schema,
} from './schemas.js';

export interface ValidationDecision {
  stage: string;
  accepted: boolean;
  code: string;
  detail: string;
}

export type ReplaySelectionValidation =
  | {
      accepted: true;
      decisions: ValidationDecision[];
      callId: string;
      arguments: ReplayToolArgumentsV1;
    }
  | {
      accepted: false;
      decisions: ValidationDecision[];
    };

export type ConclusionValidation =
  | {
      accepted: true;
      decisions: ValidationDecision[];
      result: InvestigationResultV1;
    }
  | {
      accepted: false;
      decisions: ValidationDecision[];
    };

type ProviderKind = InvestigationProvider['kind'];

const ACCEPTED_OPENAI_RESPONSE_MODELS = new Set([
  'gpt-5.6',
  'gpt-5.6-sol',
]);
const SAFE_PROVIDER_IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,128}$/;

function decision(
  stage: string,
  accepted: boolean,
  code: string,
  detail: string,
): ValidationDecision {
  return { stage, accepted, code, detail };
}

function rejected(
  decisions: ValidationDecision[],
  stage: string,
  code: string,
  detail: string,
): ReplaySelectionValidation | ConclusionValidation {
  decisions.push(decision(stage, false, code, detail));
  return { accepted: false, decisions };
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function modelIdentityIsValid(model: string, providerKind: ProviderKind): boolean {
  return providerKind === 'openai'
    ? ACCEPTED_OPENAI_RESPONSE_MODELS.has(model)
    : model.length > 0;
}

function metadataIsValid(response: {
  responseId: string;
  model: string;
  latencyMs: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
}): boolean {
  const usageValues = Object.values(response.usage);
  return (
    SAFE_PROVIDER_IDENTIFIER.test(response.responseId) &&
    response.model.length > 0 &&
    response.model.length <= 128 &&
    Number.isFinite(response.latencyMs) &&
    response.latencyMs >= 0 &&
    usageValues.every(
      (value) => Number.isInteger(value) && value >= 0,
    ) &&
    response.usage.cachedInputTokens <= response.usage.inputTokens &&
    response.usage.reasoningTokens <= response.usage.outputTokens &&
    response.usage.totalTokens ===
      response.usage.inputTokens + response.usage.outputTokens
  );
}

function allReferencesExist(
  references: readonly string[],
  allowedReferences: ReadonlySet<string>,
): boolean {
  return references.every((reference) => allowedReferences.has(reference));
}

function collectInitialReferences(
  value: ReplayToolArgumentsV1,
): string[] {
  return [
    ...value.evidenceReferences,
    ...value.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supportingEvidence,
      ...hypothesis.contradictingEvidence,
    ]),
  ];
}

function collectFinalReferences(value: InvestigationResultV1): string[] {
  return [
    ...value.conclusionEvidenceReferences,
    ...value.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supportingEvidenceReferences,
      ...hypothesis.contradictingEvidenceReferences,
    ]),
  ];
}

export function validateReplaySelection(
  response: ReplaySelectionProviderResponse,
  dossier: InvestigationDossierV1,
  providerKind: ProviderKind = 'offline',
): ReplaySelectionValidation {
  const decisions: ValidationDecision[] = [];

  if (!metadataIsValid(response)) {
    return rejected(
      decisions,
      'response_metadata',
      'PP_INV_RESPONSE_METADATA_REJECTED',
      'The first response metadata was incomplete or invalid.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'response_metadata',
      true,
      'PP_INV_RESPONSE_METADATA_ACCEPTED',
      'The first response metadata was finite and non-negative.',
    ),
  );

  if (!modelIdentityIsValid(response.model, providerKind)) {
    return rejected(
      decisions,
      'model_identity',
      'PP_INV_MODEL_IDENTITY_REJECTED',
      'The first response did not identify the requested GPT-5.6 alias or documented resolved Sol model.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'model_identity',
      true,
      'PP_INV_MODEL_IDENTITY_ACCEPTED',
      providerKind === 'openai'
        ? 'The first response identified the requested GPT-5.6 alias or documented resolved Sol model.'
        : 'The offline provider supplied a non-empty deterministic model identity.',
    ),
  );

  if (response.status !== 'completed') {
    return rejected(
      decisions,
      'response_status',
      'PP_INV_RESPONSE_INCOMPLETE',
      'The first model response was not completed.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'response_status',
      true,
      'PP_INV_RESPONSE_COMPLETED',
      'The first model response completed.',
    ),
  );

  const functionOutputItems = response.outputItems.filter(
    (item) => item.type === 'function_call',
  );
  const unexpectedOutput = response.outputItems.some(
    (item) => item.type !== 'reasoning' && item.type !== 'function_call',
  );
  if (
    unexpectedOutput ||
    functionOutputItems.length !== response.toolCalls.length
  ) {
    return rejected(
      decisions,
      'output_items',
      'PP_INV_UNEXPECTED_OUTPUT',
      'The first response contained an output type outside the bounded tool flow or its output summary did not match the function calls.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'output_items',
      true,
      'PP_INV_OUTPUT_BOUNDED',
      'Only reasoning metadata and function-call output items were present, and their summaries matched the function calls.',
    ),
  );

  if (
    functionOutputItems.some(
      (item) => item.status !== 'completed' || item.contentTypes.length !== 0,
    ) ||
    response.outputItems.some(
      (item) =>
        item.type === 'reasoning' &&
        item.status !== null &&
        item.status !== 'completed',
    )
  ) {
    return rejected(
      decisions,
      'output_item_status',
      'PP_INV_OUTPUT_ITEM_INCOMPLETE',
      'Every function-call output item must be completed before dispatch, and reasoning metadata must not be incomplete.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'output_item_status',
      true,
      'PP_INV_OUTPUT_ITEM_COMPLETED',
      'Every function-call output item was completed before dispatch, and reasoning metadata was not incomplete.',
    ),
  );

  if (
    response.refusalPresent ||
    response.incompleteReason !== null ||
    response.errorPresent
  ) {
    return rejected(
      decisions,
      'response_content',
      'PP_INV_SELECTION_CONTENT_REJECTED',
      'The first response included a refusal, incomplete-response reason, or provider error.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'response_content',
      true,
      'PP_INV_SELECTION_CONTENT_ACCEPTED',
      'The first response contained no refusal, incomplete-response reason, or provider error.',
    ),
  );

  if (response.toolCalls.length !== 1) {
    return rejected(
      decisions,
      'tool_count',
      'PP_INV_TOOL_COUNT_REJECTED',
      'Exactly one diagnostic replay request is required.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'tool_count',
      true,
      'PP_INV_SINGLE_TOOL_CALL',
      'Exactly one function call was returned.',
    ),
  );

  const [toolCall] = response.toolCalls;
  if (toolCall === undefined || toolCall.name !== 'run_diagnostic_replay') {
    return rejected(
      decisions,
      'tool_name',
      'PP_INV_UNKNOWN_TOOL',
      'The requested function was not allowlisted.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'tool_name',
      true,
      'PP_INV_TOOL_ALLOWLISTED',
      'The requested function matched the sole allowlisted function.',
    ),
  );

  if (!SAFE_PROVIDER_IDENTIFIER.test(toolCall.callId)) {
    return rejected(
      decisions,
      'tool_call_id',
      'PP_INV_TOOL_CALL_ID_REJECTED',
      'The allowlisted function call did not include a bounded continuation ID.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'tool_call_id',
      true,
      'PP_INV_TOOL_CALL_ID_ACCEPTED',
      'The allowlisted function call included a bounded continuation ID.',
    ),
  );

  let rawArguments: unknown;
  try {
    rawArguments = JSON.parse(toolCall.arguments);
  } catch {
    return rejected(
      decisions,
      'arguments_json',
      'PP_INV_ARGUMENTS_NOT_JSON',
      'Function arguments were not valid JSON.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'arguments_json',
      true,
      'PP_INV_ARGUMENTS_JSON',
      'Function arguments were valid JSON.',
    ),
  );

  const parsedArguments = replayToolArgumentsV1Schema.safeParse(rawArguments);
  if (!parsedArguments.success) {
    return rejected(
      decisions,
      'arguments_schema',
      'PP_INV_ARGUMENTS_SCHEMA_REJECTED',
      'Function arguments did not match the strict schema.',
    ) as ReplaySelectionValidation;
  }
  const value = parsedArguments.data;
  decisions.push(
    decision(
      'arguments_schema',
      true,
      'PP_INV_ARGUMENTS_SCHEMA_ACCEPTED',
      'Function arguments matched the strict schema.',
    ),
  );

  const ids = value.hypotheses.map((hypothesis) => hypothesis.id);
  const ranks = value.hypotheses.map((hypothesis) => hypothesis.rank);
  const expectedRanks = value.hypotheses.map((_, index) => index + 1);
  const ranksAreContiguous = ranks.every(
    (rank, index) => rank === expectedRanks[index],
  );
  const confidenceIsDescending = value.hypotheses.every(
    (hypothesis, index) =>
      index === 0 ||
      (value.hypotheses[index - 1]?.confidence ?? 0) >= hypothesis.confidence,
  );
  if (!hasUniqueValues(ids) || !ranksAreContiguous || !confidenceIsDescending) {
    return rejected(
      decisions,
      'hypothesis_ranking',
      'PP_INV_HYPOTHESIS_RANKING_REJECTED',
      'Hypothesis IDs, ranks, or confidence ordering were invalid.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'hypothesis_ranking',
      true,
      'PP_INV_HYPOTHESIS_RANKING_ACCEPTED',
      'Hypotheses had unique IDs and contiguous confidence-ordered ranks.',
    ),
  );

  const dossierReferences = new Set(
    dossier.evidenceReferences.map((reference) => reference.id),
  );
  const citedReferences = collectInitialReferences(value);
  if (
    !hasUniqueValues(value.evidenceReferences) ||
    !allReferencesExist(citedReferences, dossierReferences)
  ) {
    return rejected(
      decisions,
      'evidence_references',
      'PP_INV_EVIDENCE_REFERENCE_REJECTED',
      'At least one model evidence reference was absent from the dossier.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'evidence_references',
      true,
      'PP_INV_EVIDENCE_REFERENCES_ACCEPTED',
      'Every model evidence reference resolved to an allowlisted dossier fact.',
    ),
  );

  if (containsAuthoritativeOutcomeLanguage(value)) {
    return rejected(
      decisions,
      'verdict_boundary',
      'PP_INV_VERDICT_LANGUAGE_REJECTED',
      'Diagnostic output attempted to declare a reserved outcome.',
    ) as ReplaySelectionValidation;
  }
  decisions.push(
    decision(
      'verdict_boundary',
      true,
      'PP_INV_VERDICT_BOUNDARY_ACCEPTED',
      'Diagnostic output contained no reserved outcome declaration.',
    ),
  );

  return {
    accepted: true,
    decisions,
    callId: toolCall.callId,
    arguments: deepFreeze(value),
  };
}

export function validateConclusion(
  response: ConclusionProviderResponse,
  initial: ReplayToolArgumentsV1,
  replayOutput: NormalizedReplayOutputV1,
  dossier: InvestigationDossierV1,
  providerKind: ProviderKind = 'offline',
): ConclusionValidation {
  const decisions: ValidationDecision[] = [];

  if (!metadataIsValid(response)) {
    return rejected(
      decisions,
      'response_metadata',
      'PP_INV_FINAL_RESPONSE_METADATA_REJECTED',
      'The final response metadata was incomplete or invalid.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'response_metadata',
      true,
      'PP_INV_FINAL_RESPONSE_METADATA_ACCEPTED',
      'The final response metadata was finite and non-negative.',
    ),
  );

  if (!modelIdentityIsValid(response.model, providerKind)) {
    return rejected(
      decisions,
      'model_identity',
      'PP_INV_FINAL_MODEL_IDENTITY_REJECTED',
      'The final response did not identify the requested GPT-5.6 alias or documented resolved Sol model.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'model_identity',
      true,
      'PP_INV_FINAL_MODEL_IDENTITY_ACCEPTED',
      providerKind === 'openai'
        ? 'The final response identified the requested GPT-5.6 alias or documented resolved Sol model.'
        : 'The offline provider supplied a non-empty deterministic model identity.',
    ),
  );

  if (response.status !== 'completed') {
    return rejected(
      decisions,
      'response_status',
      'PP_INV_FINAL_RESPONSE_INCOMPLETE',
      'The final model response was not completed.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'response_status',
      true,
      'PP_INV_FINAL_RESPONSE_COMPLETED',
      'The final model response completed.',
    ),
  );

  const finalMessageItems = response.outputItems.filter(
    (item) => item.type === 'message',
  );
  const unexpectedFinalOutput = response.outputItems.some(
    (item) => item.type !== 'reasoning' && item.type !== 'message',
  );
  if (
    unexpectedFinalOutput ||
    finalMessageItems.length !== 1 ||
    response.refusalPresent ||
    response.incompleteReason !== null ||
    response.errorPresent
  ) {
    return rejected(
      decisions,
      'final_output_kinds',
      'PP_INV_FINAL_UNEXPECTED_OUTPUT',
      'The final response contained a tool call, refusal, incomplete reason, provider error, or an unexpected message shape.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'final_output_kinds',
      true,
      'PP_INV_FINAL_OUTPUT_BOUNDED',
      'The final response contained exactly one structured message and optional reasoning metadata.',
    ),
  );

  const finalMessageItem = finalMessageItems[0];
  const incompleteReasoningItem = response.outputItems.some(
    (item) =>
      item.type === 'reasoning' &&
      item.status !== null &&
      item.status !== 'completed',
  );
  if (finalMessageItem?.status !== 'completed' || incompleteReasoningItem) {
    return rejected(
      decisions,
      'final_message_status',
      'PP_INV_FINAL_OUTPUT_ITEM_INCOMPLETE',
      'The sole final message item was not completed or reasoning metadata was incomplete.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'final_message_status',
      true,
      'PP_INV_FINAL_OUTPUT_ITEM_COMPLETED',
      'The sole final message item completed and reasoning metadata was not incomplete.',
    ),
  );

  if (
    finalMessageItem.contentTypes.length !== 1 ||
    finalMessageItem.contentTypes[0] !== 'output_text'
  ) {
    return rejected(
      decisions,
      'final_message_content',
      'PP_INV_FINAL_MESSAGE_CONTENT_REJECTED',
      'The sole final message must contain exactly one output_text content item.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'final_message_content',
      true,
      'PP_INV_FINAL_MESSAGE_CONTENT_ACCEPTED',
      'The sole final message contained exactly one output_text content item.',
    ),
  );

  let rawResult: unknown;
  try {
    rawResult = JSON.parse(response.outputText);
  } catch {
    return rejected(
      decisions,
      'result_json',
      'PP_INV_RESULT_NOT_JSON',
      'The final output was not valid JSON.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'result_json',
      true,
      'PP_INV_RESULT_JSON',
      'The final output was valid JSON.',
    ),
  );

  const parsedResult = investigationResultV1Schema.safeParse(rawResult);
  if (!parsedResult.success) {
    return rejected(
      decisions,
      'result_schema',
      'PP_INV_RESULT_SCHEMA_REJECTED',
      'The final output did not match the strict result schema.',
    ) as ConclusionValidation;
  }
  const result = parsedResult.data;
  decisions.push(
    decision(
      'result_schema',
      true,
      'PP_INV_RESULT_SCHEMA_ACCEPTED',
      'The final output matched the strict result schema.',
    ),
  );

  if (result.replayPerformed !== initial.replayId) {
    return rejected(
      decisions,
      'replay_identity',
      'PP_INV_REPLAY_IDENTITY_REJECTED',
      'The final output named a replay other than the executed replay.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'replay_identity',
      true,
      'PP_INV_REPLAY_IDENTITY_ACCEPTED',
      'The final output named the replay that deterministic code executed.',
    ),
  );

  const initialIds = initial.hypotheses.map((hypothesis) => hypothesis.id);
  const finalIds = result.hypotheses.map(
    (hypothesis) => hypothesis.hypothesisId,
  );
  if (
    initialIds.length !== finalIds.length ||
    finalIds.some((id, index) => id !== initialIds[index])
  ) {
    return rejected(
      decisions,
      'hypothesis_continuity',
      'PP_INV_HYPOTHESIS_CONTINUITY_REJECTED',
      'The final output did not update the same ranked hypothesis set.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'hypothesis_continuity',
      true,
      'PP_INV_HYPOTHESIS_CONTINUITY_ACCEPTED',
      'The final output updated the same ranked hypothesis set.',
    ),
  );

  const mostLikelyIndex = result.hypotheses.reduce(
    (bestIndex, hypothesis, index, hypotheses) =>
      hypothesis.relativeConfidence >
      (hypotheses[bestIndex]?.relativeConfidence ?? -1)
        ? index
        : bestIndex,
    0,
  );
  const expectedMostLikelyId =
    result.hypotheses[mostLikelyIndex]?.hypothesisId;
  if (result.mostLikelyHypothesisId !== expectedMostLikelyId) {
    return rejected(
      decisions,
      'leading_hypothesis',
      'PP_INV_LEADING_HYPOTHESIS_REJECTED',
      'The leading hypothesis ID did not identify the first maximum-confidence hypothesis.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'leading_hypothesis',
      true,
      'PP_INV_LEADING_HYPOTHESIS_ACCEPTED',
      'The leading hypothesis ID identified the first maximum-confidence hypothesis.',
    ),
  );

  const originalReferences = dossier.evidenceReferences.map(
    (reference) => reference.id,
  );
  const replayReferences = replayOutput.evidenceReferences.map(
    (reference) => reference.id,
  );
  const allowedReferences = new Set([
    ...originalReferences,
    ...replayReferences,
  ]);
  const finalReferences = collectFinalReferences(result);
  if (!allReferencesExist(finalReferences, allowedReferences)) {
    return rejected(
      decisions,
      'evidence_references',
      'PP_INV_FINAL_EVIDENCE_REFERENCE_REJECTED',
      'At least one final evidence reference was not allowlisted.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'evidence_references',
      true,
      'PP_INV_FINAL_EVIDENCE_REFERENCES_ACCEPTED',
      'Every final evidence reference resolved to dossier or replay facts.',
    ),
  );

  const replayReferenceSet = new Set(replayReferences);
  const conclusionUsesReplay = result.conclusionEvidenceReferences.some(
    (reference) => replayReferenceSet.has(reference),
  );
  const groundedStatuses = result.hypotheses.every((hypothesis) => {
    if (hypothesis.status === 'unresolved') {
      return true;
    }
    const requiredReferences =
      hypothesis.status === 'supported'
        ? hypothesis.supportingEvidenceReferences
        : hypothesis.contradictingEvidenceReferences;
    return requiredReferences.some((reference) =>
      replayReferenceSet.has(reference),
    );
  });
  const materiallyUpdated = result.hypotheses.some((hypothesis) => {
    if (hypothesis.status === 'unresolved') {
      return false;
    }
    const requiredReferences =
      hypothesis.status === 'supported'
        ? hypothesis.supportingEvidenceReferences
        : hypothesis.contradictingEvidenceReferences;
    return requiredReferences.some((reference) =>
      replayReferenceSet.has(reference),
    );
  });
  const leadingHypothesis = result.hypotheses.find(
    (hypothesis) =>
      hypothesis.hypothesisId === result.mostLikelyHypothesisId,
  );
  const leadingUsesReplay =
    leadingHypothesis?.status === 'supported' &&
    leadingHypothesis.supportingEvidenceReferences.some((reference) =>
      replayReferenceSet.has(reference),
    );
  if (
    !conclusionUsesReplay ||
    !groundedStatuses ||
    !materiallyUpdated ||
    !leadingUsesReplay
  ) {
    return rejected(
      decisions,
      'material_update',
      'PP_INV_MATERIAL_UPDATE_REJECTED',
      'The required status-specific arrays and leading hypothesis did not cite executed-replay reference IDs.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'material_update',
      true,
      'PP_INV_MATERIAL_UPDATE_ACCEPTED',
      'Required status-specific arrays, the leading hypothesis, and conclusion evidence cited executed-replay reference IDs.',
    ),
  );

  if (containsAuthoritativeOutcomeLanguage(result)) {
    return rejected(
      decisions,
      'verdict_boundary',
      'PP_INV_FINAL_VERDICT_LANGUAGE_REJECTED',
      'The final diagnostic output attempted to declare a reserved outcome.',
    ) as ConclusionValidation;
  }
  decisions.push(
    decision(
      'verdict_boundary',
      true,
      'PP_INV_FINAL_VERDICT_BOUNDARY_ACCEPTED',
      'The final diagnostic output contained no reserved outcome declaration.',
    ),
  );

  return { accepted: true, decisions, result: deepFreeze(result) };
}
