import { z } from 'zod';

import { containsAuthoritativeOutcomeLanguage } from './authority-boundary.js';
import {
  DIAGNOSTIC_REPLAY_IDS,
  DOSSIER_VERSION,
  HYPOTHESIS_IDS,
  INVESTIGATION_LIMITATION_CODES,
  OFF_CLAUSE_IDS,
  RELEVANT_EVENT_NAMES,
  type EvidenceReferenceV1,
  type InvestigationDossierV1,
  type InvestigationResultV1,
  type NormalizedReplayOutputV1,
  type RankedHypothesisV1,
  type ReplayToolArgumentsV1,
} from './contracts.js';

const preferenceSchema = z.enum(['on', 'off']);
const recommendationSourceSchema = z.enum(['contextual', 'behavioral']);

const activityPayloadSchema = z
  .object({
    runId: z.string().min(1),
    userId: z.string().min(1),
    eventType: z.literal('page_view'),
    itemId: z.string().min(1),
    clientSequence: z.number().int().nonnegative(),
    occurredAt: z.string().min(1),
  })
  .strict();

const activityReceiptSchema = z
  .object({
    kind: z.literal('activity'),
    service: z.literal('recommendation'),
    receiptId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    receivedAt: z.string().min(1),
    payload: activityPayloadSchema,
  })
  .strict();

const recommendationItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string(),
    eyebrow: z.string(),
  })
  .strict();

const recommendationReceiptSchema = z
  .object({
    kind: z.literal('recommendation'),
    receiptId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    receivedAt: z.string().min(1),
    source: recommendationSourceSchema,
    userId: z.string().min(1).optional(),
    items: z.array(recommendationItemSchema),
  })
  .strict();

const preferenceReceiptSchema = z
  .object({
    kind: z.literal('preference'),
    receiptId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    receivedAt: z.string().min(1),
    userId: z.string().min(1),
    preference: preferenceSchema,
  })
  .strict();

const preferenceUpdateRequestSchema = z
  .object({
    targetUserId: z.string().min(1),
    payload: z
      .object({
        runId: z.string().min(1),
        preference: preferenceSchema,
      })
      .strict(),
  })
  .strict();

const preferenceUpdateResponseSchema = z
  .object({
    userId: z.string().min(1),
    preference: preferenceSchema,
    updatedAt: z.string().min(1),
    receipt: preferenceReceiptSchema,
  })
  .strict();

const timelineDetailValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const clientTimelineEntrySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    event: z.string().min(1),
    timestamp: z.string().min(1),
    detail: z.record(z.string(), timelineDetailValueSchema).optional(),
  })
  .strict();

export const promiseEvidenceSchema = z
  .object({
    scenario: preferenceSchema,
    runId: z.string().min(1),
    userId: z.string().min(1),
    ui: z
      .object({
        preference: preferenceSchema,
        toggleChecked: z.boolean(),
        feedFunctional: z.boolean(),
      })
      .strict(),
    storage: z
      .object({
        preference: preferenceSchema.nullable(),
      })
      .strict(),
    request: z
      .object({
        activityPayloads: z.array(activityPayloadSchema),
        preferenceUpdates: z.array(preferenceUpdateRequestSchema),
      })
      .strict(),
    response: z
      .object({
        preferenceUpdates: z.array(preferenceUpdateResponseSchema),
      })
      .strict(),
    backend: z
      .object({
        preference: preferenceSchema,
        activityReceipts: z.array(activityReceiptSchema),
        recommendationReceipts: z.array(recommendationReceiptSchema),
        preferenceReceipts: z.array(preferenceReceiptSchema),
      })
      .strict(),
    recommendation: z
      .object({
        source: recommendationSourceSchema,
        itemIds: z.array(z.string().min(1)),
      })
      .strict(),
    timestamps: z
      .object({
        clientTimeline: z.array(clientTimelineEntrySchema),
        activityReceivedAt: z.array(z.string().min(1)),
        preferenceReceivedAt: z.array(z.string().min(1)),
        recommendationReceivedAt: z.array(z.string().min(1)),
      })
      .strict(),
    journey: z
      .object({
        reloadObserved: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const diagnosticReplayIdSchema = z.enum(DIAGNOSTIC_REPLAY_IDS);
const offClauseIdSchema = z.enum(OFF_CLAUSE_IDS);
const relevantEventNameSchema = z.enum(RELEVANT_EVENT_NAMES);

export const evidenceReferenceV1Schema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/),
    description: z.string().min(1).max(500),
  })
  .strict();

const dossierClauseV1Schema = z
  .object({
    id: offClauseIdSchema,
    description: z.string().min(1).max(300),
    expected: z.string().min(1).max(500),
    observed: z.string().min(1).max(500),
    met: z.boolean(),
  })
  .strict();

export const investigationDossierV1Schema = z
  .object({
    version: z.literal(DOSSIER_VERSION),
    promiseStatement: z.string().min(1).max(600),
    contractClauses: z.array(dossierClauseV1Schema).length(3),
    violationCodes: z
      .array(
        z.enum([
          'PP_IDENTIFIABLE_EVENT_LEAK',
          'PP_CONTEXTUAL_FEED_MISSING',
          'PP_PREFERENCE_NOT_PERSISTED',
        ]),
      )
      .min(1)
      .max(3),
    uiState: z
      .object({
        preference: preferenceSchema,
        toggleChecked: z.boolean(),
      })
      .strict(),
    browserStorageState: z
      .object({
        preference: preferenceSchema.nullable(),
      })
      .strict(),
    backendPreferenceState: z
      .object({
        preference: preferenceSchema,
      })
      .strict(),
    activity: z
      .object({
        requestCount: z.number().int().nonnegative(),
        identifiableRequestCount: z.number().int().nonnegative(),
        receiptCount: z.number().int().nonnegative(),
        identifiableReceiptCount: z.number().int().nonnegative(),
      })
      .strict(),
    recommendation: z
      .object({
        mode: recommendationSourceSchema,
        itemCount: z.number().int().nonnegative(),
        feedFunctional: z.boolean(),
      })
      .strict(),
    eventOrdering: z.array(relevantEventNameSchema).max(100),
    evidenceReferences: z.array(evidenceReferenceV1Schema).min(1).max(150),
    availableReplays: z
      .array(
        z
          .object({
            id: diagnosticReplayIdSchema,
            description: z.string().min(1).max(300),
          })
          .strict(),
      )
      .length(2),
  })
  .strict()
  .superRefine((value, context) => {
    const clauseIds = value.contractClauses.map((clause) => clause.id);
    if (clauseIds.some((id, index) => id !== OFF_CLAUSE_IDS[index])) {
      context.addIssue({
        code: 'custom',
        path: ['contractClauses'],
        message: 'Contract clauses must use the canonical OFF ordering.',
      });
    }

    const referenceIds = value.evidenceReferences.map((reference) => reference.id);
    if (new Set(referenceIds).size !== referenceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceReferences'],
        message: 'Evidence reference IDs must be unique.',
      });
    }

    const replayIds = value.availableReplays.map((replay) => replay.id);
    if (
      replayIds.some((id, index) => id !== DIAGNOSTIC_REPLAY_IDS[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['availableReplays'],
        message: 'Replay descriptions must use the registered ordering.',
      });
    }
  });

const rankedHypothesisV1Schema = z
  .object({
    id: z.enum(HYPOTHESIS_IDS),
    title: z.string().min(1).max(200),
    rank: z.number().int().min(1).max(4),
    confidence: z.number().int().min(0).max(100),
    supportingEvidence: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/))
      .min(1)
      .max(20),
    contradictingEvidence: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/))
      .max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const supporting = new Set(value.supportingEvidence);
    const contradicting = new Set(value.contradictingEvidence);
    if (
      supporting.size !== value.supportingEvidence.length ||
      contradicting.size !== value.contradictingEvidence.length ||
      value.supportingEvidence.some((reference) => contradicting.has(reference))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Hypothesis supporting and contradicting evidence must be unique and disjoint.',
      });
    }
  });

export const replayToolArgumentsV1Schema = z
  .object({
    replayId: diagnosticReplayIdSchema,
    hypotheses: z.array(rankedHypothesisV1Schema).min(2).max(4),
    purpose: z.string().min(1).max(500),
    evidenceReferences: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/))
      .min(1)
      .max(30),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.hypotheses.map((hypothesis) => hypothesis.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['hypotheses'],
        message: 'Hypothesis IDs must be unique.',
      });
    }

    if (
      value.hypotheses.some(
        (hypothesis, index) => hypothesis.id !== HYPOTHESIS_IDS[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['hypotheses'],
        message: 'Hypotheses must use the project-owned opaque IDs in rank order.',
      });
    }

    const ranks = value.hypotheses
      .map((hypothesis) => hypothesis.rank)
      .sort((left, right) => left - right);
    if (ranks.some((rank, index) => rank !== index + 1)) {
      context.addIssue({
        code: 'custom',
        path: ['hypotheses'],
        message: 'Hypothesis ranks must be unique and contiguous from one.',
      });
    }

    if (new Set(value.evidenceReferences).size !== value.evidenceReferences.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceReferences'],
        message: 'Tool evidence references must be unique.',
      });
    }
  });

const finalHypothesisV1Schema = z
  .object({
    hypothesisId: z.enum(HYPOTHESIS_IDS),
    relativeConfidence: z.number().int().min(0).max(100),
    supportingEvidenceReferences: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/))
      .min(1)
      .max(30),
    contradictingEvidenceReferences: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/))
      .max(30),
    status: z.enum(['supported', 'weakened', 'unresolved']),
  })
  .strict()
  .superRefine((value, context) => {
    const supporting = new Set(value.supportingEvidenceReferences);
    const contradicting = new Set(value.contradictingEvidenceReferences);
    if (
      supporting.size !== value.supportingEvidenceReferences.length ||
      contradicting.size !== value.contradictingEvidenceReferences.length ||
      value.supportingEvidenceReferences.some((reference) =>
        contradicting.has(reference),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Final supporting and contradicting evidence must be unique and disjoint.',
      });
    }
  });

export const investigationResultV1Schema = z
  .object({
    hypotheses: z.array(finalHypothesisV1Schema).min(2).max(4),
    mostLikelyHypothesisId: z.enum(HYPOTHESIS_IDS),
    replayPerformed: diagnosticReplayIdSchema,
    conclusionEvidenceReferences: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/))
      .min(1)
      .max(30),
    limitationCodes: z
      .array(z.enum(INVESTIGATION_LIMITATION_CODES))
      .length(INVESTIGATION_LIMITATION_CODES.length),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.hypotheses.map((hypothesis) => hypothesis.hypothesisId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['hypotheses'],
        message: 'Hypothesis IDs must be unique.',
      });
    }

    if (
      value.limitationCodes.some(
        (code, index) => code !== INVESTIGATION_LIMITATION_CODES[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['limitationCodes'],
        message: 'Limitation codes must use the complete canonical ordering.',
      });
    }

    if (
      new Set(value.conclusionEvidenceReferences).size !==
      value.conclusionEvidenceReferences.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['conclusionEvidenceReferences'],
        message: 'Conclusion evidence references must be unique.',
      });
    }

    if (!ids.includes(value.mostLikelyHypothesisId)) {
      context.addIssue({
        code: 'custom',
        path: ['mostLikelyHypothesisId'],
        message: 'The leading hypothesis ID must identify a returned hypothesis.',
      });
    }

    if (containsAuthoritativeOutcomeLanguage(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Investigation output contains an authoritative outcome claim.',
      });
    }
  });

export const startupOrderReplayReportV1Schema = z
  .object({
    events: z.array(relevantEventNameSchema).max(100),
    collectorIndex: z.number().int().min(-1).max(100),
    hydrationIndex: z.number().int().min(-1).max(100),
    collectorBeforeHydration: z.boolean(),
    activityRequestCount: z.number().int().nonnegative(),
    activityReceiptCount: z.number().int().nonnegative(),
    networkEvents: z
      .array(z.enum(['activity_post', 'preference_read', 'preference_write']))
      .max(100),
    activityBeforePreferenceRead: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedCollectorIndex = value.events.indexOf('collector_started');
    const expectedHydrationIndex = value.events.indexOf(
      'preference_hydration_started',
    );
    const expectedCollectorBeforeHydration =
      expectedCollectorIndex >= 0 &&
      expectedHydrationIndex >= 0 &&
      expectedCollectorIndex < expectedHydrationIndex;
    if (
      value.collectorIndex !== expectedCollectorIndex ||
      value.hydrationIndex !== expectedHydrationIndex ||
      value.collectorBeforeHydration !== expectedCollectorBeforeHydration ||
      (value.collectorIndex >= 0 &&
        value.events[value.collectorIndex] !== 'collector_started') ||
      (value.hydrationIndex >= 0 &&
        value.events[value.hydrationIndex] !==
          'preference_hydration_started')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Startup replay event indices and ordering are inconsistent.',
      });
    }

    const activityIndex = value.networkEvents.indexOf('activity_post');
    const preferenceReadIndex = value.networkEvents.indexOf('preference_read');
    const expectedActivityBeforePreferenceRead =
      activityIndex >= 0 &&
      preferenceReadIndex >= 0 &&
      activityIndex < preferenceReadIndex;
    if (
      value.activityBeforePreferenceRead !==
      expectedActivityBeforePreferenceRead
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Startup replay network ordering is inconsistent.',
      });
    }
  });

export const preferenceRoundtripReplayReportV1Schema = z
  .object({
    requested: z.literal('off'),
    acknowledged: preferenceSchema,
    authoritativeReadback: preferenceSchema,
    receiptRecorded: z.boolean(),
    identityCorrelated: z.boolean(),
    roundtripConsistent: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedConsistency =
      value.acknowledged === 'off' &&
      value.authoritativeReadback === 'off';
    if (value.roundtripConsistent !== expectedConsistency) {
      context.addIssue({
        code: 'custom',
        message: 'Preference replay states and consistency flag disagree.',
      });
    }
  });

const normalizedStartupReplayOutputV1Schema = z
  .object({
    replayId: z.literal('inspect_startup_order'),
    report: startupOrderReplayReportV1Schema,
    evidenceReferences: z.array(evidenceReferenceV1Schema).min(1).max(20),
  })
  .strict();

const normalizedPreferenceReplayOutputV1Schema = z
  .object({
    replayId: z.literal('inspect_preference_roundtrip'),
    report: preferenceRoundtripReplayReportV1Schema,
    evidenceReferences: z.array(evidenceReferenceV1Schema).min(1).max(20),
  })
  .strict();

export const normalizedReplayOutputV1Schema = z.discriminatedUnion('replayId', [
  normalizedStartupReplayOutputV1Schema,
  normalizedPreferenceReplayOutputV1Schema,
]);

const schemaTypeChecks: {
  dossier: z.infer<typeof investigationDossierV1Schema> extends InvestigationDossierV1
    ? true
    : false;
  evidenceReference: z.infer<
    typeof evidenceReferenceV1Schema
  > extends EvidenceReferenceV1
    ? true
    : false;
  rankedHypothesis: z.infer<
    typeof rankedHypothesisV1Schema
  > extends RankedHypothesisV1
    ? true
    : false;
  toolArguments: z.infer<
    typeof replayToolArgumentsV1Schema
  > extends ReplayToolArgumentsV1
    ? true
    : false;
  result: z.infer<typeof investigationResultV1Schema> extends InvestigationResultV1
    ? true
    : false;
  replayOutput: z.infer<
    typeof normalizedReplayOutputV1Schema
  > extends NormalizedReplayOutputV1
    ? true
    : false;
} = {
  dossier: true,
  evidenceReference: true,
  rankedHypothesis: true,
  toolArguments: true,
  result: true,
  replayOutput: true,
};

void schemaTypeChecks;
