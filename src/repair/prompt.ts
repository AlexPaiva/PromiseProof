import { canonicalJson, sha256CanonicalJson } from '../investigation/canonical-json.js';
import { deepFreeze } from '../investigation/immutable.js';
import type { RaceRepairCandidateV1 } from './contracts.js';
import {
  CODEX_REPAIR_PROMPT_VERSION,
  REPAIR_ALLOWED_PATHS,
  REPAIR_INSPECTION_COMMANDS,
} from './provider.js';

export interface RepairPromptEnvelopeV3 {
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
  pathFacts: readonly [
    { path: 'src/client/main.ts'; state: 'existing_file' },
    { path: 'tests/support/scenario.ts'; state: 'existing_file' },
    { path: 'tests/regression'; state: 'absent' },
    {
      path: 'tests/regression/initialization-order.spec.ts';
      state: 'absent';
    },
  ];
  inspectionPolicy: {
    commands: typeof REPAIR_INSPECTION_COMMANDS;
    execution: 'each_exactly_once_in_listed_order_before_edits';
  };
  requiredOutcome: {
    sourceRepair: string;
    regressionTest: string;
  };
  prohibitions: readonly string[];
}

export function buildRepairPromptEnvelope(
  candidate: RaceRepairCandidateV1,
  repairId: string,
): RepairPromptEnvelopeV3 {
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
    pathFacts: [
      { path: 'src/client/main.ts', state: 'existing_file' },
      { path: 'tests/support/scenario.ts', state: 'existing_file' },
      { path: 'tests/regression', state: 'absent' },
      {
        path: 'tests/regression/initialization-order.spec.ts',
        state: 'absent',
      },
    ],
    inspectionPolicy: {
      commands: REPAIR_INSPECTION_COMMANDS,
      execution: 'each_exactly_once_in_listed_order_before_edits',
    },
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
      'Do not run any shell command except the two exact inspectionPolicy commands. Run each exactly once, in listed order, before editing.',
      'Do not use Test-Path, conditionals, loops, pipelines, command chaining, path listing, repository search, diff commands, or inspect a path marked absent.',
      'Do not run any Git command, test, build, package-manager command, Playwright command, or compiler command.',
      'Do not call update_plan or create a todo list.',
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
    'Run exactly the two inspectionPolicy commands, each once and in listed order, before editing. They are complete commands: copy them byte-for-byte without wrappers, guards, pipes, chaining, or extra flags.',
    'The pathFacts are authoritative for this frozen base. The regression path and its parent directory are absent by design; never probe, read, list, or search either path. The apply_patch tool can create the missing parent and file without a shell preflight.',
    'After the two reads, prepare the smallest source change and focused regression test using apply_patch. Do not call update_plan or create a todo list. Run no other command: PromiseProof owns Git, tests, builds, package managers, Playwright, compilers, and verification.',
    'Your final response must contain only the requested structured JSON summary. It is not a verification result.',
    canonicalJson(envelope),
  ].join('\n\n');
  return {
    prompt,
    promptEnvelopeSha256: sha256CanonicalJson(envelope),
  };
}
