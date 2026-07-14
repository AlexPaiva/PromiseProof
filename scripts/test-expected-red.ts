import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PP_CODE_PATTERN = /\bPP_[A-Z0-9_]+\b/g;

export interface ExpectedRedCase {
  readonly name: string;
  readonly npmScript: string;
  readonly outputDirectoryName: string;
  readonly expectedCode: string;
  readonly expectedClause: string;
}

export interface ChildRunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly spawnError?: string;
}

export interface ExpectedRedValidation {
  readonly passed: boolean;
  readonly errors: string[];
  readonly evidencePath: string | null;
}

const EXPECTED_CASES: readonly ExpectedRedCase[] = [
  {
    name: "startup-order fixture",
    npmScript: "verify:promise:race",
    outputDirectoryName: "race-contract",
    expectedCode: "PP_IDENTIFIABLE_EVENT_LEAK",
    expectedClause: "no_identifiable_activity",
  },
  {
    name: "preference-roundtrip fixture",
    npmScript: "verify:promise:propagation",
    outputDirectoryName: "propagation-contract",
    expectedCode: "PP_PREFERENCE_NOT_PERSISTED",
    expectedClause: "preference_survives_reload",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniquePromiseProofCodes(value: string): string[] {
  return [...new Set(value.match(PP_CODE_PATTERN) ?? [])].sort();
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
}

async function requireNonemptyFile(
  filePath: string | undefined,
  label: string,
  errors: string[],
): Promise<void> {
  if (filePath === undefined) {
    errors.push(`Missing ${label}.`);
    return;
  }

  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size === 0) {
    errors.push(`${label} is empty or is not a file.`);
  }
}

function validateLastRun(
  value: unknown,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(".last-run.json is not an object.");
    return;
  }

  if (value.status !== "failed") {
    errors.push(`Expected .last-run status failed, observed ${String(value.status)}.`);
  }
  if (!Array.isArray(value.failedTests) || value.failedTests.length !== 1) {
    errors.push("Expected exactly one failed Playwright test.");
  }
}

function validateEvidence(
  value: unknown,
  expectedCase: ExpectedRedCase,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push("Normalized evidence is not an object.");
    return;
  }

  if (value.schemaVersion !== 2) {
    errors.push(`Expected evidence schemaVersion 2, observed ${String(value.schemaVersion)}.`);
  }

  const evaluation = value.evaluation;
  if (!isRecord(evaluation)) {
    errors.push("Evidence has no evaluation object.");
    return;
  }
  if (evaluation.verdict !== "fail") {
    errors.push(`Expected fail verdict, observed ${String(evaluation.verdict)}.`);
  }

  const violations = evaluation.violations;
  if (!Array.isArray(violations) || violations.length !== 1) {
    errors.push("Expected exactly one normalized violation.");
  } else {
    const violation = violations[0];
    if (!isRecord(violation)) {
      errors.push("Normalized violation is not an object.");
    } else {
      if (violation.code !== expectedCase.expectedCode) {
        errors.push(
          `Expected evidence code ${expectedCase.expectedCode}, observed ${String(violation.code)}.`,
        );
      }
      if (violation.clause !== expectedCase.expectedClause) {
        errors.push(
          `Expected evidence clause ${expectedCase.expectedClause}, observed ${String(violation.clause)}.`,
        );
      }
    }
  }

  const observations = value.observations;
  if (
    !isRecord(observations) ||
    !Array.isArray(observations.browserErrors) ||
    observations.browserErrors.length !== 0
  ) {
    errors.push("Expected normalized evidence with zero browser errors.");
  }

  const evidenceCodes = uniquePromiseProofCodes(JSON.stringify(value));
  if (
    evidenceCodes.length !== 1 ||
    evidenceCodes[0] !== expectedCase.expectedCode
  ) {
    errors.push(
      `Evidence PP_ codes must be exactly ${expectedCase.expectedCode}; observed ${evidenceCodes.join(", ") || "none"}.`,
    );
  }
}

export async function validateExpectedRedRun(
  expectedCase: ExpectedRedCase,
  run: ChildRunResult,
  outputDirectory: string,
): Promise<ExpectedRedValidation> {
  const errors: string[] = [];
  let evidencePath: string | null = null;

  if (run.spawnError !== undefined) {
    errors.push(`Verifier could not start: ${run.spawnError}`);
  }
  if (run.signal !== null) {
    errors.push(`Verifier terminated by signal ${run.signal}.`);
  }
  if (run.exitCode !== 1) {
    errors.push(`Expected verifier exit code 1, observed ${String(run.exitCode)}.`);
  }

  const outputCodes = uniquePromiseProofCodes(run.output);
  if (
    outputCodes.length !== 1 ||
    outputCodes[0] !== expectedCase.expectedCode
  ) {
    errors.push(
      `Terminal PP_ codes must be exactly ${expectedCase.expectedCode}; observed ${outputCodes.join(", ") || "none"}.`,
    );
  }

  let files: string[];
  try {
    files = await listFiles(outputDirectory);
  } catch (error) {
    errors.push(
      `Expected fresh output directory is unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return { passed: false, errors, evidencePath };
  }

  const lastRunPath = path.join(outputDirectory, ".last-run.json");
  try {
    validateLastRun(
      JSON.parse(await readFile(lastRunPath, "utf8")) as unknown,
      errors,
    );
  } catch (error) {
    errors.push(
      `.last-run.json is missing or malformed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const evidenceFiles = files.filter((filePath) =>
    path.basename(filePath).startsWith("promiseproof-evidence-") &&
    filePath.endsWith(".json"),
  );
  const primaryEvidence = evidenceFiles.filter(
    (filePath) => !filePath.split(path.sep).includes("attachments"),
  );
  const attachedEvidence = evidenceFiles.filter((filePath) =>
    filePath.split(path.sep).includes("attachments"),
  );

  if (primaryEvidence.length !== 1) {
    errors.push(
      `Expected exactly one primary evidence JSON, observed ${primaryEvidence.length}.`,
    );
  } else {
    evidencePath = primaryEvidence[0] ?? null;
    try {
      validateEvidence(
        JSON.parse(await readFile(primaryEvidence[0] ?? "", "utf8")) as unknown,
        expectedCase,
        errors,
      );
    } catch (error) {
      errors.push(
        `Primary evidence is malformed: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  if (attachedEvidence.length !== 1) {
    errors.push(
      `Expected exactly one attached evidence JSON, observed ${attachedEvidence.length}.`,
    );
  } else if (primaryEvidence.length === 1) {
    const [primaryBody, attachedBody] = await Promise.all([
      readFile(primaryEvidence[0] ?? "", "utf8"),
      readFile(attachedEvidence[0] ?? "", "utf8"),
    ]);
    if (primaryBody !== attachedBody) {
      errors.push("Primary and attached evidence JSON differ.");
    }
  }

  const errorContext = files.find(
    (filePath) => path.basename(filePath) === "error-context.md",
  );
  const screenshot = files.find((filePath) => filePath.endsWith(".png"));
  const video = files.find((filePath) => path.basename(filePath) === "video.webm");
  const trace = files.find((filePath) => path.basename(filePath) === "trace.zip");
  await Promise.all([
    requireNonemptyFile(errorContext, "error context", errors),
    requireNonemptyFile(screenshot, "failure screenshot", errors),
    requireNonemptyFile(video, "failure video", errors),
    requireNonemptyFile(trace, "Playwright trace", errors),
  ]);

  if (errorContext !== undefined) {
    const contextCodes = uniquePromiseProofCodes(
      await readFile(errorContext, "utf8"),
    );
    if (
      contextCodes.length !== 1 ||
      contextCodes[0] !== expectedCase.expectedCode
    ) {
      errors.push(
        `Error-context PP_ codes must be exactly ${expectedCase.expectedCode}; observed ${contextCodes.join(", ") || "none"}.`,
      );
    }
  }

  return { passed: errors.length === 0, errors, evidencePath };
}

async function runNpmScript(
  projectRoot: string,
  npmScript: string,
): Promise<ChildRunResult> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) {
    return {
      exitCode: null,
      signal: null,
      output: "",
      spawnError: "npm_execpath is unavailable; invoke this checker through npm.",
    };
  }

  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete environment.FORCE_COLOR;

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: ChildRunResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const child = spawn(process.execPath, [npmExecPath, "run", npmScript], {
      cwd: projectRoot,
      env: environment,
      shell: false,
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        output,
        spawnError: error.message,
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, output });
    });
  });
}

async function clearKnownOutput(
  testResultsRoot: string,
  expectedCase: ExpectedRedCase,
): Promise<string> {
  await mkdir(testResultsRoot, { recursive: true });
  const outputDirectory = path.resolve(
    testResultsRoot,
    expectedCase.outputDirectoryName,
  );
  if (path.dirname(outputDirectory) !== testResultsRoot) {
    throw new Error(`Unsafe expected-red output path: ${outputDirectory}.`);
  }
  await rm(outputDirectory, { recursive: true, force: true });
  return outputDirectory;
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const testResultsRoot = path.join(projectRoot, "test-results");
  const failures: string[] = [];

  for (const expectedCase of EXPECTED_CASES) {
    const outputDirectory = await clearKnownOutput(testResultsRoot, expectedCase);
    const run = await runNpmScript(projectRoot, expectedCase.npmScript);
    process.stdout.write(run.output);
    const validation = await validateExpectedRedRun(
      expectedCase,
      run,
      outputDirectory,
    );

    if (validation.passed) {
      console.log(
        `EXPECTED RED PASS — ${expectedCase.expectedCode} — ${validation.evidencePath ?? "evidence unavailable"}`,
      );
    } else {
      failures.push(
        ...validation.errors.map((error) => `${expectedCase.name}: ${error}`),
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`Expected-red verification failed:\n${failures.join("\n")}`);
  }

  console.log("Expected-red verification passed for both seeded fixtures.");
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
