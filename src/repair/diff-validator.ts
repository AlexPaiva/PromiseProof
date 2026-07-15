import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import ts from 'typescript';

import {
  resolveRepositoryPath,
  runGit,
  type GitStatusEntry,
} from './git.js';
import {
  inspectDisposableWorktree,
  verifyDisposableWorktree,
  type DisposableWorktree,
  type WorktreeInspection,
} from './worktree.js';

export const REPAIR_MODIFIED_SOURCE_PATH = 'src/client/main.ts' as const;
export const REPAIR_ADDED_REGRESSION_PATH =
  'tests/regression/initialization-order.spec.ts' as const;
export const MAX_REPAIR_PATCH_BYTES = 32 * 1024;
export const MAX_REPAIR_CHANGED_LINES = 160;

const EXPECTED_PATHS = Object.freeze([
  REPAIR_MODIFIED_SOURCE_PATH,
  REPAIR_ADDED_REGRESSION_PATH,
]);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// Source checkouts may use CRLF on Windows. TAB, LF, and CR are the only
// permitted controls; retained patch bytes are separately normalized to LF.
const NONPRINTING_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const BARE_CARRIAGE_RETURN = /\r(?!\n)/u;

export interface ValidatedRepairDiff {
  readonly baseHead: string;
  readonly modifiedPath: typeof REPAIR_MODIFIED_SOURCE_PATH;
  readonly addedPath: typeof REPAIR_ADDED_REGRESSION_PATH;
  readonly patch: string;
  readonly patchSha256: string;
  readonly patchBytes: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly totalChangedLines: number;
}

export class RepairDiffValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RepairDiffValidationError';
    this.code = code;
  }
}

interface RawDiffEntry {
  readonly oldMode: string;
  readonly newMode: string;
  readonly status: string;
  readonly path: string;
}

function fail(code: string, message: string): never {
  throw new RepairDiffValidationError(code, message);
}

function parseRawDiff(raw: string): readonly RawDiffEntry[] {
  if (raw.length === 0) {
    return Object.freeze([]);
  }
  if (!raw.endsWith('\0')) {
    return fail('malformed_raw_diff', 'Git raw diff is not NUL terminated.');
  }
  const records = raw.split('\0');
  records.pop();
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const metadata = records[index];
    const path = records[index + 1];
    if (metadata === undefined || path === undefined) {
      return fail('malformed_raw_diff', 'Git raw diff has an incomplete record.');
    }
    const match =
      /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])(?:[0-9]+)?$/u.exec(
        metadata,
      );
    if (match === null) {
      return fail('malformed_raw_diff', 'Git raw diff metadata is malformed.');
    }
    entries.push(
      Object.freeze({
        oldMode: match[1]!,
        newMode: match[2]!,
        status: match[3]!,
        path,
      }),
    );
  }
  return Object.freeze(entries);
}

function statusFingerprint(status: readonly GitStatusEntry[]): string {
  return JSON.stringify(
    status.map((entry) => ({
      kind: entry.kind,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
      path: entry.path,
      originalPath: entry.originalPath ?? null,
    })),
  );
}

function inspectionFingerprint(inspection: WorktreeInspection): string {
  return JSON.stringify({
    status: statusFingerprint(inspection.status),
    trackedUnstagedPatch: inspection.trackedUnstagedPatch,
    stagedPatch: inspection.stagedPatch,
    trackedUnstagedRawDiff: inspection.trackedUnstagedRawDiff,
    stagedRawDiff: inspection.stagedRawDiff,
    untrackedFiles: inspection.untrackedFiles.map((file) => ({
      path: file.path,
      sizeBytes: file.sizeBytes,
      filesystemKind: file.filesystemKind,
      patch: file.patch,
      patchOmittedReason: file.patchOmittedReason,
    })),
    combinedUnstagedPatch: inspection.combinedUnstagedPatch,
  });
}

function assertExactStatuses(inspection: WorktreeInspection): void {
  const ignored = inspection.status.filter((entry) => entry.kind === 'ignored');
  if (ignored.length > 0) {
    fail(
      'unexpected_ignored_path',
      `Repair created ignored content: ${ignored.map((entry) => entry.path).join(', ')}`,
    );
  }

  const staged = inspection.status.filter(
    (entry) =>
      entry.kind !== 'untracked' &&
      entry.kind !== 'ignored' &&
      entry.indexStatus !== ' ',
  );
  if (
    staged.length > 0 ||
    inspection.stagedPatch.length > 0 ||
    inspection.stagedRawDiff.length > 0
  ) {
    fail('staged_changes', 'Repair worktree must not contain staged changes.');
  }

  const actualPaths = inspection.status.map((entry) => entry.path);
  const unexpected = actualPaths.filter(
    (path) => !EXPECTED_PATHS.includes(path as (typeof EXPECTED_PATHS)[number]),
  );
  if (unexpected.length > 0) {
    fail(
      'unexpected_path',
      `Repair touched paths outside the allowlist: ${unexpected.join(', ')}`,
    );
  }

  for (const expected of EXPECTED_PATHS) {
    if (!actualPaths.includes(expected)) {
      fail('missing_required_change', `Repair did not change required path: ${expected}`);
    }
  }
  if (inspection.status.length !== EXPECTED_PATHS.length) {
    fail('wrong_change_count', 'Repair must contain exactly two path changes.');
  }

  const source = inspection.status.find(
    (entry) => entry.path === REPAIR_MODIFIED_SOURCE_PATH,
  );
  const regression = inspection.status.find(
    (entry) => entry.path === REPAIR_ADDED_REGRESSION_PATH,
  );
  if (
    source?.kind !== 'tracked' ||
    source.indexStatus !== ' ' ||
    source.worktreeStatus !== 'M'
  ) {
    fail(
      'wrong_source_status',
      `${REPAIR_MODIFIED_SOURCE_PATH} must be one unstaged modification.`,
    );
  }
  if (
    regression?.kind !== 'untracked' ||
    regression.indexStatus !== '?' ||
    regression.worktreeStatus !== '?'
  ) {
    fail(
      'wrong_regression_status',
      `${REPAIR_ADDED_REGRESSION_PATH} must be one new untracked file.`,
    );
  }
}

async function assertIndexShape(handle: DisposableWorktree): Promise<void> {
  const sourceStage = (
    await runGit(handle.worktreePath, [
      'ls-files',
      '--stage',
      '--',
      REPAIR_MODIFIED_SOURCE_PATH,
    ])
  ).stdout.trim();
  const sourceMatch =
    /^(100644|100755) [a-f0-9]+ 0\tsrc\/client\/main\.ts$/u.exec(sourceStage);
  if (sourceMatch === null) {
    fail(
      'invalid_source_index_entry',
      'The allowed source path must remain a normal stage-zero Git blob.',
    );
  }

  const regressionStage = (
    await runGit(handle.worktreePath, [
      'ls-files',
      '--stage',
      '--',
      REPAIR_ADDED_REGRESSION_PATH,
    ])
  ).stdout.trim();
  if (regressionStage.length > 0) {
    fail(
      'regression_already_tracked_or_staged',
      'The regression test must be a newly added, unstaged regular file.',
    );
  }
}

async function assertRegularTextFile(
  worktreePath: string,
  path: string,
  options: { readonly requireNonExecutable?: boolean } = {},
): Promise<string> {
  const absolutePath = resolveRepositoryPath(worktreePath, path);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) {
    fail('symbolic_link', `Repair path must not be a symbolic link: ${path}`);
  }
  if (!info.isFile()) {
    fail('not_regular_file', `Repair path must be a regular file: ${path}`);
  }
  if (info.nlink !== 1) {
    fail('hard_link', `Repair path must not be hard-linked: ${path}`);
  }
  if (options.requireNonExecutable === true && (info.mode & 0o111) !== 0) {
    fail('executable_regression', 'The new regression test must not be executable.');
  }

  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    fail('binary_content', `Repair path contains NUL bytes: ${path}`);
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new RepairDiffValidationError(
      'non_utf8_content',
      `Repair path is not valid UTF-8 text: ${path}`,
      { cause: error },
    );
  }
  if (BIDI_CONTROL.test(text)) {
    fail('bidi_control', `Repair path contains a bidirectional control: ${path}`);
  }
  if (NONPRINTING_CONTROL.test(text) || BARE_CARRIAGE_RETURN.test(text)) {
    fail(
      'nonprinting_control',
      `Repair path contains a terminal or nonprinting control: ${path}`,
    );
  }
  return text;
}

function addedPatchLines(patch: string): string {
  let insideHunk = false;
  const additions: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      insideHunk = false;
    } else if (line.startsWith('@@ ')) {
      insideHunk = true;
    } else if (insideHunk && line.startsWith('+') && !line.startsWith('+++')) {
      additions.push(line.slice(1));
    }
  }
  return additions.join('\n');
}

function startupRaceBody(source: string): {
  readonly prefix: string;
  readonly body: string;
  readonly suffix: string;
} {
  const branchMarker = '    if (demoMode === "initialization-race") {\n';
  const elseMarker = '    } else {';
  const branchIndex = source.indexOf(branchMarker);
  const bodyStart = branchIndex + branchMarker.length;
  const elseIndex = source.indexOf(elseMarker, bodyStart);
  if (
    branchIndex < 0 ||
    source.indexOf(branchMarker, bodyStart) >= 0 ||
    elseIndex < bodyStart ||
    source.indexOf(elseMarker, elseIndex + elseMarker.length) >= 0
  ) {
    fail(
      'source_foundation_unexpected',
      'Frozen source does not contain one bounded startup-race branch.',
    );
  }
  return {
    prefix: source.slice(0, bodyStart),
    body: source.slice(bodyStart, elseIndex),
    suffix: source.slice(elseIndex),
  };
}

function parsedStartupStatements(body: string): readonly ts.Statement[] {
  const wrapped = `async function boundedStartup(): Promise<void> {\n${body}\n}`;
  const source = ts.createSourceFile(
    'bounded-startup.ts',
    wrapped,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = source.statements[0];
  if (
    source.statements.length !== 1 ||
    declaration === undefined ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.body === undefined
  ) {
    fail('unsafe_source_repair', 'Startup repair is not a bounded function body.');
  }
  return declaration.body.statements;
}

function awaitedCallName(statement: ts.Statement): string | null {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isAwaitExpression(statement.expression) ||
    !ts.isCallExpression(statement.expression.expression) ||
    !ts.isIdentifier(statement.expression.expression.expression) ||
    statement.expression.expression.arguments.length !== 0
  ) {
    return null;
  }
  return statement.expression.expression.expression.text;
}

function isSafeStartupStatus(statement: ts.Statement): boolean {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression) ||
    !ts.isIdentifier(statement.expression.expression) ||
    statement.expression.expression.text !== 'setStatus' ||
    statement.expression.arguments.length !== 2
  ) {
    return false;
  }
  const [message, state] = statement.expression.arguments;
  return (
    message !== undefined &&
    ts.isStringLiteral(message) &&
    message.text.length <= 160 &&
    /(?:restor|hydrat|preference).*(?:before|prior).*(?:collect|activity)/iu.test(
      message.text,
    ) &&
    state !== undefined &&
    ts.isStringLiteral(state) &&
    state.text === 'working'
  );
}

function assertBoundedSourceRepair(
  baseSource: string,
  repairedSource: string,
): void {
  const normalizedBase = baseSource.replace(/\r\n/gu, '\n');
  const normalizedRepair = repairedSource.replace(/\r\n/gu, '\n');
  const base = startupRaceBody(normalizedBase);
  const repaired = startupRaceBody(normalizedRepair);
  if (base.prefix !== repaired.prefix || base.suffix !== repaired.suffix) {
    fail(
      'source_repair_outside_boundary',
      'Application repair changed code outside the startup-race branch body.',
    );
  }
  const baseStatements = parsedStartupStatements(base.body);
  const repairedStatements = parsedStartupStatements(repaired.body);
  const retainsStaleRaceExplanation =
    /seeded race|hydration cannot begin|activity receipt has already returned/iu.test(
      repaired.body,
    );
  if (
    baseStatements.length !== 3 ||
    repairedStatements.length !== 3 ||
    !isSafeStartupStatus(repairedStatements[0]!) ||
    awaitedCallName(baseStatements[1]!) !== 'runStartupCollector' ||
    awaitedCallName(baseStatements[2]!) !== 'hydratePreference' ||
    awaitedCallName(repairedStatements[1]!) !== 'hydratePreference' ||
    awaitedCallName(repairedStatements[2]!) !== 'runStartupCollector' ||
    retainsStaleRaceExplanation ||
    base.body === repaired.body
  ) {
    fail(
      'source_repair_not_bounded',
      'Application repair must use a truthful startup status and reorder only the two awaited startup operations.',
    );
  }
}

function importNames(statement: ts.ImportDeclaration): readonly string[] | null {
  const clause = statement.importClause;
  if (
    clause === undefined ||
    clause.isTypeOnly ||
    clause.name !== undefined ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings)
  ) {
    return null;
  }
  const names: string[] = [];
  for (const element of clause.namedBindings.elements) {
    if (element.isTypeOnly || element.propertyName !== undefined) {
      return null;
    }
    names.push(element.name.text);
  }
  return names;
}

function callPropertyName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text;
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text;
  }
  return null;
}

function directExpectMatcher(
  statement: ts.Statement,
): ts.CallExpression | null {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return null;
  }
  const matcher = statement.expression;
  if (!ts.isPropertyAccessExpression(matcher.expression)) {
    return null;
  }
  const expectation = matcher.expression.expression;
  if (
    !ts.isCallExpression(expectation) ||
    !ts.isIdentifier(expectation.expression) ||
    expectation.expression.text !== 'expect'
  ) {
    return null;
  }
  return matcher;
}

function assertSafeRegressionProgram(regressionText: string): void {
  const source = ts.createSourceFile(
    REPAIR_ADDED_REGRESSION_PATH,
    regressionText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    source as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0 || source.statements.length !== 3) {
    fail(
      'unsafe_regression_ast',
      'Regression must be valid TypeScript with exactly two imports and one test.',
    );
  }

  const [playwrightImport, scenarioImport, testStatement] = source.statements;
  if (
    playwrightImport === undefined ||
    scenarioImport === undefined ||
    testStatement === undefined ||
    !ts.isImportDeclaration(playwrightImport) ||
    !ts.isStringLiteral(playwrightImport.moduleSpecifier) ||
    playwrightImport.moduleSpecifier.text !== '@playwright/test' ||
    JSON.stringify(importNames(playwrightImport)) !==
      JSON.stringify(['expect', 'test']) ||
    !ts.isImportDeclaration(scenarioImport) ||
    !ts.isStringLiteral(scenarioImport.moduleSpecifier) ||
    scenarioImport.moduleSpecifier.text !== '../support/scenario.js' ||
    JSON.stringify(importNames(scenarioImport)) !==
      JSON.stringify(['runPromiseScenario']) ||
    !ts.isExpressionStatement(testStatement) ||
    !ts.isCallExpression(testStatement.expression) ||
    !ts.isIdentifier(testStatement.expression.expression) ||
    testStatement.expression.expression.text !== 'test'
  ) {
    fail(
      'unsafe_regression_import_or_shape',
      'Regression imports and top-level test shape are outside the allowlist.',
    );
  }

  const testCall = testStatement.expression;
  const [title, callback] = testCall.arguments;
  if (
    testCall.arguments.length !== 2 ||
    title === undefined ||
    !ts.isStringLiteral(title) ||
    /(?:initialization-race|propagation-failure|DEMO_MODE)/iu.test(title.text) ||
    callback === undefined ||
    !ts.isArrowFunction(callback) ||
    callback.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) !== true ||
    !ts.isBlock(callback.body) ||
    callback.parameters.length !== 2
  ) {
    fail(
      'unsafe_regression_test_shape',
      'Regression must contain one ordinary async Playwright test.',
    );
  }
  const [fixturesParameter, testInfoParameter] = callback.parameters;
  const fixtureElements =
    fixturesParameter !== undefined &&
    ts.isObjectBindingPattern(fixturesParameter.name)
      ? fixturesParameter.name.elements
      : [];
  if (
    fixturesParameter === undefined ||
    !ts.isObjectBindingPattern(fixturesParameter.name) ||
    fixturesParameter.initializer !== undefined ||
    fixturesParameter.dotDotDotToken !== undefined ||
    fixtureElements.length !== 2 ||
    fixtureElements.some(
      (entry, index) =>
        entry.propertyName !== undefined ||
        entry.initializer !== undefined ||
        entry.dotDotDotToken !== undefined ||
        !ts.isIdentifier(entry.name) ||
        entry.name.text !== ['page', 'request'][index],
    ) ||
    testInfoParameter === undefined ||
    !ts.isIdentifier(testInfoParameter.name) ||
    testInfoParameter.name.text !== 'testInfo' ||
    testInfoParameter.initializer !== undefined ||
    testInfoParameter.dotDotDotToken !== undefined
  ) {
    fail(
      'unsafe_regression_fixtures',
      'Regression may receive only page, request, and testInfo fixtures.',
    );
  }

  for (const statement of callback.body.statements) {
    if (ts.isVariableStatement(statement)) {
      if (
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
        statement.declarationList.declarations.length !== 1
      ) {
        fail('unsafe_regression_statement', 'Regression variables must be single const declarations.');
      }
    } else if (directExpectMatcher(statement) === null) {
      fail(
        'unsafe_regression_statement',
        'Regression body may contain only const evidence derivations and direct assertions.',
      );
    }
  }
  const variableDeclarations = callback.body.statements
    .filter((statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement),
    )
    .map((statement) => statement.declarationList.declarations[0]!);
  if (
    variableDeclarations.length !== 4 ||
    variableDeclarations
      .map((declaration) => declaration.name.getText(source))
      .join(',') !== 'result,events,hydrationCompleted,collectorStarted'
  ) {
    fail(
      'unsafe_regression_dataflow',
      'Regression must derive only result, events, hydrationCompleted, and collectorStarted.',
    );
  }

  const forbiddenIdentifiers = new Set([
    'process',
    'globalThis',
    'fetch',
    'eval',
    'Function',
    'require',
    'module',
    'exports',
    'Buffer',
    'WebSocket',
    'EventSource',
    'XMLHttpRequest',
    'Deno',
    'Bun',
  ]);
  const allowedCalls = new Set([
    'test',
    'runPromiseScenario',
    'expect',
    'toEqual',
    'toBe',
    'toBeLessThan',
    'toBeGreaterThan',
    'toBeLessThanOrEqual',
    'toBeGreaterThanOrEqual',
    'map',
    'find',
    'findIndex',
    'indexOf',
  ]);
  let scenarioCall: ts.CallExpression | null = null;
  const stringLiterals = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node)) {
      stringLiterals.add(node.text);
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      fail('unsafe_regression_global', `Regression references forbidden global: ${node.text}.`);
    }
    if (
      ts.isElementAccessExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isSpreadAssignment(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isThrowStatement(node)
    ) {
      fail('unsafe_regression_ast', 'Regression contains executable syntax outside the safe subset.');
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      fail('unsafe_regression_assignment', 'Regression may not assign or mutate runtime state.');
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        fail('unsafe_regression_assignment', 'Regression may not mutate runtime state.');
      }
    }
    if (ts.isArrowFunction(node) && node !== callback) {
      const parentCall = ts.isCallExpression(node.parent) ? node.parent : null;
      const parentName = parentCall === null ? null : callPropertyName(parentCall);
      if (
        parentCall === null ||
        !['map', 'find', 'findIndex'].includes(parentName ?? '') ||
        !ts.isExpression(node.body)
      ) {
        fail('unsafe_regression_callback', 'Regression helper callbacks must be expression-only evidence selectors.');
      }
    }
    if (ts.isCallExpression(node)) {
      const name = callPropertyName(node);
      if (name === null || !allowedCalls.has(name)) {
        fail('unsafe_regression_call', 'Regression calls an API outside the safe subset.');
      }
      if (name === 'runPromiseScenario') {
        if (scenarioCall !== null) {
          fail('unsafe_regression_scenario_count', 'Regression must execute exactly one browser scenario.');
        }
        scenarioCall = node;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);

  const validatedScenarioCall = scenarioCall as ts.CallExpression | null;
  if (validatedScenarioCall === null) {
    fail('regression_assertion_incomplete', 'Regression does not execute the real browser scenario.');
  }
  const scenarioArguments = validatedScenarioCall.arguments;
  const scenarioPreference = scenarioArguments[3];
  const scenarioOptions = scenarioArguments[4];
  if (
    scenarioArguments.length !== 5 ||
    scenarioArguments[0]?.getText(source) !== 'page' ||
    scenarioArguments[1]?.getText(source) !== 'request' ||
    scenarioArguments[2]?.getText(source) !== 'testInfo' ||
    scenarioPreference === undefined ||
    !ts.isStringLiteral(scenarioPreference) ||
    scenarioPreference.text !== 'off' ||
    scenarioOptions === undefined ||
    !ts.isObjectLiteralExpression(scenarioOptions) ||
    scenarioOptions.properties.length !== 2 ||
    scenarioOptions.properties.map((property) => property.name?.getText(source)).join(',') !==
      'runId,userId' ||
    scenarioOptions.properties.some(
      (property) =>
        !ts.isPropertyAssignment(property) ||
        !ts.isStringLiteral(property.initializer) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(property.initializer.text),
    )
  ) {
    fail(
      'unsafe_regression_scenario',
      'Regression must execute one deterministic OFF scenario with literal identifiers.',
    );
  }

  const [resultDeclaration, eventsDeclaration, hydrationDeclaration, collectorDeclaration] =
    variableDeclarations;
  const resultInitializer = resultDeclaration?.initializer;
  const eventsInitializer = eventsDeclaration?.initializer;
  const hydrationInitializer = hydrationDeclaration?.initializer;
  const collectorInitializer = collectorDeclaration?.initializer;
  const isTimelineMap =
    eventsInitializer !== undefined &&
    ts.isCallExpression(eventsInitializer) &&
    ts.isPropertyAccessExpression(eventsInitializer.expression) &&
    eventsInitializer.expression.name.text === 'map' &&
    eventsInitializer.expression.expression.getText(source).replace(/\s+/gu, '') ===
      'result.evidence.timestamps.clientTimeline' &&
    eventsInitializer.arguments.length === 1 &&
    ts.isArrowFunction(eventsInitializer.arguments[0]!) &&
    eventsInitializer.arguments[0]!.parameters.length === 1 &&
    eventsInitializer.arguments[0]!.parameters[0]?.name.getText(source) === 'entry' &&
    eventsInitializer.arguments[0]!.body.getText(source).replace(/\s+/gu, '') ===
      'entry.event';
  const isEventIndex = (
    initializer: ts.Expression | undefined,
    event: string,
  ): boolean =>
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    initializer.expression.name.text === 'indexOf' &&
    initializer.expression.expression.getText(source) === 'events' &&
    initializer.arguments.length === 1 &&
    ts.isStringLiteral(initializer.arguments[0]!) &&
    initializer.arguments[0]!.text === event;
  if (
    resultInitializer === undefined ||
    !ts.isAwaitExpression(resultInitializer) ||
    resultInitializer.expression !== validatedScenarioCall ||
    !isTimelineMap ||
    !isEventIndex(hydrationInitializer, 'preference_hydration_completed') ||
    !isEventIndex(collectorInitializer, 'collector_started')
  ) {
    fail(
      'unsafe_regression_dataflow',
      'Regression startup-order values must derive directly from the real scenario timeline.',
    );
  }

  const directAssertions = callback.body.statements
    .map((statement) => directExpectMatcher(statement))
    .filter((value): value is ts.CallExpression => value !== null)
    .map((value) =>
      value
        .getText(source)
        .replace(/\s+/gu, '')
        .replace(/"/gu, "'"),
    );
  const requiredAssertions = [
    'expect(result.browserErrors).toEqual([])',
    'expect(result.evidence.request.activityPayloads).toEqual([])',
    'expect(result.evidence.backend.activityReceipts).toEqual([])',
    'expect(result.evaluation.violations).toEqual([])',
    'expect(result.evidence.journey.reloadObserved).toBe(true)',
    "expect(result.evidence.recommendation.source).toBe('contextual')",
    'expect(hydrationCompleted).toBeGreaterThanOrEqual(0)',
    'expect(collectorStarted).toBeGreaterThanOrEqual(0)',
    'expect(hydrationCompleted).toBeLessThan(collectorStarted)',
  ];
  if (
    requiredAssertions.some((assertion) => !directAssertions.includes(assertion)) ||
    !stringLiterals.has('preference_hydration_completed') ||
    !stringLiterals.has('collector_started')
  ) {
    fail(
      'regression_assertion_incomplete',
      'Regression lacks direct hard assertions for the canonical OFF evidence and startup order.',
    );
  }
}

function assertSemanticRepairBoundary(
  sourcePatch: string,
  regressionText: string,
): void {
  const sourceAdditions = addedPatchLines(sourcePatch);
  if (
    /(?:https?:\/\/|wss?:\/\/|WebSocket|EventSource|sendBeacon|XMLHttpRequest|\beval\s*\(|\bnew\s+Function\b|localStorage\.clear\s*\(|sessionStorage\.clear\s*\(|<script\b)/iu.test(
      sourceAdditions,
    )
  ) {
    fail(
      'unsafe_source_addition',
      'Source repair adds a new network, dynamic-code, storage-clearing, or script surface.',
    );
  }

  if (
    /(?:from\s+['"]node:|require\s*\(|import\s*\(|https?:\/\/|wss?:\/\/|WebSocket|EventSource|sendBeacon|XMLHttpRequest|\beval\s*\(|\bnew\s+Function\b|\.route\s*\(|route\.(?:abort|fulfill|continue)\s*\(|test\.(?:only|skip|fixme|fail)\s*\(|expect\.soft\s*\(|DEMO_MODE|initialization-race|propagation-failure)/iu.test(
      regressionText,
    )
  ) {
    fail(
      'unsafe_regression_test',
      'Regression test contains a bypass, interception, fixture-label, network, or dynamic-code surface.',
    );
  }
  assertSafeRegressionProgram(regressionText);
}

function assertRawDiff(inspection: WorktreeInspection): void {
  const entries = parseRawDiff(inspection.trackedUnstagedRawDiff);
  if (entries.length !== 1) {
    fail('wrong_tracked_diff_count', 'Repair must modify exactly one tracked file.');
  }
  const entry = entries[0]!;
  if (
    entry.path !== REPAIR_MODIFIED_SOURCE_PATH ||
    entry.status !== 'M' ||
    entry.oldMode !== entry.newMode ||
    entry.oldMode === '120000' ||
    entry.oldMode === '160000'
  ) {
    fail(
      'invalid_tracked_diff',
      'Tracked repair must be a content-only modification of src/client/main.ts.',
    );
  }
}

function countChangedLines(patch: string): {
  readonly addedLines: number;
  readonly deletedLines: number;
} {
  let addedLines = 0;
  let deletedLines = 0;
  let insideHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      insideHunk = false;
      continue;
    }
    if (line.startsWith('@@ ')) {
      insideHunk = true;
      continue;
    }
    if (!insideHunk) {
      continue;
    }
    if (line.startsWith('+')) {
      addedLines += 1;
    } else if (line.startsWith('-')) {
      deletedLines += 1;
    }
  }
  return { addedLines, deletedLines };
}

function assertPatchStructure(inspection: WorktreeInspection): string {
  const untracked = inspection.untrackedFiles.find(
    (file) => file.path === REPAIR_ADDED_REGRESSION_PATH,
  );
  if (untracked === undefined) {
    return fail('missing_untracked_diff', 'Regression test diff is missing.');
  }
  if (untracked.patchOmittedReason === 'too_large') {
    return fail('patch_too_large', 'Regression test exceeds the patch inspection cap.');
  }
  if (
    untracked.filesystemKind !== 'regular_file' ||
    untracked.patch === null
  ) {
    return fail(
      'invalid_untracked_diff',
      'Regression test must produce a regular-file unified diff.',
    );
  }

  const patch = inspection.combinedUnstagedPatch.replace(/\r\n/gu, '\n');
  const diffHeaders = patch
    .split('\n')
    .filter((line) => line.startsWith('diff --git '));
  const expectedHeaders = [
    `diff --git a/${REPAIR_MODIFIED_SOURCE_PATH} b/${REPAIR_MODIFIED_SOURCE_PATH}`,
    `diff --git a/${REPAIR_ADDED_REGRESSION_PATH} b/${REPAIR_ADDED_REGRESSION_PATH}`,
  ];
  if (
    diffHeaders.length !== expectedHeaders.length ||
    diffHeaders.some((header, index) => header !== expectedHeaders[index])
  ) {
    return fail(
      'unexpected_patch_structure',
      'Unified diff must contain only the ordered allowlisted source and regression paths.',
    );
  }

  if (
    /(?:^|\n)(?:old mode|deleted file mode|rename from|rename to|copy from|copy to|Submodule )/u.test(
      patch,
    ) ||
    /(?:GIT binary patch|Binary files .* differ)/u.test(patch)
  ) {
    return fail(
      'forbidden_patch_metadata',
      'Repair diff contains a mode, delete, rename, copy, submodule, or binary change.',
    );
  }
  const newFileModeLines = patch
    .split('\n')
    .filter((line) => line.startsWith('new file mode '));
  if (newFileModeLines.length !== 1 || newFileModeLines[0] !== 'new file mode 100644') {
    return fail(
      'invalid_new_file_mode',
      'Repair must add exactly one non-executable regular regression file.',
    );
  }
  return patch;
}

async function validateInspection(
  handle: DisposableWorktree,
  inspection: WorktreeInspection,
): Promise<ValidatedRepairDiff> {
  assertExactStatuses(inspection);
  await assertIndexShape(handle);
  assertRawDiff(inspection);
  const repairedSource = await assertRegularTextFile(
    handle.worktreePath,
    REPAIR_MODIFIED_SOURCE_PATH,
  );
  const regressionText = await assertRegularTextFile(
    handle.worktreePath,
    REPAIR_ADDED_REGRESSION_PATH,
    { requireNonExecutable: true },
  );

  const patch = assertPatchStructure(inspection);
  const patchBytes = Buffer.byteLength(patch, 'utf8');
  if (patchBytes > MAX_REPAIR_PATCH_BYTES) {
    fail(
      'patch_too_large',
      `Repair patch is ${patchBytes} bytes; maximum is ${MAX_REPAIR_PATCH_BYTES}.`,
    );
  }

  const { addedLines, deletedLines } = countChangedLines(patch);
  const totalChangedLines = addedLines + deletedLines;
  if (totalChangedLines > MAX_REPAIR_CHANGED_LINES) {
    fail(
      'too_many_changed_lines',
      `Repair changes ${totalChangedLines} lines; maximum is ${MAX_REPAIR_CHANGED_LINES}.`,
    );
  }
  const baseSource = (
    await runGit(handle.worktreePath, [
      'show',
      `${handle.repository.baseHead}:${REPAIR_MODIFIED_SOURCE_PATH}`,
    ])
  ).stdout;
  assertBoundedSourceRepair(baseSource, repairedSource);
  assertSemanticRepairBoundary(inspection.trackedUnstagedPatch, regressionText);
  return Object.freeze({
    baseHead: handle.repository.baseHead,
    modifiedPath: REPAIR_MODIFIED_SOURCE_PATH,
    addedPath: REPAIR_ADDED_REGRESSION_PATH,
    patch,
    patchSha256: createHash('sha256').update(patch, 'utf8').digest('hex'),
    patchBytes,
    addedLines,
    deletedLines,
    totalChangedLines,
  });
}

export async function validateRepairDiff(
  handle: DisposableWorktree,
): Promise<ValidatedRepairDiff> {
  await verifyDisposableWorktree(handle);
  const firstInspection = await inspectDisposableWorktree(handle);
  const validated = await validateInspection(handle, firstInspection);
  await verifyDisposableWorktree(handle);

  const secondInspection = await inspectDisposableWorktree(handle);
  if (
    inspectionFingerprint(firstInspection) !==
    inspectionFingerprint(secondInspection)
  ) {
    fail(
      'worktree_changed_during_validation',
      'Repair worktree changed while its diff was being validated.',
    );
  }
  await verifyDisposableWorktree(handle);
  return validated;
}
