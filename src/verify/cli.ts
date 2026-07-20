import {
  lstat,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CHECK_EXIT,
  checkGate,
  checkSingle,
} from "./check.js";
import {
  brokenOffExample,
  passingOffExample,
  passingOnExample,
  producerTemplate,
  scaffoldReadme,
} from "./examples.js";
import {
  EXIT_CODE,
  type ExternalOutcome,
} from "./outcome.js";
import {
  createGateReport,
  createVerifyReport,
  serializeGateReportMarkdown,
  serializeReportJson,
  serializeVerifyReportMarkdown,
} from "./report.js";
import {
  externalBundleJsonSchema,
  MAX_INPUT_BYTES,
} from "./schema.js";
import {
  gateValidationIssues,
  runGate,
  verifyBundle,
} from "./verify.js";

const HELP = `PromiseProof external evidence verifier

Usage:
  npm run promiseproof -- init --out <directory>
  npm run promiseproof -- verify --evidence <bundle.json> --out <directory>
  npm run promiseproof -- gate --off <off-bundle.json> --on <on-bundle.json> --out <directory>
  npm run promiseproof -- check --report <report.json> --evidence <bundle.json>
  npm run promiseproof -- check --report <report.json> --off <off.json> --on <on.json>
  npm run promiseproof -- --help

Exit codes (verify / gate):
  0  PASS
  1  usage, I/O, or unexpected execution error
  2  BROKEN_PROMISE
  3  INVALID_EVIDENCE

Exit codes (check): the report is reproduced by re-running the unchanged
evaluator on the supplied evidence, not merely hash-compared.
  0  BOUND_AND_REPRODUCED
  1  usage, I/O, or unexpected execution error
  3  INVALID_REPORT_OR_EVIDENCE
  4  STALE_OR_MISMATCH

Supported contract family: activity-personalization/v1
`;

const REPORT_FILENAMES = ["report.json", "report.md"] as const;
const SCAFFOLD_FILES = {
  "activity-personalization.v1.schema.json": () =>
    serializeJson(externalBundleJsonSchema()),
  "broken-off.example.json": () => serializeJson(brokenOffExample),
  "passing-off.example.json": () => serializeJson(passingOffExample),
  "passing-on.example.json": () => serializeJson(passingOnExample),
  "producer-template.mjs": () => producerTemplate,
  "README.md": () => scaffoldReadme,
} as const;

class UsageError extends Error {}
class InvalidEvidenceFileError extends Error {}

interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

interface ParsedOptions {
  readonly [name: string]: string;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseOptions(
  args: readonly string[],
  allowed: readonly string[],
): ParsedOptions {
  const options: Record<string, string> = {};
  const allowedSet = new Set(allowed);

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--")
    ) {
      throw new UsageError("Options must be supplied as --name <value> pairs.");
    }

    const key = name.slice(2);
    if (!allowedSet.has(key)) {
      throw new UsageError(`Unknown option: ${name}`);
    }
    if (options[key] !== undefined) {
      throw new UsageError(`Duplicate option: ${name}`);
    }
    options[key] = value;
  }

  for (const required of allowed) {
    if (options[required] === undefined) {
      throw new UsageError(`Missing required option: --${required}`);
    }
  }

  return options;
}

function safeOutputDirectory(rawPath: string): string {
  if (rawPath.trim().length === 0) {
    throw new UsageError("--out must not be empty.");
  }

  const normalizedSegments = rawPath.replaceAll("\\", "/").split("/");
  if (normalizedSegments.includes("..")) {
    throw new UsageError("--out must not contain path traversal.");
  }

  const resolved = path.resolve(rawPath);
  if (resolved === path.parse(resolved).root) {
    throw new UsageError("--out must not be a filesystem root.");
  }
  return resolved;
}

function safeChildPath(directory: string, filename: string): string {
  if (
    path.basename(filename) !== filename ||
    filename === "." ||
    filename === ".."
  ) {
    throw new Error("Generated filename is unsafe.");
  }

  const child = path.resolve(directory, filename);
  if (path.dirname(child) !== directory) {
    throw new Error("Generated path escaped the output directory.");
  }
  return child;
}

async function ensureOutputDirectory(directory: string): Promise<void> {
  try {
    const existing = await lstat(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("Output path must be a real directory.");
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      await mkdir(directory, { recursive: true });
      return;
    }
    throw error;
  }
}

async function refuseUnsafeReportTarget(target: string): Promise<void> {
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing unsafe report target: ${path.basename(target)}`);
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function writeReports(
  outputDirectory: string,
  json: string,
  markdown: string,
): Promise<void> {
  await ensureOutputDirectory(outputDirectory);
  const jsonPath = safeChildPath(outputDirectory, REPORT_FILENAMES[0]);
  const markdownPath = safeChildPath(outputDirectory, REPORT_FILENAMES[1]);
  await refuseUnsafeReportTarget(jsonPath);
  await refuseUnsafeReportTarget(markdownPath);
  await writeFile(jsonPath, json, "utf8");
  await writeFile(markdownPath, markdown, "utf8");
}

async function writeScaffold(outputDirectory: string): Promise<void> {
  await ensureOutputDirectory(outputDirectory);
  const entries = Object.entries(SCAFFOLD_FILES);
  const targets = entries.map(([filename]) =>
    safeChildPath(outputDirectory, filename),
  );

  for (const target of targets) {
    try {
      await lstat(target);
      throw new Error(
        `Refusing to overwrite existing scaffold file: ${path.basename(target)}`,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }

  const created: string[] = [];
  try {
    for (const [filename, content] of entries) {
      const target = safeChildPath(outputDirectory, filename);
      await writeFile(target, content(), { encoding: "utf8", flag: "wx" });
      created.push(target);
    }
  } catch (error) {
    await Promise.all(
      created.map(async (target) => {
        const { unlink } = await import("node:fs/promises");
        await unlink(target);
      }),
    );
    throw error;
  }
}

async function readExternalJson(filename: string): Promise<unknown> {
  let metadata;
  try {
    metadata = await stat(filename);
  } catch {
    throw new Error("Unable to read evidence file.");
  }

  if (!metadata.isFile()) {
    throw new Error("Evidence path must identify a regular file.");
  }
  if (metadata.size > MAX_INPUT_BYTES) {
    throw new InvalidEvidenceFileError(
      `<root>: input exceeds ${MAX_INPUT_BYTES}-byte limit`,
    );
  }

  const bytes = await readFile(filename);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new InvalidEvidenceFileError(
      `<root>: input exceeds ${MAX_INPUT_BYTES}-byte limit`,
    );
  }

  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new InvalidEvidenceFileError("<root>: malformed JSON");
  }
}

function printInvalid(io: CliIo, issues: readonly string[]): number {
  io.stderr("INVALID_EVIDENCE");
  for (const issue of [...issues].sort()) {
    io.stderr(`- ${issue}`);
  }
  return EXIT_CODE.INVALID_EVIDENCE;
}

function printOutcome(io: CliIo, outcome: ExternalOutcome): void {
  if (outcome === "PASS") {
    io.stdout("PASS — report.json and report.md written.");
  } else if (outcome === "BROKEN_PROMISE") {
    io.stdout("BROKEN_PROMISE — report.json and report.md written.");
  }
}

async function runInit(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, ["out"]);
  await writeScaffold(safeOutputDirectory(options.out!));
  io.stdout("Initialized activity-personalization/v1 scaffold (6 files).");
  return EXIT_CODE.PASS;
}

async function runVerify(args: readonly string[], io: CliIo): Promise<number> {
  const options = parseOptions(args, ["evidence", "out"]);
  const raw = await readExternalJson(options.evidence!);
  const result = verifyBundle(raw);
  if (result.outcome === "INVALID_EVIDENCE") {
    return printInvalid(io, result.issues);
  }

  const report = await createVerifyReport(result);
  await writeReports(
    safeOutputDirectory(options.out!),
    serializeReportJson(report),
    serializeVerifyReportMarkdown(report),
  );
  printOutcome(io, result.outcome);
  return EXIT_CODE[result.outcome];
}

async function runGateCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args, ["off", "on", "out"]);
  const rawOff = await readExternalJson(options.off!);
  const rawOn = await readExternalJson(options.on!);
  const result = runGate(rawOff, rawOn);
  if (result.outcome === "INVALID_EVIDENCE") {
    return printInvalid(io, gateValidationIssues(result));
  }

  const report = await createGateReport(result);
  await writeReports(
    safeOutputDirectory(options.out!),
    serializeReportJson(report),
    serializeGateReportMarkdown(report),
  );
  printOutcome(io, result.outcome);
  return EXIT_CODE[result.outcome];
}

async function runCheck(args: readonly string[], io: CliIo): Promise<number> {
  const hasEvidence = args.includes("--evidence");
  const hasGate = args.includes("--off") || args.includes("--on");

  if (hasEvidence && !hasGate) {
    const options = parseOptions(args, ["report", "evidence"]);
    const [report, evidence] = await Promise.all([
      readExternalJson(options.report!),
      readExternalJson(options.evidence!),
    ]);
    const result = await checkSingle(report, evidence);
    io.stdout(`${result.status}: ${result.detail}`);
    return CHECK_EXIT[result.status];
  }

  if (hasGate && !hasEvidence) {
    const options = parseOptions(args, ["report", "off", "on"]);
    const [report, off, on] = await Promise.all([
      readExternalJson(options.report!),
      readExternalJson(options.off!),
      readExternalJson(options.on!),
    ]);
    const result = await checkGate(report, off, on);
    io.stdout(`${result.status}: ${result.detail}`);
    return CHECK_EXIT[result.status];
  }

  throw new UsageError(
    "check requires --report with either --evidence, or both --off and --on.",
  );
}

export async function runCli(
  args: readonly string[],
  io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  if (args.length === 0) {
    io.stderr(HELP);
    return EXIT_CODE.EXECUTION_ERROR;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    io.stdout(HELP);
    return EXIT_CODE.PASS;
  }

  const [command, ...commandArgs] = args;
  try {
    if (command === "init") {
      return await runInit(commandArgs, io);
    }
    if (command === "verify") {
      return await runVerify(commandArgs, io);
    }
    if (command === "gate") {
      return await runGateCommand(commandArgs, io);
    }
    if (command === "check") {
      return await runCheck(commandArgs, io);
    }
    throw new UsageError(`Unknown command: ${String(command)}`);
  } catch (error) {
    if (error instanceof InvalidEvidenceFileError) {
      return printInvalid(io, [error.message]);
    }
    if (error instanceof UsageError) {
      io.stderr(`USAGE_ERROR: ${error.message}`);
      io.stderr("Run npm run promiseproof -- --help for usage.");
      return EXIT_CODE.EXECUTION_ERROR;
    }

    io.stderr(
      `EXECUTION_ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_CODE.EXECUTION_ERROR;
  }
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
