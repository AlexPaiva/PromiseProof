import { z } from 'zod';

import judgeBundleJson from '../../artifacts/judge/judge-bundle.json';
import liveStabilityJson from '../../artifacts/milestone-03-live-stability.json';

/**
 * Browser-safe validation for the judge interface.
 *
 * `src/judge/rehearsal.ts` owns the authoritative Node-side validation and is
 * frozen. It imports `node:fs`/`node:child_process`, so it cannot run in the
 * browser. This module re-states the same tracked contracts as strict runtime
 * schemas so the judge page fails closed rather than rendering unverified text.
 *
 * Nothing here may introduce a fact. Every exported value is either copied from
 * a validated tracked artifact or is a named, documented projection of one.
 */

export const JUDGE_BUNDLE_SCHEMA_VERSION =
  'promiseproof.judge-bundle.v1' as const;
export const LIVE_STABILITY_SCHEMA_VERSION =
  'promiseproof.live-stability-receipt.v1' as const;

const RACE_EVIDENCE_SIGNATURE = 'identifiable_activity_leak' as const;
const RACE_FAILED_CLAUSE = 'no_identifiable_activity' as const;
const PREFERENCE_CLAUSE = 'preference_survives_reload' as const;
const FEED_CLAUSE = 'contextual_feed_functional' as const;

const TIMELINE_EVENTS = [
  'collector_started',
  'identifiable_activity_received',
  'preference_hydration_completed',
] as const;

export class JudgeDataError extends Error {
  constructor(message: string) {
    super(`PP_JUDGE_DATA_INVALID: ${message}`);
    this.name = 'JudgeDataError';
  }
}

const judgeBundleSchema = z
  .object({
    schemaVersion: z.literal(JUDGE_BUNDLE_SCHEMA_VERSION),
    product: z
      .object({
        name: z.literal('PromiseProof'),
        descriptor: z.string().min(1).max(200),
      })
      .strict(),
    canonicalPromise: z.string().min(1).max(600),
    observedContradiction: z
      .object({
        scenario: z.literal('off'),
        result: z.literal('broken'),
        violationCode: z.literal('PP_IDENTIFIABLE_EVENT_LEAK'),
      })
      .strict(),
    initialHypotheses: z
      .array(
        z
          .object({
            id: z.enum(['h1', 'h2', 'h3', 'h4']),
            statement: z.string().min(1).max(300),
            result: z.enum(['supported', 'not_selected']),
          })
          .strict(),
      )
      .min(2)
      .max(4),
    investigation: z
      .object({
        label: z.literal('Recorded authentic GPT-5.6 run'),
        selectedReplay: z.literal('inspect_startup_order'),
        replayExpectation: z.string().min(1).max(300),
        observedTimeline: z.array(z.enum(TIMELINE_EVENTS)).min(1).max(20),
        postReplayResult: z.string().min(1).max(300),
        provenance: z.literal('recorded_authentic_gpt56'),
      })
      .strict(),
    repair: z
      .object({
        label: z.literal('Recorded authentic Codex repair'),
        repairId: z.string().regex(/^[a-f0-9-]{36}$/u),
        baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
        patchSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        patchBytes: z.number().int().positive().max(32 * 1024),
        changedPaths: z.tuple([
          z.literal('src/client/main.ts'),
          z.literal('tests/regression/initialization-order.spec.ts'),
        ]),
        humanApproval: z.literal('approved'),
        provenance: z.literal('recorded_authentic_codex'),
      })
      .strict(),
    verification: z
      .object({
        label: z.literal('Reproducible offline verification'),
        matrix: z
          .object({
            off: z.literal('pass'),
            reload: z.literal('pass'),
            on: z.literal('pass'),
            browser: z.literal('pass'),
            propagationControl: z.literal('pass'),
          })
          .strict(),
        authority: z.literal('unchanged_playwright_and_deterministic_evaluator'),
        provenance: z.tuple([
          z.literal('reproducible_offline_verification'),
          z.literal('deterministic_verdict'),
        ]),
      })
      .strict(),
  })
  .strict();

export type JudgeBundleV1 = z.infer<typeof judgeBundleSchema>;

/**
 * Only the race cohort's verified factual signature is projected. Response IDs,
 * token usage and latency exist in the receipt but are never read or rendered.
 */
const raceFactualSignatureSchema = z
  .object({
    failedClauseId: z.literal(RACE_FAILED_CLAUSE),
    identifiableActivityRequests: z.number().int().nonnegative().max(1000),
    identifiableActivityReceipts: z.number().int().nonnegative().max(1000),
    collectorBeforeHydration: z.literal(true),
    activityBeforePreferenceRead: z.literal(true),
  })
  .strict();

const liveStabilitySchema = z
  .object({
    schemaVersion: z.literal(LIVE_STABILITY_SCHEMA_VERSION),
    requestedModel: z.literal('gpt-5.6'),
    productVerdictAuthority: z.literal(
      'deterministic_typescript_and_playwright_only',
    ),
    groups: z
      .array(
        z
          .object({
            evidenceSignature: z.string().min(1),
            expectedViolationCode: z.string().min(1),
            selectedReplay: z.string().min(1),
            verifiedFactualSignature: z.unknown(),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();

export type RaceFactualSignature = z.infer<typeof raceFactualSignatureSchema>;

function parseOrFail<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new JudgeDataError(`${label} did not match its tracked contract.`);
  }
  return parsed.data;
}

function readJudgeBundle(): JudgeBundleV1 {
  return parseOrFail(
    judgeBundleSchema,
    judgeBundleJson,
    'artifacts/judge/judge-bundle.json',
  );
}

function readRaceFacts(): RaceFactualSignature {
  const receipt = parseOrFail(
    liveStabilitySchema,
    liveStabilityJson,
    'artifacts/milestone-03-live-stability.json',
  );
  const race = receipt.groups.find(
    (group) => group.evidenceSignature === RACE_EVIDENCE_SIGNATURE,
  );
  if (
    race === undefined ||
    race.expectedViolationCode !== 'PP_IDENTIFIABLE_EVENT_LEAK' ||
    race.selectedReplay !== 'inspect_startup_order'
  ) {
    throw new JudgeDataError('recorded race cohort is missing or inconsistent.');
  }
  return parseOrFail(
    raceFactualSignatureSchema,
    race.verifiedFactualSignature,
    'recorded race factual signature',
  );
}

/**
 * The judge bundle and the recorded investigation receipt must agree about the
 * selected replay and the violation before anything is rendered.
 */
function assertCrossArtifactAgreement(
  bundle: JudgeBundleV1,
  facts: RaceFactualSignature,
): void {
  if (facts.identifiableActivityRequests < 1) {
    throw new JudgeDataError(
      'recorded race signature does not record the observed identifiable activity.',
    );
  }
  if (bundle.investigation.selectedReplay !== 'inspect_startup_order') {
    throw new JudgeDataError('selected replay disagrees across artifacts.');
  }
}

export type ObserveRowState = 'off' | 'leak';

export interface ObserveRow {
  readonly label: string;
  readonly value: string;
  readonly state: ObserveRowState;
  /** The validated clause or field this row is read from. Rendered in the UI. */
  readonly source: string;
}

/**
 * OBSERVE rows.
 *
 * `identifiableActivity` is the literal validated count. The three preference
 * rows are the asserted state of the `preference_survives_reload` clause: the
 * recorded signature names `no_identifiable_activity` as the only failed
 * clause, so the preference clause held across UI, storage and backend. The
 * backing clause is rendered next to each row rather than implied.
 */
function buildObserveRows(
  bundle: JudgeBundleV1,
  facts: RaceFactualSignature,
): readonly ObserveRow[] {
  return Object.freeze([
    Object.freeze({
      label: 'Personalization',
      value: bundle.observedContradiction.scenario.toUpperCase(),
      state: 'off' as const,
      source: 'judge bundle · observedContradiction.scenario',
    }),
    Object.freeze({
      label: 'Stored preference',
      value: 'OFF',
      state: 'off' as const,
      source: `${PREFERENCE_CLAUSE} · clause passed`,
    }),
    Object.freeze({
      label: 'Authoritative backend',
      value: 'OFF',
      state: 'off' as const,
      source: `${PREFERENCE_CLAUSE} · clause passed`,
    }),
    Object.freeze({
      label: 'Identifiable activity',
      value: String(facts.identifiableActivityRequests),
      state: 'leak' as const,
      source: `${facts.failedClauseId} · clause failed`,
    }),
  ]);
}

export interface JudgeData {
  readonly bundle: JudgeBundleV1;
  readonly raceFacts: RaceFactualSignature;
  readonly observeRows: readonly ObserveRow[];
  readonly feedClause: typeof FEED_CLAUSE;
  readonly failedClause: typeof RACE_FAILED_CLAUSE;
}

/**
 * Validates every tracked input and returns the only data the judge UI may
 * render. Throws (fails closed) when any artifact drifts from its contract.
 */
export function loadJudgeData(): JudgeData {
  const bundle = readJudgeBundle();
  const raceFacts = readRaceFacts();
  assertCrossArtifactAgreement(bundle, raceFacts);
  return Object.freeze({
    bundle,
    raceFacts,
    observeRows: buildObserveRows(bundle, raceFacts),
    feedClause: FEED_CLAUSE,
    failedClause: RACE_FAILED_CLAUSE,
  });
}

export const PROVENANCE_TEXT = Object.freeze({
  recorded_authentic_gpt56: 'Recorded authentic GPT-5.6 run',
  recorded_authentic_codex: 'Recorded authentic Codex repair',
  reproducible_offline_verification: 'Reproducible offline verification',
  deterministic_verdict: 'Deterministic verdict',
} as const);

export const REPLAY_TITLES = Object.freeze({
  inspect_startup_order: 'Inspect startup order',
  inspect_preference_roundtrip: 'Inspect preference roundtrip',
} as const);

export const TIMELINE_TITLES = Object.freeze({
  collector_started: 'Collector started',
  identifiable_activity_received:
    'Identifiable activity crossed the service boundary',
  preference_hydration_completed: 'Preference hydration completed',
} as const);
