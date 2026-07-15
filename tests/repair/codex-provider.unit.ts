import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';

import {
  codexRepairCliConfig,
  controlledEnvironment,
  trustedWindowsPowerShellExecutable,
  validateCodexEventSequence,
} from '../../src/repair/codex-provider.js';
import {
  CODEX_REPAIR_DEVELOPER_INSTRUCTIONS,
  CODEX_REPAIR_SUMMARY_VERSION,
  CODEX_REPAIR_LOGIN_SHELL_ALLOWED,
  CODEX_REPAIR_WINDOWS_SANDBOX,
  REPAIR_AGENT_OUTPUT_SCHEMA,
  REPAIR_CONSTRAINT_CODES,
  REPAIR_INSPECTION_COMMANDS,
  RepairProviderError,
  type SafeRepairProviderFailure,
} from '../../src/repair/provider.js';

const worktreePath = path.resolve('C:/promiseproof-test-worktree');
const threadId = '019f65f2-1111-7222-8333-123456789abc';
const trustedPowerShellExecutable =
  'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const FIRST_COMMAND_STARTED_INDEX = 2;
const FIRST_COMMAND_COMPLETED_INDEX = 3;
const SECOND_COMMAND_STARTED_INDEX = 4;
const SECOND_COMMAND_COMPLETED_INDEX = 5;
const FILE_STARTED_INDEX = 6;
const FILE_COMPLETED_INDEX = 7;
const MESSAGE_COMPLETED_INDEX = 8;
const TURN_COMPLETED_INDEX = 9;

function wrappedInspection(index: 0 | 1): string {
  const reportedExecutable = trustedPowerShellExecutable.replaceAll(
    '\\',
    '\\\\',
  );
  return `"${reportedExecutable}" -NoProfile -Command "${REPAIR_INSPECTION_COMMANDS[index]}"`;
}

function inspectionEvents(index: 0 | 1): ThreadEvent[] {
  const id = `command-${index + 1}`;
  const command = wrappedInspection(index);
  return [
    ({
      type: 'item.started',
      item: {
        id,
        type: 'command_execution',
        command,
        aggregated_output: '',
        status: 'in_progress',
      },
    } as unknown as ThreadEvent),
    {
      type: 'item.completed',
      item: {
        id,
        type: 'command_execution',
        command,
        aggregated_output: `source ${index + 1}`,
        exit_code: 0,
        status: 'completed',
      },
    },
  ];
}

function finalResponse(): string {
  return JSON.stringify({
    schemaVersion: CODEX_REPAIR_SUMMARY_VERSION,
    intent: 'candidate_patch_prepared',
    changedFiles: [
      { path: 'src/client/main.ts', purpose: 'source_repair' },
      {
        path: 'tests/regression/initialization-order.spec.ts',
        purpose: 'regression_test',
      },
    ],
    constraintCodes: REPAIR_CONSTRAINT_CODES,
  });
}

function validEvents(): ThreadEvent[] {
  return [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    ...inspectionEvents(0),
    ...inspectionEvents(1),
    ({
      type: 'item.started',
      item: {
        id: 'file-1',
        type: 'file_change',
        changes: [
          { path: 'src/client/main.ts', kind: 'update' },
          {
            path: 'tests/regression/initialization-order.spec.ts',
            kind: 'add',
          },
        ],
        status: 'in_progress',
      },
    } as unknown as ThreadEvent),
    {
      type: 'item.completed',
      item: {
        id: 'file-1',
        type: 'file_change',
        changes: [
          { path: 'src/client/main.ts', kind: 'update' },
          {
            path: 'tests/regression/initialization-order.spec.ts',
            kind: 'add',
          },
        ],
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'message-1',
        type: 'agent_message',
        text: finalResponse(),
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    },
  ];
}

function accept(events = validEvents(), sensitiveValues: string[] = []) {
  return validateCodexEventSequence(events, {
    worktreePath,
    sensitiveValues,
    sdkThreadId: threadId,
    trustedPowerShellExecutable,
  });
}

function assertRejected(events: ThreadEvent[], code: string): void {
  rejectedDetails(events, code);
}

function rejectedDetails(
  events: ThreadEvent[],
  code: string,
  sensitiveValues: string[] = [],
): SafeRepairProviderFailure {
  let details: SafeRepairProviderFailure | null = null;
  assert.throws(
    () => accept(events, sensitiveValues),
    (error: unknown) => {
      if (error instanceof RepairProviderError && error.details.code === code) {
        details = error.details;
        return true;
      }
      return false;
    },
  );
  assert.notEqual(details, null);
  return details as unknown as SafeRepairProviderFailure;
}

function commandItemAt(
  events: ThreadEvent[],
  index: number,
): Extract<ThreadItem, { type: 'command_execution' }> {
  const event = events[index];
  if (
    event === undefined ||
    (event.type !== 'item.started' &&
      event.type !== 'item.updated' &&
      event.type !== 'item.completed') ||
    event.item.type !== 'command_execution'
  ) {
    throw new Error(`Expected command item at event index ${index}.`);
  }
  return event.item;
}

function replaceCommandText(
  events: ThreadEvent[],
  indexes: readonly number[],
  command: string,
): void {
  for (const index of indexes) {
    commandItemAt(events, index).command = command;
  }
}

test('accepts and freezes one bounded schema-valid Codex turn', () => {
  const result = accept();
  assert.equal(result.threadId, threadId);
  assert.deepEqual(result.events.observedFilePaths, [
    'src/client/main.ts',
    'tests/regression/initialization-order.spec.ts',
  ]);
  assert.equal(result.events.completedCommandCount, 2);
  assert.equal(result.events.completedFileChangeCount, 1);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.summary), true);

  assert.deepEqual(
    validEvents().map((event) => event.type),
    [
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'item.started',
      'item.completed',
      'item.started',
      'item.completed',
      'item.completed',
      'turn.completed',
    ],
  );
});

test('accepts only the trusted no-profile wrapper', () => {
  assert.equal(CODEX_REPAIR_LOGIN_SHELL_ALLOWED, false);
  assert.equal(CODEX_REPAIR_WINDOWS_SANDBOX, 'elevated');
  assert.equal(
    trustedWindowsPowerShellExecutable({ SystemRoot: 'C:\\WINDOWS' }),
    trustedPowerShellExecutable,
  );
  for (const untrustedRoot of [
    'Windows',
    'C:\\workspace\\Windows',
    '\\\\attacker\\Windows',
    'C:\\Windows" -Command "unsafe',
  ]) {
    assert.equal(
      trustedWindowsPowerShellExecutable({ SystemRoot: untrustedRoot }),
      null,
    );
  }

  const direct = validEvents();
  replaceCommandText(
    direct,
    [FIRST_COMMAND_STARTED_INDEX, FIRST_COMMAND_COMPLETED_INDEX],
    REPAIR_INSPECTION_COMMANDS[0],
  );
  assertRejected(direct, 'PP_REPAIR_CODEX_COMMAND_FORBIDDEN');

  const profileLoading = validEvents();
  replaceCommandText(
    profileLoading,
    [FIRST_COMMAND_STARTED_INDEX, FIRST_COMMAND_COMPLETED_INDEX],
    `"${trustedPowerShellExecutable}" -Command "${REPAIR_INSPECTION_COMMANDS[0]}"`,
  );
  assertRejected(profileLoading, 'PP_REPAIR_CODEX_COMMAND_FORBIDDEN');

  const unescapedDisplayPath = validEvents();
  replaceCommandText(
    unescapedDisplayPath,
    [FIRST_COMMAND_STARTED_INDEX, FIRST_COMMAND_COMPLETED_INDEX],
    `"${trustedPowerShellExecutable}" -NoProfile -Command "${REPAIR_INSPECTION_COMMANDS[0]}"`,
  );
  assertRejected(unescapedDisplayPath, 'PP_REPAIR_CODEX_COMMAND_FORBIDDEN');
});

test('rejects any successful command outside the exact ordered tuple', () => {
  const first = REPAIR_INSPECTION_COMMANDS[0];
  const variants = [
    `${first} `,
    first.toLowerCase(),
    "gc -Raw -LiteralPath 'src/client/main.ts'",
    'Get-Content -Raw -LiteralPath "src/client/main.ts"',
    `${first} | Out-Null`,
    `${first}; Get-Date`,
    `${first}\nGet-Date`,
    "Get-Content -Raw -LiteralPath 'src/client/main.ts','tests/support/scenario.ts'",
    "if (Test-Path -LiteralPath 'src/client/main.ts') { Get-Content -Raw -LiteralPath 'src/client/main.ts' }",
    'git status --short',
    'npm test',
    'npx playwright test',
    "rg -n 'collector' src/client/main.ts",
    REPAIR_INSPECTION_COMMANDS[1],
    `"C:\\promiseproof-test-worktree\\powershell.exe" -NoProfile -Command "${first}"`,
    `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe" -NoProfile -Command "${first}"`,
  ];

  for (const command of variants) {
    const events = validEvents();
    commandItemAt(events, FIRST_COMMAND_STARTED_INDEX).command = command;
    const details = rejectedDetails(
      events,
      'PP_REPAIR_CODEX_COMMAND_FORBIDDEN',
    );
    const serialized = JSON.stringify(details);
    assert.equal(serialized.includes(command), false);
    assert.equal(details.commandFailure, undefined);
  }

  const duplicate = validEvents();
  commandItemAt(duplicate, SECOND_COMMAND_STARTED_INDEX).command =
    wrappedInspection(0);
  assertRejected(duplicate, 'PP_REPAIR_CODEX_COMMAND_FORBIDDEN');

  const third = validEvents();
  const thirdStarted = structuredClone(inspectionEvents(0)[0]!);
  if (
    thirdStarted.type !== 'item.started' ||
    thirdStarted.item.type !== 'command_execution'
  ) {
    throw new Error('Expected a command start fixture.');
  }
  thirdStarted.item.id = 'command-3';
  third.splice(FILE_STARTED_INDEX, 0, thirdStarted);
  assertRejected(third, 'PP_REPAIR_CODEX_COMMAND_FORBIDDEN');
});

test('rejects changed, duplicate, parallel, incomplete, and skipped command lifecycles', () => {
  const impossibleUpdate = validEvents();
  const commandStart = structuredClone(
    impossibleUpdate[FIRST_COMMAND_STARTED_INDEX]!,
  );
  if (
    commandStart.type !== 'item.started' ||
    commandStart.item.type !== 'command_execution'
  ) {
    throw new Error('Expected a command start fixture.');
  }
  impossibleUpdate.splice(FIRST_COMMAND_COMPLETED_INDEX, 0, {
    type: 'item.updated',
    item: commandStart.item,
  } as unknown as ThreadEvent);
  assertRejected(impossibleUpdate, 'PP_REPAIR_CODEX_ITEM_FORBIDDEN');

  const outputDuringStart = validEvents();
  commandItemAt(outputDuringStart, FIRST_COMMAND_STARTED_INDEX).aggregated_output =
    'impossible early output';
  assertRejected(
    outputDuringStart,
    'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID',
  );

  const changed = validEvents();
  commandItemAt(changed, FIRST_COMMAND_COMPLETED_INDEX).command =
    REPAIR_INSPECTION_COMMANDS[0];
  assertRejected(changed, 'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID');

  const duplicateCompletion = validEvents();
  duplicateCompletion.splice(
    SECOND_COMMAND_STARTED_INDEX,
    0,
    structuredClone(duplicateCompletion[FIRST_COMMAND_COMPLETED_INDEX]!),
  );
  assertRejected(
    duplicateCompletion,
    'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID',
  );

  const missingStart = validEvents();
  missingStart.splice(2, 1);
  assertRejected(missingStart, 'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID');

  const parallel = validEvents();
  const parallelStart = structuredClone(parallel[FIRST_COMMAND_STARTED_INDEX]!);
  if (
    parallelStart.type !== 'item.started' ||
    parallelStart.item.type !== 'command_execution'
  ) {
    throw new Error('Expected a command start fixture.');
  }
  parallelStart.item.id = 'command-parallel';
  parallel.splice(FIRST_COMMAND_COMPLETED_INDEX, 0, parallelStart);
  assertRejected(parallel, 'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID');

  const incomplete = validEvents().slice(0, 3);
  assertRejected(incomplete, 'PP_REPAIR_CODEX_INSPECTION_INCOMPLETE');
});

test('rejects file-change lifecycle events before both inspections finish', () => {
  const events = validEvents();
  events.splice(3, 0, {
    type: 'item.started',
    item: {
      id: 'file-started-too-early',
      type: 'file_change',
      changes: [{ path: 'src/client/main.ts', kind: 'update' }],
      status: 'completed',
    },
  });
  assertRejected(events, 'PP_REPAIR_CODEX_INSPECTION_INCOMPLETE');

  const completion = validEvents();
  completion.splice(
    FIRST_COMMAND_STARTED_INDEX,
    0,
    structuredClone(completion[FILE_COMPLETED_INDEX]!),
  );
  assertRejected(completion, 'PP_REPAIR_CODEX_INSPECTION_INCOMPLETE');
});

test('validates the complete pinned file-change lifecycle and allowed kinds', () => {
  const withoutStart = validEvents();
  withoutStart.splice(FILE_STARTED_INDEX, 1);
  assertRejected(withoutStart, 'PP_REPAIR_CODEX_FILE_EVENT_INVALID');

  const withUpdate = validEvents();
  const started = structuredClone(withUpdate[FILE_STARTED_INDEX]!);
  if (started.type !== 'item.started' || started.item.type !== 'file_change') {
    throw new Error('Expected the cloned file-change start fixture.');
  }
  withUpdate.splice(FILE_COMPLETED_INDEX, 0, {
    type: 'item.updated',
    item: started.item,
  } as unknown as ThreadEvent);
  assertRejected(withUpdate, 'PP_REPAIR_CODEX_ITEM_FORBIDDEN');

  const changedDuringLifecycle = validEvents();
  const changedCompletion = changedDuringLifecycle[FILE_COMPLETED_INDEX];
  if (
    changedCompletion?.type !== 'item.completed' ||
    changedCompletion.item.type !== 'file_change'
  ) {
    throw new Error('Expected a file-change completion fixture.');
  }
  changedCompletion.item.changes.reverse();
  assertRejected(
    changedDuringLifecycle,
    'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
  );

  const parallel = validEvents();
  const parallelStart = structuredClone(parallel[FILE_STARTED_INDEX]!);
  if (
    parallelStart.type !== 'item.started' ||
    parallelStart.item.type !== 'file_change'
  ) {
    throw new Error('Expected a file-change start fixture.');
  }
  parallelStart.item.id = 'file-parallel';
  parallel.splice(FILE_COMPLETED_INDEX, 0, parallelStart);
  assertRejected(parallel, 'PP_REPAIR_CODEX_FILE_EVENT_INVALID');

  for (const invalidKind of ['delete', 'future_kind']) {
    const events = validEvents();
    for (const index of [FILE_STARTED_INDEX, FILE_COMPLETED_INDEX]) {
      const event = events[index];
      if (
        event === undefined ||
        (event.type !== 'item.started' && event.type !== 'item.completed') ||
        event.item.type !== 'file_change'
      ) {
        throw new Error('Expected a file-change lifecycle fixture.');
      }
      event.item.changes[0]!.kind = invalidKind as 'delete';
    }
    assertRejected(events, 'PP_REPAIR_CODEX_FILE_EVENT_INVALID');
  }
});

test('accepts only pinned standalone item shapes and rejects forbidden items', () => {
  for (const forbidden of [
    { type: 'error', message: 'provider warning' },
    { type: 'turn.failed', error: { message: 'failed' } },
    {
      type: 'item.started',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'unknown',
        tool: 'unknown',
        arguments: {},
        status: 'in_progress',
      },
    },
    {
      type: 'item.started',
      item: {
        id: 'web-1',
        type: 'web_search',
        query: 'network forbidden',
      },
    },
    {
      type: 'item.started',
      item: { id: 'error-1', type: 'error', message: 'unsafe' },
    },
    {
      type: 'item.updated',
      item: {
        id: 'future-1',
        type: `future_${'x'.repeat(5_000)}`,
        status: 'in_progress',
      },
    } as unknown as ThreadEvent,
    {
      type: 'item.started',
      item: { id: 'reasoning-start', type: 'reasoning', text: 'impossible' },
    } as unknown as ThreadEvent,
    {
      type: 'item.updated',
      item: { id: 'reasoning-update', type: 'reasoning', text: 'impossible' },
    } as unknown as ThreadEvent,
    {
      type: 'item.started',
      item: { id: 'todo-start', type: 'todo_list', items: [] },
    } as unknown as ThreadEvent,
    {
      type: 'item.completed',
      item: { id: 'todo-complete', type: 'todo_list', items: [] },
    } as unknown as ThreadEvent,
  ] as ThreadEvent[]) {
    const details = rejectedDetails(
      [validEvents()[0]!, validEvents()[1]!, forbidden],
      forbidden.type === 'error' || forbidden.type === 'turn.failed'
        ? 'PP_REPAIR_CODEX_TURN_FAILED'
        : 'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
    );
    assert.ok(details.message.length <= 1_000);
    assert.doesNotMatch(details.message, /future_x{10}/);
  }

  const validReasoning = validEvents();
  validReasoning.splice(MESSAGE_COMPLETED_INDEX, 0, {
    type: 'item.completed',
    item: { id: 'reasoning-1', type: 'reasoning', text: 'bounded summary' },
  });
  assert.equal(accept(validReasoning).events.completedFileChangeCount, 1);

  const emptyReasoning = validEvents();
  emptyReasoning.splice(MESSAGE_COMPLETED_INDEX, 0, {
    type: 'item.completed',
    item: { id: 'reasoning-empty', type: 'reasoning', text: '  \n ' },
  });
  assertRejected(emptyReasoning, 'PP_REPAIR_CODEX_ITEM_FORBIDDEN');

  const crossTypeId = validEvents();
  crossTypeId.splice(MESSAGE_COMPLETED_INDEX, 0, {
    type: 'item.completed',
    item: { id: 'command-1', type: 'reasoning', text: 'reused identifier' },
  });
  assertRejected(crossTypeId, 'PP_REPAIR_CODEX_ITEM_FORBIDDEN');

  const repeatedReasoning = validEvents();
  repeatedReasoning.splice(
    MESSAGE_COMPLETED_INDEX,
    0,
    {
      type: 'item.completed',
      item: { id: 'reasoning-repeat', type: 'reasoning', text: 'first' },
    },
    {
      type: 'item.completed',
      item: { id: 'reasoning-repeat', type: 'reasoning', text: 'second' },
    },
  );
  assertRejected(repeatedReasoning, 'PP_REPAIR_CODEX_ITEM_FORBIDDEN');
});

test('rejects an unknown top-level SDK event type', () => {
  assertRejected(
    [
      validEvents()[0]!,
      validEvents()[1]!,
      { type: 'future.event', payload: 'unsafe' } as unknown as ThreadEvent,
    ],
    'PP_REPAIR_CODEX_EVENT_FORBIDDEN',
  );
});

test('rejects shuffled top-level phases, early messages, and trailing items', () => {
  const turnBeforeThread = validEvents();
  [turnBeforeThread[0], turnBeforeThread[1]] = [
    turnBeforeThread[1]!,
    turnBeforeThread[0]!,
  ];
  assertRejected(turnBeforeThread, 'PP_REPAIR_CODEX_EVENT_ORDER_INVALID');

  const itemBeforeTurn = validEvents();
  [itemBeforeTurn[1], itemBeforeTurn[2]] = [
    itemBeforeTurn[2]!,
    itemBeforeTurn[1]!,
  ];
  assertRejected(itemBeforeTurn, 'PP_REPAIR_CODEX_EVENT_ORDER_INVALID');

  const messageBeforeRepair = validEvents();
  messageBeforeRepair.splice(
    2,
    0,
    structuredClone(messageBeforeRepair[MESSAGE_COMPLETED_INDEX]!),
  );
  assertRejected(messageBeforeRepair, 'PP_REPAIR_CODEX_EVENT_ORDER_INVALID');

  const completedBeforeMessage = validEvents();
  [
    completedBeforeMessage[MESSAGE_COMPLETED_INDEX],
    completedBeforeMessage[TURN_COMPLETED_INDEX],
  ] = [
    completedBeforeMessage[TURN_COMPLETED_INDEX]!,
    completedBeforeMessage[MESSAGE_COMPLETED_INDEX]!,
  ];
  assertRejected(completedBeforeMessage, 'PP_REPAIR_CODEX_EVENT_ORDER_INVALID');

  const trailingItem = validEvents();
  trailingItem.push({
    type: 'item.completed',
    item: { id: 'late-reasoning', type: 'reasoning', text: 'too late' },
  });
  assertRejected(trailingItem, 'PP_REPAIR_CODEX_EVENT_ORDER_INVALID');
});

test('rejects the incident-shaped schema-only completion before any tool event', () => {
  const details = rejectedDetails(
    [
      { type: 'thread.started', thread_id: threadId },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: finalResponse(),
        },
      },
    ],
    'PP_REPAIR_CODEX_EVENT_ORDER_INVALID',
  );

  assert.equal(details.eventCount, 3);
  assert.equal(details.commandFailure, undefined);
  assert.match(details.message, /before inspection and patch completion/u);
});

test('rejects file events outside the exact two-path allowlist', () => {
  const events = validEvents();
  events[FILE_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'file-escape',
      type: 'file_change',
      changes: [{ path: '../AGENTS.md', kind: 'update' }],
      status: 'completed',
    },
  };
  assertRejected(events, 'PP_REPAIR_CODEX_PATH_ESCAPE');

  const forbidden = validEvents();
  forbidden[FILE_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'file-forbidden',
      type: 'file_change',
      changes: [
        { path: `src/${'untrusted'.repeat(625)}.ts`, kind: 'update' },
      ],
      status: 'completed',
    },
  };
  const details = rejectedDetails(forbidden, 'PP_REPAIR_CODEX_PATH_FORBIDDEN');
  assert.ok(details.message.length <= 1_000);
  assert.doesNotMatch(details.message, /untrusteduntrusted/);
});

test('rejects protected values anywhere in transient event data', () => {
  const secret = 'sk-proj-this-value-must-never-survive';
  const events = validEvents();
  events[FIRST_COMMAND_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'command-secret',
      type: 'command_execution',
      command: 'safe-command',
      aggregated_output: secret,
      exit_code: 0,
      status: 'completed',
    },
  };
  const details = rejectedDetails(
    events,
    'PP_REPAIR_CODEX_SECRET_OBSERVED',
    [secret],
  );
  assert.equal(details.commandFailure, undefined);
});

test('rejects failed commands and invalid or authoritative final output', () => {
  const failedCommand = validEvents();
  failedCommand[FIRST_COMMAND_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'command-failed',
      type: 'command_execution',
      command: 'failing-command',
      aggregated_output: 'failed',
      exit_code: 1,
      status: 'failed',
    },
  };
  const details = rejectedDetails(
    failedCommand,
    'PP_REPAIR_CODEX_COMMAND_FAILED',
  );
  assert.deepEqual(details.commandFailure, {
    commandClass: 'other',
    exitDisposition: 'positive_nonzero',
    exitCode: 1,
    outputBytes: 6,
    reason: 'status_not_completed',
  });

  const verdictOutput = validEvents();
  verdictOutput[MESSAGE_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'message-verdict',
      type: 'agent_message',
      text: JSON.stringify({
        ...JSON.parse(finalResponse()),
        passed: true,
      }),
    },
  };
  assertRejected(verdictOutput, 'PP_REPAIR_CODEX_SUMMARY_INVALID');
});

test('projects runtime policy declines and future statuses without raw data', () => {
  const policyDecline = validEvents();
  const declined = commandItemAt(
    policyDecline,
    FIRST_COMMAND_COMPLETED_INDEX,
  );
  declined.status = 'declined' as typeof declined.status;
  declined.exit_code = -1;
  declined.aggregated_output =
    'execution blocked by the pinned command approval policy';
  const declinedDetails = rejectedDetails(
    policyDecline,
    'PP_REPAIR_CODEX_COMMAND_FAILED',
  );
  assert.deepEqual(declinedDetails.commandFailure, {
    commandClass: 'path_probe',
    exitDisposition: 'negative_nonzero',
    exitCode: -1,
    outputBytes: Buffer.byteLength(declined.aggregated_output, 'utf8'),
    reason: 'approval_policy_declined',
  });
  const serialized = JSON.stringify(declinedDetails);
  assert.equal(serialized.includes(declined.command), false);
  assert.equal(serialized.includes(declined.aggregated_output), false);
  assert.doesNotMatch(serialized, /rawStatus|aggregatedOutput/u);

  const futureStatus = validEvents();
  const future = commandItemAt(futureStatus, FIRST_COMMAND_COMPLETED_INDEX);
  future.status = 'future_status' as typeof future.status;
  future.exit_code = -1;
  future.aggregated_output = 'future provider detail';
  assert.equal(
    rejectedDetails(futureStatus, 'PP_REPAIR_CODEX_COMMAND_FAILED')
      .commandFailure?.reason,
    'status_not_completed',
  );

  const secret = 'sk-proj-declined-event-secret';
  const secretDecline = validEvents();
  const secretItem = commandItemAt(
    secretDecline,
    FIRST_COMMAND_COMPLETED_INDEX,
  );
  secretItem.status = 'declined' as typeof secretItem.status;
  secretItem.exit_code = -1;
  secretItem.aggregated_output = secret;
  const secretDetails = rejectedDetails(
    secretDecline,
    'PP_REPAIR_CODEX_SECRET_OBSERVED',
    [secret],
  );
  assert.equal(secretDetails.commandFailure, undefined);
  assert.equal(JSON.stringify(secretDetails).includes(secret), false);
});

test('projects failed Git metadata reads without retaining command or output', () => {
  const events = validEvents();
  const rawCommand = 'git status --short';
  const rawOutput = 'fatal: cannot create linked-worktree index.lock';
  events[FIRST_COMMAND_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'git-status-failed',
      type: 'command_execution',
      command: rawCommand,
      aggregated_output: rawOutput,
      exit_code: 1,
      status: 'failed',
    },
  };

  const details = rejectedDetails(events, 'PP_REPAIR_CODEX_COMMAND_FAILED');
  assert.deepEqual(details.commandFailure, {
    commandClass: 'git_metadata_read',
    exitDisposition: 'positive_nonzero',
    exitCode: 1,
    outputBytes: Buffer.byteLength(rawOutput, 'utf8'),
    reason: 'status_not_completed',
  });
  const serialized = JSON.stringify(details);
  assert.doesNotMatch(serialized, new RegExp(rawCommand, 'u'));
  assert.doesNotMatch(serialized, /index\.lock/u);
  assert.deepEqual(Object.keys(details.commandFailure ?? {}).sort(), [
    'commandClass',
    'exitCode',
    'exitDisposition',
    'outputBytes',
    'reason',
  ]);
});

test('projects missing-path and missing-exit failures into strict coarse diagnostics', () => {
  const missingPath = validEvents();
  missingPath[FIRST_COMMAND_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'missing-path',
      type: 'command_execution',
      command:
        "Get-Content -LiteralPath 'tests/regression/initialization-order.spec.ts'",
      aggregated_output: 'path does not exist',
      exit_code: 1,
      status: 'failed',
    },
  };
  assert.deepEqual(
    rejectedDetails(missingPath, 'PP_REPAIR_CODEX_COMMAND_FAILED')
      .commandFailure,
    {
      commandClass: 'path_probe',
      exitDisposition: 'positive_nonzero',
      exitCode: 1,
      outputBytes: Buffer.byteLength('path does not exist', 'utf8'),
      reason: 'status_not_completed',
    },
  );

  const completedNonzero = validEvents();
  completedNonzero[FIRST_COMMAND_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'completed-nonzero',
      type: 'command_execution',
      command: "Test-Path -LiteralPath 'optional-path'",
      aggregated_output: 'False',
      exit_code: 1,
      status: 'completed',
    },
  };
  assert.equal(
    rejectedDetails(completedNonzero, 'PP_REPAIR_CODEX_COMMAND_FAILED')
      .commandFailure?.reason,
    'exit_code_nonzero',
  );

  const missingExit = validEvents();
  missingExit[FIRST_COMMAND_COMPLETED_INDEX] = {
    type: 'item.completed',
    item: {
      id: 'missing-exit',
      type: 'command_execution',
      command: "Test-Path -LiteralPath 'optional-path'",
      aggregated_output: 'False',
      status: 'completed',
    },
  };
  assert.deepEqual(
    rejectedDetails(missingExit, 'PP_REPAIR_CODEX_COMMAND_FAILED')
      .commandFailure,
    {
      commandClass: 'path_probe',
      exitDisposition: 'missing',
      exitCode: null,
      outputBytes: 5,
      reason: 'exit_code_missing',
    },
  );
});

test('builds a minimal trusted Windows command environment without metadata redirection', () => {
  const environment = controlledEnvironment('C:/isolated-codex', 'C:/tool-temp', {
    Path: 'C:/attacker-bin',
    SystemRoot: 'C:/Windows',
    COMSPEC: 'C:/attacker-bin/cmd.exe',
    PATHEXT: '.ATTACKER',
    USERPROFILE: 'C:/real-user-profile',
    HOME: 'C:/real-home',
    APPDATA: 'C:/real-appdata',
    LOCALAPPDATA: 'C:/real-localappdata',
    GIT_DIR: 'C:/attacker/git-dir',
    GIT_WORK_TREE: 'C:/attacker/work-tree',
    GIT_INDEX_FILE: 'C:/attacker/index',
  });

  assert.equal(environment.commands.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(environment.commands.GIT_PAGER, 'cat');
  assert.equal(environment.commands.GIT_TERMINAL_PROMPT, '0');
  assert.equal('GIT_DIR' in environment.commands, false);
  assert.equal('GIT_WORK_TREE' in environment.commands, false);
  assert.equal('GIT_INDEX_FILE' in environment.commands, false);
  assert.equal('GIT_DIR' in environment.cli, false);
  assert.equal('GIT_WORK_TREE' in environment.cli, false);
  assert.equal(environment.commands.PATH?.includes('attacker-bin'), false);
  assert.equal(environment.cli.PATH?.includes('attacker-bin'), false);
  assert.equal(environment.commands.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(environment.commands.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(environment.commands.SystemRoot, 'C:\\Windows');
  assert.equal(environment.commands.WINDIR, 'C:\\Windows');
  assert.equal('Path' in environment.commands, false);
  assert.equal(environment.cli.USERPROFILE, 'C:/isolated-codex');
  assert.equal(environment.cli.HOME, 'C:/isolated-codex');
  assert.equal(environment.cli.APPDATA?.includes('real-appdata'), false);
  assert.equal(environment.cli.LOCALAPPDATA?.includes('real-localappdata'), false);

  const config = codexRepairCliConfig(environment.commands);
  assert.equal(config.allow_login_shell, false);
  assert.equal(
    config.developer_instructions,
    CODEX_REPAIR_DEVELOPER_INSTRUCTIONS,
  );
  assert.match(
    config.developer_instructions,
    /bounded code-editing task, not a summarization task/u,
  );
  assert.match(
    config.developer_instructions,
    /output schema constrains only the final handoff after completed tool work/u,
  );
  assert.match(
    config.developer_instructions,
    /do not fabricate or emit a success-shaped summary; let the turn fail closed/u,
  );
  assert.doesNotMatch(
    config.developer_instructions,
    /initialization-race|propagation-failure|DEMO_MODE|PP_IDENTIFIABLE_EVENT_LEAK/u,
  );
  assert.match(
    REPAIR_AGENT_OUTPUT_SCHEMA.description,
    /schema never authorizes a no-tool completion/u,
  );
  assert.equal(config.windows.sandbox, 'elevated');
  assert.equal(config.sandbox_workspace_write.network_access, false);
  assert.equal(config.skills.bundled.enabled, false);
  assert.equal(config.skills.include_instructions, false);
  assert.equal(config.include_apps_instructions, false);
  assert.equal(config.include_collaboration_mode_instructions, false);
  assert.equal(config.shell_environment_policy.inherit, 'none');
  assert.deepEqual(config.shell_environment_policy.set, environment.commands);
});

test('rejects multiple threads, final messages, and invalid usage', () => {
  const multipleThreads = validEvents();
  multipleThreads.splice(1, 0, {
    type: 'thread.started',
    thread_id: '019f65f2-aaaa-7bbb-8ccc-123456789abc',
  });
  assertRejected(multipleThreads, 'PP_REPAIR_CODEX_EVENT_ORDER_INVALID');

  const multipleMessages = validEvents();
  multipleMessages.splice(MESSAGE_COMPLETED_INDEX, 0, {
    type: 'item.completed',
    item: { id: 'message-2', type: 'agent_message', text: finalResponse() },
  });
  assertRejected(multipleMessages, 'PP_REPAIR_CODEX_EVENT_ORDER_INVALID');

  assert.throws(
    () =>
      validateCodexEventSequence(validEvents(), {
        worktreePath,
        sensitiveValues: [],
        sdkThreadId: '019f65f2-bbbb-7ccc-8ddd-123456789abc',
        trustedPowerShellExecutable,
      }),
    (error: unknown) =>
      error instanceof RepairProviderError &&
      error.details.code === 'PP_REPAIR_CODEX_CARDINALITY_INVALID',
  );

  const invalidUsage = validEvents();
  invalidUsage[TURN_COMPLETED_INDEX] = {
    type: 'turn.completed',
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    },
  };
  assertRejected(invalidUsage, 'PP_REPAIR_CODEX_USAGE_INVALID');
});

test('rejects an event stream that exceeds the hard event-count bound', () => {
  const events: ThreadEvent[] = [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
  ];
  for (let index = 0; index < 2_000; index += 1) {
    events.push({
      type: 'item.completed',
      item: { id: `reason-${index}`, type: 'reasoning', text: 'bounded' },
    });
  }
  assertRejected(events, 'PP_REPAIR_CODEX_EVENT_BOUND_EXCEEDED');
});
