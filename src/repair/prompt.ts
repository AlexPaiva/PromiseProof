import { canonicalJson, sha256CanonicalJson } from '../investigation/canonical-json.js';
import { deepFreeze } from '../investigation/immutable.js';
import type { RaceRepairCandidateV1 } from './contracts.js';
import {
  CODEX_REPAIR_PROMPT_VERSION,
  REPAIR_ALLOWED_PATHS,
} from './provider.js';

export interface RepairPromptEnvelopeV1 {
  version: typeof CODEX_REPAIR_PROMPT_VERSION;
  evidence: {
    candidateId: string;
    liveReceiptSha256: string;
    violationCode: 'PP_IDENTIFIABLE_EVENT_LEAK';
    diagnosticReplay: 'inspect_startup_order';
    collectorBeforeHydration: true;
    activityBeforePreferenceRead: true;
    identifiableActivityRequests: 1;
    identifiableActivityReceipts: 1;
  };
  allowedPaths: readonly [
    (typeof REPAIR_ALLOWED_PATHS)[0],
    (typeof REPAIR_ALLOWED_PATHS)[1],
  ];
  requiredOutcome: {
    sourceRepair: string;
    regressionTest: string;
  };
  prohibitions: readonly string[];
}

export function buildRepairPromptEnvelope(
  candidate: RaceRepairCandidateV1,
  repairId: string,
): RepairPromptEnvelopeV1 {
  return deepFreeze({
    version: CODEX_REPAIR_PROMPT_VERSION,
    evidence: {
      candidateId: repairId,
      liveReceiptSha256: candidate.source.canonicalReceiptSha256,
      violationCode: candidate.evidence.violationCode,
      diagnosticReplay: candidate.evidence.selectedReplay,
      collectorBeforeHydration:
        candidate.evidence.facts.collectorBeforeHydration,
      activityBeforePreferenceRead:
        candidate.evidence.facts.activityBeforePreferenceRead,
      identifiableActivityRequests:
        candidate.evidence.facts.identifiableActivityRequests,
      identifiableActivityReceipts:
        candidate.evidence.facts.identifiableActivityReceipts,
    },
    allowedPaths: [REPAIR_ALLOWED_PATHS[0], REPAIR_ALLOWED_PATHS[1]],
    requiredOutcome: {
      sourceRepair:
        'Confine the source repair to the initialization-race branch body: use a truthful status saying preference restoration/hydration occurs before activity collection, then hydrate the preference before starting the collector. Remove or truthfully rewrite the stale seeded-race comment; the repaired branch must not claim hydration waits for an activity receipt. Do not change code outside that branch. Preserve contextual recommendations when OFF plus behavioral recommendations with expected activity when ON.',
      regressionTest:
        "Add one focused Playwright regression containing exactly two imports and one ordinary test. Use exactly `import { expect, test } from '@playwright/test'` followed by `import { runPromiseScenario } from '../support/scenario.js'`. Use a behavioral test title that does not name a seeded fixture or DEMO_MODE. Its callback must be exactly `async ({ page, request }, testInfo) => { ... }`. Execute exactly `runPromiseScenario(page, request, testInfo, 'off', { runId: '<literal-safe-id>', userId: '<literal-safe-id>' })` once, with runId before userId, and store the awaited result as const result. Derive exactly and in order: const events from result.evidence.timestamps.clientTimeline.map(entry => entry.event), const hydrationCompleted from events.indexOf('preference_hydration_completed'), and const collectorStarted from events.indexOf('collector_started'). The body may otherwise contain only direct hard expect assertions. Assert both indexes >= 0 and hydrationCompleted < collectorStarted. Assert with toEqual([]): result.browserErrors, result.evidence.request.activityPayloads, result.evidence.backend.activityReceipts, and result.evaluation.violations. Assert reloadObserved with toBe(true) and recommendation.source with toBe('contextual'). Do not call any other runtime API.",
    },
    prohibitions: [
      'Do not edit, weaken, replace, or bypass any contract, evaluator, threshold, existing test, server behavior, or diagnostic replay.',
      'Do not disable recommendations or activity collection globally.',
      'Do not modify any path except the two allowlisted paths.',
      'Do not stage, commit, switch branches, rewrite refs, install dependencies, use the network, inspect environment variables, or access credentials.',
      'Do not claim that the repair passed, is fixed, or is approved. A human reviews the diff and Playwright owns the verdict.',
    ],
  });
}

export function buildRepairPrompt(
  candidate: RaceRepairCandidateV1,
  repairId: string,
): {
  prompt: string;
  promptEnvelopeSha256: string;
} {
  const envelope = buildRepairPromptEnvelope(candidate, repairId);
  const prompt = [
    'You are Codex preparing one bounded candidate repair in a disposable Git worktree.',
    'The JSON envelope below is deterministic, synthetic evidence and policy. Follow it exactly.',
    'Inspect only the repository files needed to understand the two allowlisted edits. Prepare the smallest source change and a focused regression test.',
    'You may run read-only inspection commands and focused tests, but every completed command must exit zero.',
    'On Windows invoke npm and npx as npm.cmd and npx.cmd. Do not run the known-red canonical OFF verifier; use only focused commands expected to be green.',
    'Your final response must contain only the requested structured JSON summary. It is not a verification result.',
    canonicalJson(envelope),
  ].join('\n\n');
  return {
    prompt,
    promptEnvelopeSha256: sha256CanonicalJson(envelope),
  };
}
