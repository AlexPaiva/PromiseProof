import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { sha256CanonicalJson } from '../../src/investigation/canonical-json.js';
import {
  CANONICAL_PROMISE_AUTHORITY,
  REPAIR_CANDIDATE_SCHEMA_VERSION,
} from '../../src/repair/contracts.js';
import {
  deriveRaceRepairCandidateV1,
  REPAIR_INELIGIBLE_CODE,
  RepairEligibilityError,
} from '../../src/repair/eligibility.js';
import {
  buildRepairPrompt,
  buildRepairPromptEnvelope,
} from '../../src/repair/prompt.js';
import { CODEX_REPAIR_PROMPT_VERSION } from '../../src/repair/provider.js';
import {
  liveStabilityReceiptV1Schema,
  raceRepairCandidateV1Schema,
} from '../../src/repair/schemas.js';

interface MutableResponse extends Record<string, unknown> {
  responseId: unknown;
  model: unknown;
  status: unknown;
}

interface MutableRun extends Record<string, unknown> {
  investigationId: unknown;
  dossierSha256: unknown;
  leadingHypothesisId: unknown;
  responses: MutableResponse[];
}

interface MutableGroup extends Record<string, unknown> {
  evidenceSignature: unknown;
  expectedViolationCode: unknown;
  selectedReplay: unknown;
  verifiedFactualSignature: Record<string, unknown>;
  dossierSha256: unknown;
  runCount: unknown;
  responseCount: unknown;
  runs: MutableRun[];
}

interface MutableReceipt extends Record<string, unknown> {
  requestedModel: unknown;
  productVerdictAuthority: unknown;
  totalRuns: unknown;
  totalResponses: unknown;
  groups: MutableGroup[];
}

const committedReceipt = JSON.parse(
  readFileSync(
    new URL('../../artifacts/milestone-03-live-stability.json', import.meta.url),
    'utf8',
  ),
) as unknown;

function cloneReceipt(): MutableReceipt {
  return structuredClone(committedReceipt) as MutableReceipt;
}

function assertIneligible(receipt: unknown): void {
  assert.throws(
    () => deriveRaceRepairCandidateV1(receipt),
    (error: unknown) =>
      error instanceof RepairEligibilityError &&
      error.code === REPAIR_INELIGIBLE_CODE &&
      error.message.startsWith(`${REPAIR_INELIGIBLE_CODE}:`),
  );
}

function assertRecursivelyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertRecursivelyFrozen(child);
  }
}

function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeys(child)]);
}

test('derives a frozen sanitized startup-order repair candidate from the committed receipt', () => {
  const parsedReceipt = liveStabilityReceiptV1Schema.parse(committedReceipt);
  const candidate = deriveRaceRepairCandidateV1(committedReceipt);

  assert.equal(candidate.schemaVersion, REPAIR_CANDIDATE_SCHEMA_VERSION);
  assert.equal(candidate.candidateKind, 'startup_order_repair');
  assert.equal(candidate.promiseAuthority, CANONICAL_PROMISE_AUTHORITY);
  assert.equal(
    candidate.source.canonicalReceiptSha256,
    sha256CanonicalJson(parsedReceipt),
  );
  assert.equal(candidate.evidence.runCount, 3);
  assert.equal(candidate.evidence.responseCount, 6);
  assert.equal(candidate.evidence.violationCode, 'PP_IDENTIFIABLE_EVENT_LEAK');
  assert.equal(candidate.evidence.selectedReplay, 'inspect_startup_order');
  assert.deepEqual(candidate.evidence.facts, {
    failedClauseId: 'no_identifiable_activity',
    identifiableActivityRequests: 1,
    identifiableActivityReceipts: 1,
    collectorBeforeHydration: true,
    activityBeforePreferenceRead: true,
  });
  assert.equal(candidate.evidence.canonicalArtifactSha256s.length, 3);
  assert.equal(candidate.evidence.leadingHypothesisIds.length, 3);
  assert.equal(candidate.evidence.returnedModels.length, 6);
  assert.equal(candidate.deterministicChecks.modelVerdictUsed, false);
  assert.equal(raceRepairCandidateV1Schema.safeParse(candidate).success, true);
  assertRecursivelyFrozen(candidate);

  const serialized = JSON.stringify(candidate);
  assert.doesNotMatch(serialized, /initialization-race|propagation-failure|DEMO_MODE/);
  assert.equal(
    objectKeys(candidate).some((key) => key.toLowerCase().includes('title')),
    false,
  );
  assert.throws(() => {
    Object.defineProperty(candidate.evidence.canonicalArtifactSha256s, '3', {
      value: 'a'.repeat(64),
    });
  }, TypeError);
});

test('binds the v2 repair prompt to exact existing and absent path facts', () => {
  const candidate = deriveRaceRepairCandidateV1(committedReceipt);
  const repairId = '2d696ef3-0352-407f-a543-ee4d92711a31';
  const envelope = buildRepairPromptEnvelope(candidate, repairId);
  const built = buildRepairPrompt(candidate, repairId);

  assert.equal(
    CODEX_REPAIR_PROMPT_VERSION,
    'promiseproof.codex-repair-prompt.v2',
  );
  assert.equal(envelope.version, CODEX_REPAIR_PROMPT_VERSION);
  assert.deepEqual(envelope.pathFacts, [
    { path: 'src/client/main.ts', state: 'existing_file' },
    { path: 'tests/support/scenario.ts', state: 'existing_file' },
    { path: 'tests/regression', state: 'absent' },
    {
      path: 'tests/regression/initialization-order.spec.ts',
      state: 'absent',
    },
  ]);
  assert.equal(
    built.promptEnvelopeSha256,
    sha256CanonicalJson(envelope),
  );
  assert.match(built.prompt, /absent by design/u);
  assert.match(built.prompt, /Test-Path -LiteralPath/u);
  assert.match(built.prompt, /Do not run Git commands, tests, builds/u);
  assert.match(built.prompt, /normal no-match, missing-path, or changed result/u);
  assert.doesNotMatch(built.prompt, /npm\.cmd|npx\.cmd/u);
  assertRecursivelyFrozen(envelope);
});

test('candidate schema rejects extra output fields', () => {
  const candidate = structuredClone(
    deriveRaceRepairCandidateV1(committedReceipt),
  ) as unknown as Record<string, unknown>;
  candidate.verdict = 'passed';
  assert.equal(raceRepairCandidateV1Schema.safeParse(candidate).success, false);
});

test('rejects noncanonical promise authority and requested model', () => {
  const wrongAuthority = cloneReceipt();
  wrongAuthority.productVerdictAuthority = 'model_decides';
  assertIneligible(wrongAuthority);

  const wrongModel = cloneReceipt();
  wrongModel.requestedModel = 'gpt-5.6-sol';
  assertIneligible(wrongModel);
});

test('rejects a propagation cohort as the race repair source', () => {
  const swapped = cloneReceipt();
  swapped.groups = [
    structuredClone(swapped.groups[1]!),
    structuredClone(swapped.groups[0]!),
  ];
  assertIneligible(swapped);

  const duplicatedPropagation = cloneReceipt();
  duplicatedPropagation.groups[0] = structuredClone(
    duplicatedPropagation.groups[1]!,
  );
  assertIneligible(duplicatedPropagation);
});

test('rejects wrong or broadened violation and replay evidence', () => {
  const wrongViolation = cloneReceipt();
  wrongViolation.groups[0]!.expectedViolationCode =
    'PP_PREFERENCE_NOT_PERSISTED';
  assertIneligible(wrongViolation);

  const wrongReplay = cloneReceipt();
  wrongReplay.groups[0]!.selectedReplay = 'inspect_preference_roundtrip';
  assertIneligible(wrongReplay);

  const broadened = cloneReceipt();
  broadened.groups[0]!.violationCodes = [
    'PP_IDENTIFIABLE_EVENT_LEAK',
    'PP_PREFERENCE_NOT_PERSISTED',
  ];
  assertIneligible(broadened);
});

test('rejects incomplete or altered startup-order facts', () => {
  const factMutations: Array<(receipt: MutableReceipt) => void> = [
    (receipt) => {
      receipt.groups[0]!.verifiedFactualSignature.collectorBeforeHydration = false;
    },
    (receipt) => {
      receipt.groups[0]!.verifiedFactualSignature.activityBeforePreferenceRead =
        false;
    },
    (receipt) => {
      receipt.groups[0]!.verifiedFactualSignature.identifiableActivityRequests = 0;
    },
    (receipt) => {
      receipt.groups[0]!.verifiedFactualSignature.identifiableActivityReceipts = 2;
    },
  ];

  for (const mutate of factMutations) {
    const receipt = cloneReceipt();
    mutate(receipt);
    assertIneligible(receipt);
  }
});

test('rejects missing runs, responses, and count mismatches', () => {
  const missingRun = cloneReceipt();
  missingRun.groups[0]!.runs.pop();
  assertIneligible(missingRun);

  const missingResponse = cloneReceipt();
  missingResponse.groups[0]!.runs[0]!.responses.pop();
  assertIneligible(missingResponse);

  const wrongCounts = cloneReceipt();
  wrongCounts.groups[0]!.runCount = 2;
  wrongCounts.groups[0]!.responseCount = 5;
  wrongCounts.totalRuns = 5;
  wrongCounts.totalResponses = 11;
  assertIneligible(wrongCounts);
});

test('rejects unstable dossier hashes', () => {
  const receipt = cloneReceipt();
  receipt.groups[0]!.runs[1]!.dossierSha256 = 'f'.repeat(64);
  assertIneligible(receipt);
});

test('rejects duplicate investigation, response, and artifact identities', () => {
  const duplicateInvestigation = cloneReceipt();
  duplicateInvestigation.groups[0]!.runs[1]!.investigationId =
    duplicateInvestigation.groups[0]!.runs[0]!.investigationId;
  assertIneligible(duplicateInvestigation);

  const duplicateResponse = cloneReceipt();
  duplicateResponse.groups[0]!.runs[1]!.responses[0]!.responseId =
    duplicateResponse.groups[0]!.runs[0]!.responses[0]!.responseId;
  assertIneligible(duplicateResponse);

  const duplicateAcrossCohorts = cloneReceipt();
  duplicateAcrossCohorts.groups[1]!.runs[0]!.responses[0]!.responseId =
    duplicateAcrossCohorts.groups[0]!.runs[0]!.responses[0]!.responseId;
  assertIneligible(duplicateAcrossCohorts);

  const duplicateArtifact = cloneReceipt();
  duplicateArtifact.groups[0]!.runs[1]!.canonicalArtifactSha256 =
    duplicateArtifact.groups[0]!.runs[0]!.canonicalArtifactSha256;
  assertIneligible(duplicateArtifact);
});

test('rejects incomplete responses, unallowlisted models, and absent leading IDs', () => {
  const incomplete = cloneReceipt();
  incomplete.groups[0]!.runs[0]!.responses[0]!.status = 'incomplete';
  assertIneligible(incomplete);

  const wrongReturnedModel = cloneReceipt();
  wrongReturnedModel.groups[0]!.runs[0]!.responses[0]!.model = 'gpt-5.5';
  assertIneligible(wrongReturnedModel);

  const missingLeadingId = cloneReceipt();
  missingLeadingId.groups[0]!.runs[0]!.leadingHypothesisId = '';
  assertIneligible(missingLeadingId);
});

test('rejects malformed response item shapes and inconsistent aggregates', () => {
  const secondTool = cloneReceipt();
  const firstSelection = secondTool.groups[0]!.runs[0]!.responses[0]!;
  const outputItems = firstSelection.outputItems as unknown[];
  outputItems.push({
    type: 'function_call',
    status: 'completed',
    contentTypes: [],
  });
  assertIneligible(secondTool);

  const wrongUsage = cloneReceipt();
  const aggregateUsage = wrongUsage.groups[0]!.aggregateUsage as Record<
    string,
    unknown
  >;
  aggregateUsage.totalTokens = Number(aggregateUsage.totalTokens) + 1;
  assertIneligible(wrongUsage);

  const wrongLatency = cloneReceipt();
  wrongLatency.aggregateLatencyMs = Number(wrongLatency.aggregateLatencyMs) + 1;
  assertIneligible(wrongLatency);
});

test('rejects extra fields, fixture labels, demo-mode labels, and title injection', () => {
  const topExtra = cloneReceipt();
  topExtra.extra = true;
  assertIneligible(topExtra);

  const nestedExtra = cloneReceipt();
  nestedExtra.groups[0]!.runs[0]!.responses[0]!.unexpected = 'value';
  assertIneligible(nestedExtra);

  const fixtureLabel = cloneReceipt();
  fixtureLabel.fixture = 'initialization-race';
  assertIneligible(fixtureLabel);

  const demoMode = cloneReceipt();
  demoMode.DEMO_MODE = 'initialization-race';
  assertIneligible(demoMode);

  const titleAuthority = cloneReceipt();
  titleAuthority.groups[0]!.hypothesisTitle = 'Initialization race';
  assertIneligible(titleAuthority);
});
