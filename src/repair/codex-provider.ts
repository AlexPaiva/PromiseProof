import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Codex,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from '@openai/codex-sdk';

import { deepFreeze } from '../investigation/immutable.js';
import {
  CODEX_REPAIR_CLI_VERSION,
  CODEX_REPAIR_MODEL,
  CODEX_REPAIR_SDK_VERSION,
  REPAIR_COMMAND_CLASSES,
  REPAIR_AGENT_OUTPUT_SCHEMA,
  REPAIR_ALLOWED_PATHS,
  RepairProviderError,
  repairAgentSummarySchema,
  type RepairProvider,
  type SafeRepairCommandFailureDiagnostic,
  type RepairProviderEventSummary,
  type RepairProviderInput,
  type RepairProviderResult,
} from './provider.js';

const MAX_EVENTS = 2_000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const THREAD_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const ALLOWED_ITEM_TYPES = new Set([
  'agent_message',
  'command_execution',
  'file_change',
  'reasoning',
  'todo_list',
]);
const FORBIDDEN_ITEM_TYPES = new Set([
  'error',
  'mcp_tool_call',
  'web_search',
]);

interface MutableEventState {
  eventCount: number;
  serializedBytesObserved: number;
  eventTypeCounts: Record<string, number>;
  completedItemTypeCounts: Record<string, number>;
  completedCommandCount: number;
  completedFileChangeCount: number;
  observedFilePaths: Set<string>;
  sanitizedSequence: Array<Record<string, unknown>>;
  threadIds: string[];
  turnStarted: number;
  turnCompleted: number;
  usage: Usage | null;
  finalMessages: string[];
}

interface AcceptedCodexEventStream {
  threadId: string;
  summary: ReturnType<typeof repairAgentSummarySchema.parse>;
  finalResponse: string;
  usage: RepairProviderResult['usage'];
  events: RepairProviderEventSummary;
}

function createEventState(): MutableEventState {
  return {
    eventCount: 0,
    serializedBytesObserved: 0,
    eventTypeCounts: {},
    completedItemTypeCounts: {},
    completedCommandCount: 0,
    completedFileChangeCount: 0,
    observedFilePaths: new Set(),
    sanitizedSequence: [],
    threadIds: [],
    turnStarted: 0,
    turnCompleted: 0,
    usage: null,
    finalMessages: [],
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fail(
  code: string,
  message: string,
  state: MutableEventState,
  commandFailure?: SafeRepairCommandFailureDiagnostic,
): never {
  throw new RepairProviderError({
    code,
    message,
    eventCount: state.eventCount,
    serializedBytesObserved: state.serializedBytesObserved,
    ...(commandFailure === undefined ? {} : { commandFailure }),
  });
}

function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function scanSensitiveValues(
  serialized: string,
  values: readonly string[],
  state: MutableEventState,
): void {
  if (values.some((value) => value.length >= 8 && serialized.includes(value))) {
    fail(
      'PP_REPAIR_CODEX_SECRET_OBSERVED',
      'A protected runtime value appeared in the Codex event stream.',
      state,
    );
  }
}

function normalizeObservedPath(worktreePath: string, candidate: string): string {
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(worktreePath, candidate);
  const relative = path.relative(worktreePath, absolute).replaceAll('\\', '/');
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    throw new Error('File-change path escapes the candidate worktree.');
  }
  return relative;
}

function classifyCommand(
  command: string,
): (typeof REPAIR_COMMAND_CLASSES)[number] {
  if (
    /\bgit(?:\.exe)?\s+(?:(?:-c|--config-env)\s+\S+\s+)*(?:status|diff|show|log|ls-files|rev-parse)\b/iu.test(
      command,
    )
  ) {
    return 'git_metadata_read';
  }
  if (/\b(?:Test-Path|Get-ChildItem|Get-Content)\b/iu.test(command)) {
    return 'path_probe';
  }
  if (/\b(?:rg|Select-String|findstr)(?:\.exe)?\b/iu.test(command)) {
    return 'repository_search';
  }
  if (
    /\b(?:npm|npx|node|playwright|tsc|vite)(?:\.cmd|\.exe)?\b/iu.test(command)
  ) {
    return 'test_or_build';
  }
  return 'other';
}

function commandFailureDiagnostic(
  item: Extract<ThreadItem, { type: 'command_execution' }>,
): SafeRepairCommandFailureDiagnostic {
  const exitCode = Number.isSafeInteger(item.exit_code)
    ? (item.exit_code ?? null)
    : null;
  const exitDisposition =
    exitCode === null
      ? 'missing'
      : exitCode === 0
        ? 'zero'
        : exitCode > 0
          ? 'positive_nonzero'
          : 'negative_nonzero';
  const reason =
    item.status !== 'completed'
      ? 'status_not_completed'
      : exitCode === null
        ? 'exit_code_missing'
        : 'exit_code_nonzero';
  return {
    commandClass: classifyCommand(item.command),
    exitDisposition,
    exitCode,
    outputBytes: Buffer.byteLength(item.aggregated_output, 'utf8'),
    reason,
  };
}

function validateCompletedItem(
  item: ThreadItem,
  worktreePath: string,
  state: MutableEventState,
): void {
  if (FORBIDDEN_ITEM_TYPES.has(item.type) || !ALLOWED_ITEM_TYPES.has(item.type)) {
    fail(
      'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
      `Codex emitted forbidden completed item type ${item.type}.`,
      state,
    );
  }

  count(state.completedItemTypeCounts, item.type);
  const sanitized: Record<string, unknown> = {
    event: 'item.completed',
    itemType: item.type,
    itemIdSha256: sha256(item.id),
  };

  if (item.type === 'agent_message') {
    state.finalMessages.push(item.text);
    sanitized.textSha256 = sha256(item.text);
    sanitized.textBytes = Buffer.byteLength(item.text, 'utf8');
  } else if (item.type === 'command_execution') {
    state.completedCommandCount += 1;
    sanitized.status = item.status;
    sanitized.exitCode = item.exit_code ?? null;
    sanitized.commandSha256 = sha256(item.command);
    sanitized.outputBytes = Buffer.byteLength(item.aggregated_output, 'utf8');
    if (item.status !== 'completed' || item.exit_code !== 0) {
      fail(
        'PP_REPAIR_CODEX_COMMAND_FAILED',
        'Codex completed a command with a non-zero or missing success status.',
        state,
        commandFailureDiagnostic(item),
      );
    }
  } else if (item.type === 'file_change') {
    state.completedFileChangeCount += 1;
    if (item.status !== 'completed' || item.changes.length === 0) {
      fail(
        'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
        'Codex emitted an incomplete or empty file-change event.',
        state,
      );
    }
    const paths = item.changes.map((change) => {
      let normalized: string;
      try {
        normalized = normalizeObservedPath(worktreePath, change.path);
      } catch {
        fail(
          'PP_REPAIR_CODEX_PATH_ESCAPE',
          'Codex reported a file change outside the candidate worktree.',
          state,
        );
      }
      if (!REPAIR_ALLOWED_PATHS.includes(normalized as never)) {
        fail(
          'PP_REPAIR_CODEX_PATH_FORBIDDEN',
          `Codex reported a change outside the two-file allowlist: ${normalized}.`,
          state,
        );
      }
      state.observedFilePaths.add(normalized);
      return { path: normalized, kind: change.kind };
    });
    sanitized.status = item.status;
    sanitized.changes = paths;
  } else if (item.type === 'reasoning') {
    sanitized.textSha256 = sha256(item.text);
    sanitized.textBytes = Buffer.byteLength(item.text, 'utf8');
  } else if (item.type === 'todo_list') {
    sanitized.itemCount = item.items.length;
    sanitized.completedCount = item.items.filter((todo) => todo.completed).length;
  }

  state.sanitizedSequence.push(sanitized);
}

function acceptEvent(
  event: ThreadEvent,
  worktreePath: string,
  sensitiveValues: readonly string[],
  state: MutableEventState,
): void {
  const serialized = JSON.stringify(event);
  state.eventCount += 1;
  state.serializedBytesObserved += Buffer.byteLength(serialized, 'utf8');
  if (state.eventCount > MAX_EVENTS || state.serializedBytesObserved > MAX_EVENT_BYTES) {
    fail(
      'PP_REPAIR_CODEX_EVENT_BOUND_EXCEEDED',
      'Codex exceeded the event-count or serialized-byte boundary.',
      state,
    );
  }
  scanSensitiveValues(serialized, sensitiveValues, state);
  count(state.eventTypeCounts, event.type);

  if (event.type === 'error' || event.type === 'turn.failed') {
    fail(
      'PP_REPAIR_CODEX_TURN_FAILED',
      'Codex emitted an error or failed-turn event.',
      state,
    );
  }
  if (event.type === 'thread.started') {
    if (!THREAD_ID.test(event.thread_id)) {
      fail(
        'PP_REPAIR_CODEX_THREAD_ID_INVALID',
        'Codex emitted an invalid thread identifier.',
        state,
      );
    }
    state.threadIds.push(event.thread_id);
    state.sanitizedSequence.push({
      event: event.type,
      threadIdSha256: sha256(event.thread_id),
    });
    return;
  }
  if (event.type === 'turn.started') {
    state.turnStarted += 1;
    state.sanitizedSequence.push({ event: event.type });
    return;
  }
  if (event.type === 'turn.completed') {
    state.turnCompleted += 1;
    state.usage = event.usage;
    state.sanitizedSequence.push({ event: event.type, usage: event.usage });
    return;
  }
  if (event.type === 'item.completed') {
    validateCompletedItem(event.item, worktreePath, state);
    return;
  }
  if (event.type === 'item.started' || event.type === 'item.updated') {
    if (
      FORBIDDEN_ITEM_TYPES.has(event.item.type) ||
      !ALLOWED_ITEM_TYPES.has(event.item.type)
    ) {
      fail(
        'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
        `Codex started or updated non-allowlisted item type ${event.item.type}.`,
        state,
      );
    }
    state.sanitizedSequence.push({
      event: event.type,
      itemType: event.item.type,
      itemIdSha256: sha256(event.item.id),
    });
    return;
  }
  fail(
    'PP_REPAIR_CODEX_EVENT_FORBIDDEN',
    'Codex emitted a non-allowlisted top-level event type.',
    state,
  );
}

async function packageVersion(packageName: string): Promise<string> {
  const resolved = import.meta.resolve(
    packageName === '@openai/codex'
      ? '@openai/codex/package.json'
      : packageName,
  );
  let directory = path.dirname(fileURLToPath(resolved));
  for (;;) {
    const packagePath = path.join(directory, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === packageName && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // Walk to the package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate package metadata for ${packageName}.`);
    }
    directory = parent;
  }
}

export function controlledEnvironment(
  codexHomePath: string,
  toolTempPath: string,
  sourceEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): { cli: Record<string, string>; commands: Record<string, string> } {
  const cli: Record<string, string> = {
    CODEX_HOME: codexHomePath,
    TEMP: toolTempPath,
    TMP: toolTempPath,
  };
  const commands: Record<string, string> = {
    TEMP: toolTempPath,
    TMP: toolTempPath,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of [
    'Path',
    'PATH',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOME',
  ]) {
    const value = sourceEnvironment[key];
    if (value !== undefined) {
      cli[key] = value;
      if (!['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME'].includes(key)) {
        commands[key] = value;
      }
    }
  }
  return { cli, commands };
}

function finalEventSummary(state: MutableEventState): RepairProviderEventSummary {
  return {
    eventCount: state.eventCount,
    serializedBytesObserved: state.serializedBytesObserved,
    eventTypeCounts: { ...state.eventTypeCounts },
    completedItemTypeCounts: { ...state.completedItemTypeCounts },
    completedCommandCount: state.completedCommandCount,
    completedFileChangeCount: state.completedFileChangeCount,
    observedFilePaths: [...state.observedFilePaths].sort(),
    sanitizedSequenceSha256: sha256(JSON.stringify(state.sanitizedSequence)),
  };
}

function usage(value: Usage | null, state: MutableEventState) {
  if (
    value === null ||
    !Number.isInteger(value.input_tokens) ||
    !Number.isInteger(value.cached_input_tokens) ||
    !Number.isInteger(value.output_tokens) ||
    !Number.isInteger(value.reasoning_output_tokens) ||
    value.input_tokens <= 0 ||
    value.cached_input_tokens < 0 ||
    value.output_tokens <= 0 ||
    value.reasoning_output_tokens < 0 ||
    value.cached_input_tokens > value.input_tokens ||
    value.reasoning_output_tokens > value.output_tokens
  ) {
    fail(
      'PP_REPAIR_CODEX_USAGE_INVALID',
      'Codex did not emit internally valid positive token usage.',
      state,
    );
  }
  return {
    inputTokens: value.input_tokens,
    cachedInputTokens: value.cached_input_tokens,
    outputTokens: value.output_tokens,
    reasoningTokens: value.reasoning_output_tokens,
  };
}

function finalizeEventState(
  state: MutableEventState,
  sdkThreadId: string | null,
): AcceptedCodexEventStream {
  if (
    state.threadIds.length !== 1 ||
    state.turnStarted !== 1 ||
    state.turnCompleted !== 1 ||
    state.finalMessages.length !== 1 ||
    sdkThreadId !== state.threadIds[0]
  ) {
    fail(
      'PP_REPAIR_CODEX_CARDINALITY_INVALID',
      'Codex must emit exactly one thread, one turn, and one final message.',
      state,
    );
  }
  let summary;
  try {
    summary = repairAgentSummarySchema.parse(
      JSON.parse(state.finalMessages[0] ?? ''),
    );
  } catch {
    fail(
      'PP_REPAIR_CODEX_SUMMARY_INVALID',
      'Codex final output did not match the strict repair-summary schema.',
      state,
    );
  }
  return {
    threadId: state.threadIds[0] ?? '',
    summary,
    finalResponse: state.finalMessages[0] ?? '',
    usage: usage(state.usage, state),
    events: finalEventSummary(state),
  };
}

export function validateCodexEventSequence(
  events: readonly ThreadEvent[],
  input: {
    worktreePath: string;
    sensitiveValues: readonly string[];
    sdkThreadId: string | null;
  },
): AcceptedCodexEventStream {
  const state = createEventState();
  for (const event of events) {
    acceptEvent(event, input.worktreePath, input.sensitiveValues, state);
  }
  return deepFreeze(finalizeEventState(state, input.sdkThreadId));
}

export class OpenAICodexRepairProvider implements RepairProvider {
  async prepareRepair(input: RepairProviderInput): Promise<RepairProviderResult> {
    const startedAt = new Date();
    const state = createEventState();

    if (input.apiKey.length < 20) {
      fail(
        'PP_REPAIR_CODEX_KEY_MISSING',
        'A non-empty API credential is required for the isolated Codex run.',
        state,
      );
    }
    await Promise.all([
      mkdir(input.codexHomePath, { recursive: true }),
      mkdir(input.toolTempPath, { recursive: true }),
    ]);
    const environment = controlledEnvironment(
      input.codexHomePath,
      input.toolTempPath,
    );
    const [sdkVersion, cliVersion] = await Promise.all([
      packageVersion('@openai/codex-sdk'),
      packageVersion('@openai/codex'),
    ]);
    if (
      sdkVersion !== CODEX_REPAIR_SDK_VERSION ||
      cliVersion !== CODEX_REPAIR_CLI_VERSION
    ) {
      fail(
        'PP_REPAIR_CODEX_VERSION_MISMATCH',
        'The installed Codex SDK/CLI does not match the pinned repair boundary.',
        state,
      );
    }

    const codex = new Codex({
      apiKey: input.apiKey,
      env: environment.cli,
      config: {
        history: { persistence: 'none' },
        sandbox_workspace_write: { network_access: false },
        shell_environment_policy: {
          inherit: 'none',
          ignore_default_excludes: false,
          set: environment.commands,
        },
        features: {
          apps: false,
          hooks: false,
          multi_agent: false,
          goals: false,
          remote_plugin: false,
          memories: false,
          shell_snapshot: false,
        },
      },
    });
    const thread = codex.startThread({
      workingDirectory: input.worktreePath,
      model: CODEX_REPAIR_MODEL,
      modelReasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      additionalDirectories: [],
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const { events } = await thread.runStreamed(input.prompt, {
        outputSchema: REPAIR_AGENT_OUTPUT_SCHEMA,
        signal: controller.signal,
      });
      for await (const event of events) {
        acceptEvent(event, input.worktreePath, input.sensitiveValues, state);
      }
    } catch (error) {
      if (error instanceof RepairProviderError) {
        throw error;
      }
      fail(
        controller.signal.aborted
          ? 'PP_REPAIR_CODEX_TIMEOUT'
          : 'PP_REPAIR_CODEX_EXECUTION_FAILED',
        controller.signal.aborted
          ? 'The bounded Codex turn exceeded its wall-clock timeout.'
          : 'The Codex SDK turn failed before producing an accepted result.',
        state,
      );
    } finally {
      clearTimeout(timeout);
    }

    const accepted = finalizeEventState(state, thread.id);

    const completedAt = new Date();
    return deepFreeze({
      kind: 'openai-codex-sdk',
      requestedModel: CODEX_REPAIR_MODEL,
      sdkVersion,
      cliVersion,
      threadId: accepted.threadId,
      turnsUsed: 1,
      summary: accepted.summary,
      finalResponseSha256: sha256(accepted.finalResponse),
      usage: accepted.usage,
      events: accepted.events,
      timing: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        totalMs: completedAt.getTime() - startedAt.getTime(),
      },
      validationCodes: [
        'PP_REPAIR_CODEX_VERSION_ACCEPTED',
        'PP_REPAIR_CODEX_THREAD_ACCEPTED',
        'PP_REPAIR_CODEX_EVENT_STREAM_ACCEPTED',
        'PP_REPAIR_CODEX_SUMMARY_ACCEPTED',
        'PP_REPAIR_CODEX_SECRET_SCAN_ACCEPTED',
      ],
    });
  }
}
