import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  type ChildRunResult,
  type ExpectedRedCase,
  validateExpectedRedRun,
} from "./test-expected-red.js";

const expectedCase: ExpectedRedCase = {
  name: "test fixture",
  npmScript: "verify:test",
  outputDirectoryName: "contract",
  expectedCode: "PP_IDENTIFIABLE_EVENT_LEAK",
  expectedClause: "no_identifiable_activity",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "promiseproof-red-"));
  temporaryDirectories.push(root);
  const resultDirectory = path.join(root, "case");
  const attachmentsDirectory = path.join(resultDirectory, "attachments");
  await mkdir(attachmentsDirectory, { recursive: true });

  const artifact = JSON.stringify({
    schemaVersion: 2,
    evaluation: {
      verdict: "fail",
      violations: [
        {
          code: expectedCase.expectedCode,
          clause: expectedCase.expectedClause,
          message: "Expected seeded finding.",
        },
      ],
    },
    observations: { browserErrors: [] },
  });
  const evidenceName = "promiseproof-evidence-contract.json";
  await Promise.all([
    writeFile(
      path.join(root, ".last-run.json"),
      JSON.stringify({ status: "failed", failedTests: ["one"] }),
    ),
    writeFile(path.join(resultDirectory, evidenceName), artifact),
    writeFile(path.join(attachmentsDirectory, evidenceName), artifact),
    writeFile(
      path.join(resultDirectory, "error-context.md"),
      expectedCase.expectedCode,
    ),
    writeFile(path.join(resultDirectory, "test-failed-1.png"), "png"),
    writeFile(path.join(resultDirectory, "video.webm"), "video"),
    writeFile(path.join(resultDirectory, "trace.zip"), "trace"),
  ]);

  return root;
}

function successfulRun(output = expectedCase.expectedCode): ChildRunResult {
  return { exitCode: 1, signal: null, output };
}

test("accepts only the exact expected failure and complete artifacts", async () => {
  const outputDirectory = await createFixture();
  const result = await validateExpectedRedRun(
    expectedCase,
    successfulRun(),
    outputDirectory,
  );
  assert.equal(result.passed, true, result.errors.join("\n"));
});

test("rejects an unrelated process exit", async () => {
  const outputDirectory = await createFixture();
  const result = await validateExpectedRedRun(
    expectedCase,
    { ...successfulRun(), exitCode: 2 },
    outputDirectory,
  );
  assert.equal(result.passed, false);
  assert.match(result.errors.join("\n"), /exit code 1/);
});

test("rejects any additional PP_ code in terminal output", async () => {
  const outputDirectory = await createFixture();
  const result = await validateExpectedRedRun(
    expectedCase,
    successfulRun(`${expectedCase.expectedCode}\nPP_UNRELATED_FAILURE`),
    outputDirectory,
  );
  assert.equal(result.passed, false);
  assert.match(result.errors.join("\n"), /Terminal PP_ codes/);
});

test("rejects missing retained evidence media", async () => {
  const outputDirectory = await createFixture();
  await rm(path.join(outputDirectory, "case", "trace.zip"));
  const result = await validateExpectedRedRun(
    expectedCase,
    successfulRun(),
    outputDirectory,
  );
  assert.equal(result.passed, false);
  assert.match(result.errors.join("\n"), /Playwright trace/);
});
