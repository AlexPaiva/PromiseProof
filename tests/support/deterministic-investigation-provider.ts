import type {
  DiagnosticReplayId,
  InvestigationDossierV1,
  InvestigationResultV1,
  RankedHypothesisV1,
  ReplayToolArgumentsV1,
} from '../../src/investigation/contracts.js';
import type {
  ConclusionProviderResponse,
  InvestigationConclusionRequest,
  InvestigationProvider,
  ReplaySelectionProviderResponse,
} from '../../src/investigation/provider.js';
import { ZERO_TOKEN_USAGE } from '../../src/investigation/provider.js';

const OFFLINE_MODEL = 'offline-evidence-provider-v1';

type EvidenceSignature = 'identifiable_activity' | 'state_roundtrip';

function hasReference(
  dossier: InvestigationDossierV1,
  reference: string,
): boolean {
  return dossier.evidenceReferences.some((item) => item.id === reference);
}

function requireReferences(
  dossier: InvestigationDossierV1,
  references: readonly string[],
): string[] {
  for (const reference of references) {
    if (!hasReference(dossier, reference)) {
      throw new Error(`Offline provider requires dossier fact ${reference}.`);
    }
  }
  return [...references];
}

function identifyEvidenceSignature(
  dossier: InvestigationDossierV1,
): EvidenceSignature {
  if (
    dossier.activity.identifiableRequestCount > 0 ||
    dossier.activity.identifiableReceiptCount > 0
  ) {
    return 'identifiable_activity';
  }

  if (
    dossier.uiState.preference === 'off' &&
    dossier.browserStorageState.preference === 'off' &&
    dossier.backendPreferenceState.preference === 'on'
  ) {
    return 'state_roundtrip';
  }

  throw new Error('Offline provider received an unsupported evidence signature.');
}

function selectionFor(
  dossier: InvestigationDossierV1,
): ReplayToolArgumentsV1 {
  const signature = identifyEvidenceSignature(dossier);

  if (signature === 'identifiable_activity') {
    const leakEvidence = requireReferences(dossier, [
      'violation.PP_IDENTIFIABLE_EVENT_LEAK',
      'activity.requests',
      'activity.receipts',
      'events.ordering',
    ]);
    const stateEvidence = requireReferences(dossier, [
      'state.ui',
      'state.browser_storage',
      'state.backend_preference',
    ]);
    const hypotheses: RankedHypothesisV1[] = [
      {
        id: 'h1',
        title: 'Collector activation preceded authoritative preference hydration',
        rank: 1,
        confidence: 82,
        supportingEvidence: leakEvidence,
        contradictingEvidence: [],
      },
      {
        id: 'h2',
        title: 'A later preference-state transition triggered the activity request',
        rank: 2,
        confidence: 18,
        supportingEvidence: ['activity.requests', 'events.ordering'],
        contradictingEvidence: stateEvidence,
      },
    ];

    return {
      replayId: 'inspect_startup_order',
      hypotheses,
      purpose:
        'Compare collector activation with preference hydration and the first relevant network events.',
      evidenceReferences: [...new Set([...leakEvidence, ...stateEvidence])],
    };
  }

  const stateEvidence = requireReferences(dossier, [
    'violation.PP_PREFERENCE_NOT_PERSISTED',
    'state.ui',
    'state.browser_storage',
    'state.backend_preference',
  ]);
  const activityEvidence = requireReferences(dossier, [
    'activity.requests',
    'activity.receipts',
    'events.ordering',
  ]);
  const hypotheses: RankedHypothesisV1[] = [
    {
      id: 'h1',
      title: 'The OFF write and authoritative readback diverged',
      rank: 1,
      confidence: 86,
      supportingEvidence: stateEvidence,
      contradictingEvidence: [],
    },
    {
      id: 'h2',
      title: 'Collector activation preceded authoritative preference hydration',
      rank: 2,
      confidence: 14,
      supportingEvidence: ['events.ordering'],
      contradictingEvidence: ['activity.requests', 'activity.receipts'],
    },
  ];

  return {
    replayId: 'inspect_preference_roundtrip',
    hypotheses,
    purpose:
      'Compare the requested OFF write, its acknowledgement, and the authoritative readback.',
    evidenceReferences: [...new Set([...stateEvidence, ...activityEvidence])],
  };
}

function finalResult(
  initial: ReplayToolArgumentsV1,
  request: InvestigationConclusionRequest,
): InvestigationResultV1 {
  const replayReferences = request.replayOutput.evidenceReferences.map(
    (reference) => reference.id,
  );
  if (replayReferences.length === 0) {
    throw new Error('Offline provider requires normalized replay references.');
  }

  const primary = initial.hypotheses[0];
  const secondary = initial.hypotheses[1];
  if (primary === undefined || secondary === undefined) {
    throw new Error('Offline provider requires two initial hypotheses.');
  }

  const selectedReplay: DiagnosticReplayId = initial.replayId;
  const primaryReplayReferences = replayReferences.slice(0, 2);
  const secondaryReplayReference = replayReferences.at(-1);
  if (secondaryReplayReference === undefined) {
    throw new Error('Offline provider requires a replay reference.');
  }

  const primarySupported =
    request.replayOutput.replayId === 'inspect_startup_order'
      ? request.replayOutput.report.collectorBeforeHydration &&
        request.replayOutput.report.activityBeforePreferenceRead
      : !request.replayOutput.report.roundtripConsistent &&
        request.replayOutput.report.requested === 'off' &&
        request.replayOutput.report.acknowledged === 'off' &&
        request.replayOutput.report.authoritativeReadback === 'on';
  const primaryRelativeConfidence = primarySupported
    ? Math.min(100, primary.confidence + 12)
    : Math.max(0, primary.confidence - 22);
  const secondaryRelativeConfidence = primarySupported
    ? Math.max(0, secondary.confidence - 9)
    : Math.min(100, secondary.confidence + 9);

  return {
    hypotheses: [
      {
        hypothesisId: primary.id,
        relativeConfidence: primaryRelativeConfidence,
        supportingEvidenceReferences: [
          ...primary.supportingEvidence,
          ...(primarySupported ? primaryReplayReferences : []),
        ],
        contradictingEvidenceReferences: [
          ...primary.contradictingEvidence,
          ...(primarySupported ? [] : primaryReplayReferences),
        ],
        status: primarySupported ? 'supported' : 'weakened',
      },
      {
        hypothesisId: secondary.id,
        relativeConfidence: secondaryRelativeConfidence,
        supportingEvidenceReferences: secondary.supportingEvidence,
        contradictingEvidenceReferences: [
          ...secondary.contradictingEvidence,
          secondaryReplayReference,
        ],
        status: primarySupported ? 'weakened' : 'unresolved',
      },
    ],
    mostLikelyHypothesisId:
      primaryRelativeConfidence >= secondaryRelativeConfidence
        ? primary.id
        : secondary.id,
    replayPerformed: selectedReplay,
    conclusionEvidenceReferences: primaryReplayReferences,
    limitationCodes: [
      'single_replay_scope',
      'synthetic_evidence_scope',
      'diagnostic_not_verdict',
    ],
  };
}

/**
 * Deterministic offline double used by the ordinary suite. Its decision sees
 * the exact dossier boundary that the live provider sees and no server
 * selection state. Captured inputs make the boundary directly assertable.
 */
export class DeterministicInvestigationProvider
  implements InvestigationProvider
{
  readonly kind = 'offline' as const;
  readonly replayRequests: InvestigationDossierV1[] = [];
  readonly conclusionRequests: InvestigationConclusionRequest[] = [];

  private selection: ReplayToolArgumentsV1 | null = null;

  async requestReplay(
    dossier: InvestigationDossierV1,
  ): Promise<ReplaySelectionProviderResponse> {
    this.replayRequests.push(structuredClone(dossier));
    this.selection = selectionFor(dossier);

    return {
      responseId: 'offline-response-selection',
      model: OFFLINE_MODEL,
      status: 'completed',
      latencyMs: 0,
      usage: { ...ZERO_TOKEN_USAGE },
      outputItems: [
        {
          type: 'function_call',
          status: 'completed',
          contentTypes: [],
        },
      ],
      refusalPresent: false,
      incompleteReason: null,
      errorPresent: false,
      toolCalls: [
        {
          callId: 'offline-tool-call',
          name: 'run_diagnostic_replay',
          arguments: JSON.stringify(this.selection),
        },
      ],
    };
  }

  async requestConclusion(
    request: InvestigationConclusionRequest,
  ): Promise<ConclusionProviderResponse> {
    this.conclusionRequests.push(structuredClone(request));
    if (this.selection === null) {
      throw new Error('Conclusion requested before replay selection.');
    }
    if (
      request.previousResponseId !== 'offline-response-selection' ||
      request.callId !== 'offline-tool-call' ||
      request.replayOutput.replayId !== this.selection.replayId
    ) {
      throw new Error('Conclusion request did not continue the selected replay.');
    }

    return {
      responseId: 'offline-response-conclusion',
      model: OFFLINE_MODEL,
      status: 'completed',
      latencyMs: 0,
      usage: { ...ZERO_TOKEN_USAGE },
      outputItems: [
        {
          type: 'message',
          status: 'completed',
          contentTypes: ['output_text'],
        },
      ],
      refusalPresent: false,
      incompleteReason: null,
      errorPresent: false,
      outputText: JSON.stringify(finalResult(this.selection, request)),
    };
  }
}
