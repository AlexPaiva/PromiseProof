// Real bundled-Action symlink boundary tests. The consumer matrix runs this
// after removing repository source, dependencies, and root package files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const bundle = path.resolve(".github/actions/verify/dist/index.js");
const OFF = readFileSync("artifacts/verify/passing-off.example.json", "utf8");
const ON = readFileSync("artifacts/verify/passing-on.example.json", "utf8");
const REPORT = readFileSync("artifacts/verify/passing-gate.report.json", "utf8");

function parseStatus(file) {
  const assignments = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("status="));
  return assignments.at(-1)?.slice("status=".length) ?? "";
}

function runAction(files, inputs, setup) {
  const workspace = mkdtempSync(path.join(tmpdir(), "pp-consumer-ws-"));
  const outside = mkdtempSync(path.join(tmpdir(), "pp-consumer-outside-"));
  const runner = mkdtempSync(path.join(tmpdir(), "pp-consumer-runner-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  setup?.(workspace, outside);
  const output = path.join(runner, "output");
  const summary = path.join(runner, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("INPUT_")) delete env[key];
  }
  Object.assign(env, {
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
  });
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }
  const result = spawnSync(process.execPath, [bundle], { env, encoding: "utf8" });
  return { code: result.status, status: parseStatus(output), workspace, outside };
}

function linkFile(target, link) {
  symlinkSync(target, link, "file");
}

function linkDirectory(target, link) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function assertExecutionError(result) {
  assert.equal(result.code, 1);
  assert.equal(result.status, "EXECUTION_ERROR");
}

function runSuite() {
  for (const [label, inputs, outsideContent] of [
    ["evidence", { mode: "verify", evidence: "escape.json", output_directory: "out" }, OFF],
    ["report", { mode: "check", report: "escape.json", evidence: "off.json" }, "{}"],
    ["OFF", { mode: "gate", off_evidence: "escape.json", on_evidence: "on.json", output_directory: "out" }, OFF],
    ["ON", { mode: "gate", off_evidence: "off.json", on_evidence: "escape.json", output_directory: "out" }, ON],
  ]) {
    const result = runAction(
      { "off.json": OFF, "on.json": ON },
      inputs,
      (workspace, outside) => {
        const target = path.join(outside, "outside.json");
        writeFileSync(target, outsideContent);
        linkFile(target, path.join(workspace, "escape.json"));
      },
    );
    assertExecutionError(result);
    assert.equal(readFileSync(path.join(result.outside, "outside.json"), "utf8"), outsideContent, `${label} outside target changed`);
  }

  const internal = runAction(
    { "actual/off.json": OFF },
    { mode: "verify", evidence: "off-link.json", output_directory: "out" },
    (workspace) => linkFile(path.join(workspace, "actual/off.json"), path.join(workspace, "off-link.json")),
  );
  assert.equal(internal.code, 0);
  assert.equal(internal.status, "PASS");

  for (const outputDirectory of ["out-link", "parent-link/nested"]) {
    const escaped = runAction(
      { "off.json": OFF },
      { mode: "verify", evidence: "off.json", output_directory: outputDirectory },
      (workspace, outside) => linkDirectory(outside, path.join(workspace, outputDirectory.split("/")[0])),
    );
    assertExecutionError(escaped);
    assert.deepEqual([], existsSync(escaped.outside) ? readDirectory(escaped.outside) : []);
  }

  for (const filename of ["report.json", "report.md"]) {
    const escaped = runAction(
      { "off.json": OFF },
      { mode: "verify", evidence: "off.json", output_directory: "out" },
      (workspace, outside) => {
        mkdirSync(path.join(workspace, "out"));
        const target = path.join(outside, filename);
        writeFileSync(target, "outside sentinel");
        linkFile(target, path.join(workspace, "out", filename));
      },
    );
    assertExecutionError(escaped);
    assert.equal(readFileSync(path.join(escaped.outside, filename), "utf8"), "outside sentinel");
  }

  const regularFile = runAction(
    { "off.json": OFF, out: "not a directory" },
    { mode: "verify", evidence: "off.json", output_directory: "out" },
  );
  assertExecutionError(regularFile);

  const nested = runAction(
    { "off.json": OFF },
    { mode: "verify", evidence: "off.json", output_directory: "nested/reports" },
  );
  assert.equal(nested.code, 0);
  assert.ok(existsSync(path.join(nested.workspace, "nested/reports/report.json")));
  assert.ok(existsSync(path.join(nested.workspace, "nested/reports/report.md")));
}

function readDirectory(directory) {
  return readdirSync(directory).sort();
}

try {
  runSuite();
  console.log(`consumer symlink boundary suite passed on ${process.platform}`);
} catch (error) {
  const code = error?.code;
  if (process.platform !== "linux" && ["EPERM", "EACCES", "ENOSYS"].includes(code)) {
    console.log(`consumer symlink boundary suite skipped on ${process.platform}: symlink capability unavailable (${code})`);
  } else {
    throw error;
  }
}
