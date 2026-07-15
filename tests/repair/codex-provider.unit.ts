import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import type { ThreadEvent } from '@openai/codex-sdk';

import { validateCodexEventSequence } from '../../src/repair/codex-provider.js';
import {
  CODEX_REPAIR_SUMMARY_VERSION,
  REPAIR_CONSTRAINT_CODES,
  RepairProviderError,
} from '../../src/repair/provider.js';

const worktreePath = path.resolve('C:/promiseproof-test-worktree');
const threadId = '019f65f2-1111-7222-8333-123456789abc';

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
        id: 'command-1',
        type: 'command_execution',
        command: 'npm test -- --focused',
        aggregated_output: 'ok',
        exit_code: 0,
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
  });
}

function assertRejected(events: ThreadEvent[], code: string): void {
  assert.throws(
    () => accept(events),
    (error: unknown) =>
      error instanceof RepairProviderError && error.details.code === code,
  );
}

test('accepts and freezes one bounded schema-valid Codex turn', () => {
  const result = accept();
  assert.equal(result.threadId, threadId);
  assert.deepEqual(result.events.observedFilePaths, [
    'src/client/main.ts',
    'tests/regression/initialization-order.spec.ts',
  ]);
  assert.equal(result.events.completedCommandCount, 1);
  assert.equal(result.events.completedFileChangeCount, 1);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.summary), true);
});

test('rejects error, failed-turn, MCP, web-search, and error items', () => {
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
      item: { id: 'future-1', type: 'future_tool', status: 'in_progress' },
    } as unknown as ThreadEvent,
  ] as ThreadEvent[]) {
    assertRejected(
      [validEvents()[0]!, validEvents()[1]!, forbidden],
      forbidden.type === 'error' || forbidden.type === 'turn.failed'
        ? 'PP_REPAIR_CODEX_TURN_FAILED'
        : 'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
    );
  }
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

test('rejects file events outside the exact two-path allowlist', () => {
  const events = validEvents();
  events[2] = {
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
  forbidden[2] = {
    type: 'item.completed',
    item: {
      id: 'file-forbidden',
      type: 'file_change',
      changes: [{ path: 'src/shared/evaluator.ts', kind: 'update' }],
      status: 'completed',
    },
  };
  assertRejected(forbidden, 'PP_REPAIR_CODEX_PATH_FORBIDDEN');
});

test('rejects protected values anywhere in transient event data', () => {
  const secret = 'sk-proj-this-value-must-never-survive';
  const events = validEvents();
  events[3] = {
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
  assert.throws(
    () => accept(events, [secret]),
    (error: unknown) =>
      error instanceof RepairProviderError &&
      error.details.code === 'PP_REPAIR_CODEX_SECRET_OBSERVED',
  );
});

test('rejects failed commands and invalid or authoritative final output', () => {
  const failedCommand = validEvents();
  failedCommand[3] = {
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
  assertRejected(failedCommand, 'PP_REPAIR_CODEX_COMMAND_FAILED');

  const verdictOutput = validEvents();
  verdictOutput[4] = {
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

test('rejects multiple threads, turns, final messages, and invalid usage', () => {
  const multipleThreads = validEvents();
  multipleThreads.splice(1, 0, {
    type: 'thread.started',
    thread_id: '019f65f2-aaaa-7bbb-8ccc-123456789abc',
  });
  assertRejected(multipleThreads, 'PP_REPAIR_CODEX_CARDINALITY_INVALID');

  const multipleMessages = validEvents();
  multipleMessages.splice(5, 0, {
    type: 'item.completed',
    item: { id: 'message-2', type: 'agent_message', text: finalResponse() },
  });
  assertRejected(multipleMessages, 'PP_REPAIR_CODEX_CARDINALITY_INVALID');

  const invalidUsage = validEvents();
  invalidUsage[5] = {
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
      type: 'item.updated',
      item: { id: `reason-${index}`, type: 'reasoning', text: 'bounded' },
    });
  }
  assertRejected(events, 'PP_REPAIR_CODEX_EVENT_BOUND_EXCEEDED');
});
