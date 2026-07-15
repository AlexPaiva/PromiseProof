import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  CODEX_REPAIR_LOGIN_SHELL_ALLOWED,
  CODEX_REPAIR_MODEL,
  CODEX_REPAIR_SDK_VERSION,
  CODEX_REPAIR_WINDOWS_SANDBOX,
  REPAIR_COMMAND_CLASSES,
  REPAIR_AGENT_OUTPUT_SCHEMA,
  REPAIR_ALLOWED_PATHS,
  REPAIR_INSPECTION_COMMANDS,
  RepairProviderError,
  repairAgentSummarySchema,
  type RepairProvider,
  type SafeRepairCommandFailureDiagnostic,
  type RepairProviderEventSummary,
  type RepairProviderInput,
  type RepairProviderResult,
} from './provider.js';
import {
  provisionElevatedWindowsSandbox,
  verifyElevatedWindowsSandbox,
  WindowsSandboxBoundaryError,
} from './windows-sandbox.js';

const MAX_EVENTS = 2_000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const THREAD_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const ALLOWED_ITEM_TYPES = new Set([
  'agent_message',
  'command_execution',
  'file_change',
  'reasoning',
]);
const FORBIDDEN_ITEM_TYPES = new Set([
  'error',
  'mcp_tool_call',
  'web_search',
]);

interface MutableEventState {
  streamPhase: 'expect_thread' | 'expect_turn' | 'active' | 'completed';
  eventCount: number;
  serializedBytesObserved: number;
  eventTypeCounts: Record<string, number>;
  completedItemTypeCounts: Record<string, number>;
  completedCommandCount: number;
  completedFileChangeCount: number;
  inspectionCommands: Array<(typeof REPAIR_INSPECTION_COMMANDS)[number]>;
  commandItems: Map<
    string,
    {
      command: (typeof REPAIR_INSPECTION_COMMANDS)[number];
      reportedCommand: string;
      inspectionIndex: number;
      completed: boolean;
    }
  >;
  activeCommandId: string | null;
  fileChangeItems: Map<
    string,
    {
      changes: ValidatedFileChange[];
      completed: boolean;
    }
  >;
  activeFileChangeId: string | null;
  observedFilePaths: Set<string>;
  sanitizedSequence: Array<Record<string, unknown>>;
  threadIds: string[];
  turnStarted: number;
  turnCompleted: number;
  usage: Usage | null;
  finalMessages: string[];
  itemTypesById: Map<string, string>;
  terminalItemIds: Set<string>;
}

interface ValidatedFileChange {
  path: (typeof REPAIR_ALLOWED_PATHS)[number];
  kind: 'add' | 'update';
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
    streamPhase: 'expect_thread',
    eventCount: 0,
    serializedBytesObserved: 0,
    eventTypeCounts: {},
    completedItemTypeCounts: {},
    completedCommandCount: 0,
    completedFileChangeCount: 0,
    inspectionCommands: [],
    commandItems: new Map(),
    activeCommandId: null,
    fileChangeItems: new Map(),
    activeFileChangeId: null,
    observedFilePaths: new Set(),
    sanitizedSequence: [],
    threadIds: [],
    turnStarted: 0,
    turnCompleted: 0,
    usage: null,
    finalMessages: [],
    itemTypesById: new Map(),
    terminalItemIds: new Set(),
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

function validatedFileChanges(
  item: Extract<ThreadItem, { type: 'file_change' }>,
  worktreePath: string,
  state: MutableEventState,
): ValidatedFileChange[] {
  if (
    item.changes.length === 0 ||
    item.changes.length > REPAIR_ALLOWED_PATHS.length
  ) {
    fail(
      'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
      'Codex emitted an empty or oversized file-change set.',
      state,
    );
  }
  const observedPaths = new Set<string>();
  return item.changes.map((change) => {
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
        'Codex reported a change outside the two-file allowlist.',
        state,
      );
    }
    if (observedPaths.has(normalized)) {
      fail(
        'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
        'Codex reported the same path more than once in one file-change event.',
        state,
      );
    }
    observedPaths.add(normalized);
    const kind: string = change.kind;
    const kindAllowed =
      (normalized === REPAIR_ALLOWED_PATHS[0] && kind === 'update') ||
      (normalized === REPAIR_ALLOWED_PATHS[1] &&
        (kind === 'add' || kind === 'update'));
    if (!kindAllowed) {
      fail(
        'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
        'Codex reported a delete, replacement, or unknown file-change kind.',
        state,
      );
    }
    return {
      path: normalized as ValidatedFileChange['path'],
      kind: kind as ValidatedFileChange['kind'],
    };
  });
}

function validateFileChangeLifecycle(
  eventType: 'item.started' | 'item.completed',
  item: Extract<ThreadItem, { type: 'file_change' }>,
  worktreePath: string,
  state: MutableEventState,
): ValidatedFileChange[] {
  if (
    state.activeCommandId !== null ||
    state.inspectionCommands.length !== REPAIR_INSPECTION_COMMANDS.length
  ) {
    fail(
      'PP_REPAIR_CODEX_INSPECTION_INCOMPLETE',
      'Codex changed files before completing both exact ordered inspections.',
      state,
    );
  }
  const expectedStatus =
    eventType === 'item.completed' ? 'completed' : 'in_progress';
  if (item.status !== expectedStatus) {
    fail(
      'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
      'Codex emitted an invalid file-change lifecycle status.',
      state,
    );
  }
  const changes = validatedFileChanges(item, worktreePath, state);
  if (eventType === 'item.started') {
    if (
      state.activeFileChangeId !== null ||
      state.fileChangeItems.has(item.id)
    ) {
      fail(
        'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
        'Codex started a parallel, repeated, or duplicate file-change item.',
        state,
      );
    }
    state.fileChangeItems.set(item.id, { changes, completed: false });
    state.activeFileChangeId = item.id;
    return changes;
  }

  const observed = state.fileChangeItems.get(item.id);
  if (
    observed === undefined ||
    observed.completed ||
    state.activeFileChangeId !== item.id ||
    JSON.stringify(observed.changes) !== JSON.stringify(changes)
  ) {
    fail(
      'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
      'Codex updated or completed a missing, changed, repeated, or out-of-order file-change item.',
      state,
    );
  }
  if (eventType === 'item.completed') {
    observed.completed = true;
    state.activeFileChangeId = null;
    state.completedFileChangeCount += 1;
    for (const change of changes) {
      state.observedFilePaths.add(change.path);
    }
  }
  return changes;
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

function trustedWindowsSystemRoot(
  sourceEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): string | null {
  const systemRoot =
    sourceEnvironment.SystemRoot ?? sourceEnvironment.SYSTEMROOT;
  if (
    typeof systemRoot !== 'string' ||
    /[\0\r\n"]/u.test(systemRoot) ||
    !path.win32.isAbsolute(systemRoot)
  ) {
    return null;
  }
  const normalizedRoot = path.win32.normalize(systemRoot);
  const parsedRoot = path.win32.parse(normalizedRoot);
  const expectedRoot = path.win32.join(parsedRoot.root, 'Windows');
  if (normalizedRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
    return null;
  }
  return normalizedRoot;
}

export function trustedWindowsPowerShellExecutable(
  sourceEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): string | null {
  const systemRoot = trustedWindowsSystemRoot(sourceEnvironment);
  if (systemRoot === null) {
    return null;
  }
  return path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function normalizeInspectionCommand(
  command: string,
  trustedPowerShellExecutable: string | null,
): (typeof REPAIR_INSPECTION_COMMANDS)[number] | null {
  if (
    trustedPowerShellExecutable === null ||
    !command.startsWith('"') ||
    !command.endsWith('"')
  ) {
    return null;
  }
  const marker = '" -NoProfile -Command "';
  const markerIndex = command.indexOf(marker, 1);
  if (markerIndex < 2) {
    return null;
  }
  const executable = command.slice(1, markerIndex);
  const pinnedReportedExecutable = trustedPowerShellExecutable.replaceAll(
    '\\',
    '\\\\',
  );
  if (
    executable.toLowerCase() !== pinnedReportedExecutable.toLowerCase()
  ) {
    return null;
  }
  const script = command.slice(markerIndex + marker.length, -1);
  return (
    REPAIR_INSPECTION_COMMANDS.find((candidate) => script === candidate) ?? null
  );
}

function commandFailureDiagnostic(
  item: Extract<ThreadItem, { type: 'command_execution' }>,
): SafeRepairCommandFailureDiagnostic {
  const runtimeStatus: string = item.status;
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
    runtimeStatus === 'declined'
      ? 'approval_policy_declined'
      : runtimeStatus !== 'completed'
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

function inspectionCommandForEvent(
  item: Extract<ThreadItem, { type: 'command_execution' }>,
  trustedPowerShellExecutable: string | null,
  state: MutableEventState,
): (typeof REPAIR_INSPECTION_COMMANDS)[number] {
  const inspectionCommand = normalizeInspectionCommand(
    item.command,
    trustedPowerShellExecutable,
  );
  const expectedCommand =
    REPAIR_INSPECTION_COMMANDS[state.inspectionCommands.length];
  if (inspectionCommand === null || inspectionCommand !== expectedCommand) {
    fail(
      'PP_REPAIR_CODEX_COMMAND_FORBIDDEN',
      'Codex emitted a command outside the exact ordered inspection allowlist.',
      state,
    );
  }
  return inspectionCommand;
}

function validateCommandStartEvent(
  item: Extract<ThreadItem, { type: 'command_execution' }>,
  trustedPowerShellExecutable: string | null,
  state: MutableEventState,
): number {
  const runtimeStatus: string = item.status;
  if (
    runtimeStatus !== 'in_progress' ||
    item.exit_code != null ||
    item.aggregated_output !== ''
  ) {
    fail(
      'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID',
      'Codex emitted an invalid in-progress command lifecycle event.',
      state,
    );
  }
  const inspectionCommand = inspectionCommandForEvent(
    item,
    trustedPowerShellExecutable,
    state,
  );
  if (state.activeCommandId !== null || state.commandItems.has(item.id)) {
    fail(
      'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID',
      'Codex started a parallel, repeated, or duplicate command item.',
      state,
    );
  }
  const inspectionIndex = state.inspectionCommands.length;
  state.commandItems.set(item.id, {
    command: inspectionCommand,
    reportedCommand: item.command,
    inspectionIndex,
    completed: false,
  });
  state.activeCommandId = item.id;
  return inspectionIndex;
}

function registerItemIdentity(item: ThreadItem, state: MutableEventState): void {
  const observedType = state.itemTypesById.get(item.id);
  if (observedType !== undefined && observedType !== item.type) {
    fail(
      'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
      'Codex reused one item identifier across different item types.',
      state,
    );
  }
  state.itemTypesById.set(item.id, item.type);
}

function validateCompletedItem(
  item: ThreadItem,
  worktreePath: string,
  trustedPowerShellExecutable: string | null,
  state: MutableEventState,
): void {
  if (FORBIDDEN_ITEM_TYPES.has(item.type) || !ALLOWED_ITEM_TYPES.has(item.type)) {
    fail(
      'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
      'Codex emitted a forbidden completed item type.',
      state,
    );
  }
  const independentlyTerminal =
    item.type === 'agent_message' || item.type === 'reasoning';
  if (independentlyTerminal && state.terminalItemIds.has(item.id)) {
    fail(
      'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
      'Codex emitted a repeated terminal item identifier.',
      state,
    );
  }
  if (independentlyTerminal) {
    state.terminalItemIds.add(item.id);
  }

  count(state.completedItemTypeCounts, item.type);
  const sanitized: Record<string, unknown> = {
    event: 'item.completed',
    itemType: item.type,
    itemIdSha256: sha256(item.id),
  };

  if (item.type === 'agent_message') {
    if (
      state.activeCommandId !== null ||
      state.activeFileChangeId !== null ||
      state.inspectionCommands.length !== REPAIR_INSPECTION_COMMANDS.length ||
      state.completedFileChangeCount === 0
    ) {
      fail(
        'PP_REPAIR_CODEX_EVENT_ORDER_INVALID',
        'Codex emitted its final message before inspection and patch completion.',
        state,
      );
    }
    state.finalMessages.push(item.text);
    sanitized.textSha256 = sha256(item.text);
    sanitized.textBytes = Buffer.byteLength(item.text, 'utf8');
  } else if (item.type === 'command_execution') {
    state.completedCommandCount += 1;
    const runtimeStatus: string = item.status;
    sanitized.status = runtimeStatus;
    sanitized.exitCode = item.exit_code ?? null;
    sanitized.commandSha256 = sha256(item.command);
    sanitized.outputBytes = Buffer.byteLength(item.aggregated_output, 'utf8');
    if (runtimeStatus !== 'completed' || item.exit_code !== 0) {
      fail(
        'PP_REPAIR_CODEX_COMMAND_FAILED',
        'Codex completed a command with a non-zero or missing success status.',
        state,
        commandFailureDiagnostic(item),
      );
    }
    const observed = state.commandItems.get(item.id);
    if (
      observed === undefined ||
      observed.completed ||
      state.activeCommandId !== item.id ||
      observed.reportedCommand !== item.command ||
      observed.inspectionIndex !== state.inspectionCommands.length
    ) {
      fail(
        'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID',
        'Codex completed a missing, changed, repeated, or out-of-order command item.',
        state,
      );
    }
    const inspectionCommand = inspectionCommandForEvent(
      item,
      trustedPowerShellExecutable,
      state,
    );
    if (observed.command !== inspectionCommand) {
      fail(
        'PP_REPAIR_CODEX_COMMAND_LIFECYCLE_INVALID',
        'Codex changed the normalized command within one command item.',
        state,
      );
    }
    observed.completed = true;
    state.activeCommandId = null;
    state.inspectionCommands.push(inspectionCommand);
    sanitized.inspectionIndex = observed.inspectionIndex;
  } else if (item.type === 'file_change') {
    const paths = validateFileChangeLifecycle(
      'item.completed',
      item,
      worktreePath,
      state,
    );
    sanitized.status = item.status;
    sanitized.changes = paths;
  } else if (item.type === 'reasoning') {
    if (item.text.trim().length === 0) {
      fail(
        'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
        'Codex emitted an impossible empty reasoning item.',
        state,
      );
    }
    sanitized.textSha256 = sha256(item.text);
    sanitized.textBytes = Buffer.byteLength(item.text, 'utf8');
  }

  state.sanitizedSequence.push(sanitized);
}

function acceptEvent(
  event: ThreadEvent,
  worktreePath: string,
  sensitiveValues: readonly string[],
  trustedPowerShellExecutable: string | null,
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
  if (
    (state.streamPhase === 'expect_thread' && event.type !== 'thread.started') ||
    (state.streamPhase === 'expect_turn' && event.type !== 'turn.started') ||
    (state.streamPhase === 'active' &&
      (event.type === 'thread.started' || event.type === 'turn.started')) ||
    state.streamPhase === 'completed'
  ) {
    fail(
      'PP_REPAIR_CODEX_EVENT_ORDER_INVALID',
      'Codex emitted an event outside the pinned thread/turn sequence.',
      state,
    );
  }
  if (
    state.streamPhase === 'active' &&
    (event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed') &&
    state.finalMessages.length > 0
  ) {
    fail(
      'PP_REPAIR_CODEX_EVENT_ORDER_INVALID',
      'Codex emitted an item after its final structured message.',
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
    state.streamPhase = 'expect_turn';
    state.sanitizedSequence.push({
      event: event.type,
      threadIdSha256: sha256(event.thread_id),
    });
    return;
  }
  if (event.type === 'turn.started') {
    state.turnStarted += 1;
    state.streamPhase = 'active';
    state.sanitizedSequence.push({ event: event.type });
    return;
  }
  if (event.type === 'turn.completed') {
    if (
      state.finalMessages.length !== 1 ||
      state.activeCommandId !== null ||
      state.activeFileChangeId !== null ||
      state.inspectionCommands.length !== REPAIR_INSPECTION_COMMANDS.length ||
      state.completedFileChangeCount === 0
    ) {
      fail(
        'PP_REPAIR_CODEX_EVENT_ORDER_INVALID',
        'Codex completed the turn before the bounded repair sequence finished.',
        state,
      );
    }
    state.turnCompleted += 1;
    state.streamPhase = 'completed';
    state.usage = event.usage;
    state.sanitizedSequence.push({ event: event.type, usage: event.usage });
    return;
  }
  if (event.type === 'item.completed') {
    registerItemIdentity(event.item, state);
    validateCompletedItem(
      event.item,
      worktreePath,
      trustedPowerShellExecutable,
      state,
    );
    return;
  }
  if (event.type === 'item.started' || event.type === 'item.updated') {
    if (
      FORBIDDEN_ITEM_TYPES.has(event.item.type) ||
      !ALLOWED_ITEM_TYPES.has(event.item.type)
    ) {
      fail(
        'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
        'Codex started or updated a non-allowlisted item type.',
        state,
      );
    }
    if (
      event.type === 'item.updated' ||
      event.item.type === 'agent_message' ||
      event.item.type === 'reasoning'
    ) {
      fail(
        'PP_REPAIR_CODEX_ITEM_FORBIDDEN',
        'Codex emitted an item lifecycle shape unavailable in the pinned runtime.',
        state,
      );
    }
    registerItemIdentity(event.item, state);
    if (event.item.type === 'command_execution') {
      const inspectionIndex = validateCommandStartEvent(
        event.item,
        trustedPowerShellExecutable,
        state,
      );
      state.sanitizedSequence.push({
        event: event.type,
        itemType: event.item.type,
        itemIdSha256: sha256(event.item.id),
        inspectionIndex,
      });
      return;
    }
    if (event.item.type === 'file_change') {
      const changes = validateFileChangeLifecycle(
        event.type,
        event.item,
        worktreePath,
        state,
      );
      state.sanitizedSequence.push({
        event: event.type,
        itemType: event.item.type,
        itemIdSha256: sha256(event.item.id),
        status: event.item.status,
        changes,
      });
      return;
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
  const systemRoot = trustedWindowsSystemRoot(sourceEnvironment);
  if (systemRoot === null) {
    throw new Error('The native Windows system root is not trusted.');
  }
  const system32 = path.win32.join(systemRoot, 'System32');
  const powerShellDirectory = path.win32.dirname(
    trustedWindowsPowerShellExecutable(sourceEnvironment) as string,
  );
  const trustedPath = [system32, powerShellDirectory].join(';');
  const trustedWindowsEnvironment = {
    PATH: trustedPath,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: path.win32.join(system32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
  const cli: Record<string, string> = {
    CODEX_HOME: codexHomePath,
    USERPROFILE: codexHomePath,
    HOME: codexHomePath,
    APPDATA: path.win32.join(codexHomePath, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(codexHomePath, 'AppData', 'Local'),
    TEMP: toolTempPath,
    TMP: toolTempPath,
    ...trustedWindowsEnvironment,
  };
  const commands: Record<string, string> = {
    TEMP: toolTempPath,
    TMP: toolTempPath,
    ...trustedWindowsEnvironment,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  };
  return { cli, commands };
}

export function codexRepairCliConfig(
  commandEnvironment: Readonly<Record<string, string>>,
) {
  return {
    allow_login_shell: CODEX_REPAIR_LOGIN_SHELL_ALLOWED,
    history: { persistence: 'none' },
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    sandbox_workspace_write: { network_access: false },
    skills: {
      bundled: { enabled: false },
      include_instructions: false,
    },
    shell_environment_policy: {
      inherit: 'none',
      ignore_default_excludes: false,
      set: { ...commandEnvironment },
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
    windows: { sandbox: CODEX_REPAIR_WINDOWS_SANDBOX },
  } as const;
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
    state.activeCommandId !== null ||
    state.commandItems.size !== REPAIR_INSPECTION_COMMANDS.length ||
    [...state.commandItems.values()].some((item) => !item.completed) ||
    state.inspectionCommands.length !== REPAIR_INSPECTION_COMMANDS.length ||
    state.inspectionCommands.some(
      (command, index) => command !== REPAIR_INSPECTION_COMMANDS[index],
    )
  ) {
    fail(
      'PP_REPAIR_CODEX_INSPECTION_INCOMPLETE',
      'Codex did not complete both exact ordered inspections.',
      state,
    );
  }
  if (
    state.fileChangeItems.size === 0 ||
    state.fileChangeItems.size !== state.completedFileChangeCount ||
    [...state.fileChangeItems.values()].some((item) => !item.completed)
  ) {
    fail(
      'PP_REPAIR_CODEX_FILE_EVENT_INVALID',
      'Codex did not complete every started file-change lifecycle.',
      state,
    );
  }
  if (
    state.streamPhase !== 'completed' ||
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
    trustedPowerShellExecutable?: string | null;
  },
): AcceptedCodexEventStream {
  const state = createEventState();
  const trustedPowerShellExecutable =
    input.trustedPowerShellExecutable === undefined
      ? trustedWindowsPowerShellExecutable()
      : input.trustedPowerShellExecutable;
  for (const event of events) {
    acceptEvent(
      event,
      input.worktreePath,
      input.sensitiveValues,
      trustedPowerShellExecutable,
      state,
    );
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
    const trustedPowerShellExecutable =
      trustedWindowsPowerShellExecutable();
    if (trustedPowerShellExecutable === null) {
      fail(
        'PP_REPAIR_CODEX_SHELL_UNTRUSTED',
        'The live repair requires the trusted native Windows PowerShell boundary.',
        state,
      );
    }
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
    let elevatedRuntime;
    try {
      elevatedRuntime = await provisionElevatedWindowsSandbox({
        codexHomePath: input.codexHomePath,
        toolTempPath: input.toolTempPath,
        worktreePath: input.worktreePath,
        trustedPowerShellExecutable,
      });
    } catch (error) {
      if (error instanceof WindowsSandboxBoundaryError) {
        fail(error.code, error.publicMessage, state);
      }
      fail(
        'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED',
        'The isolated elevated Windows sandbox runtime could not be provisioned.',
        state,
      );
    }
    const environment = controlledEnvironment(
      input.codexHomePath,
      input.toolTempPath,
    );
    try {
      await verifyElevatedWindowsSandbox({
        runtime: elevatedRuntime,
        worktreePath: input.worktreePath,
        trustedPowerShellExecutable,
        cliEnvironment: environment.cli,
      });
    } catch (error) {
      if (error instanceof WindowsSandboxBoundaryError) {
        fail(error.code, error.publicMessage, state);
      }
      fail(
        'PP_REPAIR_CODEX_SANDBOX_PREFLIGHT_FAILED',
        'The elevated Windows sandbox boundary preflight failed closed.',
        state,
      );
    }

    const codex = new Codex({
      apiKey: input.apiKey,
      env: environment.cli,
      config: codexRepairCliConfig(environment.commands),
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
        acceptEvent(
          event,
          input.worktreePath,
          input.sensitiveValues,
          trustedPowerShellExecutable,
          state,
        );
      }
    } catch (error) {
      if (error instanceof RepairProviderError) {
        controller.abort();
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
        'PP_REPAIR_CODEX_ELEVATED_SANDBOX_ACCEPTED',
        'PP_REPAIR_CODEX_NETWORK_EGRESS_BLOCKED',
        'PP_REPAIR_CODEX_SANDBOX_SECRETS_BLOCKED',
        'PP_REPAIR_CODEX_SANDBOX_CONTROL_FILES_PROTECTED',
      ],
    });
  }
}
