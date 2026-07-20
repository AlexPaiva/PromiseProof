import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page, type Request } from "@playwright/test";

import { EVALUATOR_SOURCE_SHA256 } from "../../src/verify/binding.js";
import { passingOffExample, passingOnExample } from "../../src/verify/examples.js";

const ROUTE = "/verify/";
const REPO = process.cwd();

async function open(page: Page): Promise<void> {
  await page.goto(ROUTE);
  await expect(page.getByTestId("outcome-pill")).toContainText("PASS");
}

test("Judge Mode opens on PASS + BOUND with the pinned evaluator fingerprint", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId("outcome-pill")).toContainText("PASS");
  await expect(page.getByTestId("repro-pill")).toContainText("BOUND_AND_REPRODUCED");

  // Five clause rows, all PASS, in the healthy state.
  const rows = page.getByTestId("clauses").locator("tr");
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId("clauses").locator(".vf-tag.fail")).toHaveCount(0);

  // The fingerprint is the pinned build value, verbatim, not recomputed copy.
  await expect(page.locator("#vf-fp")).toHaveText(EVALUATOR_SOURCE_SHA256);
  await expect(page.getByTestId("violations")).toContainText("no violations");
});

test("nothing leaves the page: no cross-origin, fetch, socket, or POST traffic", async ({
  page,
  baseURL,
}) => {
  const offenders: string[] = [];
  const record = (request: Request): void => {
    const url = request.url();
    const sameOrigin = baseURL !== undefined && url.startsWith(baseURL);
    const local = url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("about:");
    const chatty = ["fetch", "xhr", "websocket", "eventsource"].includes(
      request.resourceType(),
    );
    if ((!sameOrigin && !local) || chatty || request.method() === "POST") {
      offenders.push(`${request.method()} ${request.resourceType()} ${url}`);
    }
  };
  page.on("request", record);

  await open(page);
  // Exercise every interactive path that could plausibly phone home.
  await page.getByTestId("tamper").click();
  await expect(page.getByTestId("outcome-pill")).toContainText("BROKEN_PROMISE");
  await page.getByTestId("evaluate").click();
  await page.getByTestId("check").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#vf-dl-json").click(),
  ]);
  await download.path();
  await page.waitForTimeout(200);

  expect(offenders, `unexpected egress:\n${offenders.join("\n")}`).toEqual([]);
});

test("tampering the OFF evidence flips the same evaluator to a broken promise", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("tamper").click();

  await expect(page.getByTestId("outcome-pill")).toContainText("BROKEN_PROMISE");
  await expect(page.getByTestId("repro-pill")).toContainText("STALE_OR_MISMATCH");
  await expect(page.getByTestId("violations")).toContainText("PP_IDENTIFIABLE_EVENT_LEAK");

  // The failing clause is the identifiable-activity clause, and the OFF panel is flagged.
  const failing = page.getByTestId("clauses").locator("tr", {
    has: page.locator(".vf-tag.fail"),
  });
  await expect(failing).toContainText("no_identifiable_activity");
  await expect(page.locator("#vf-ev-off")).toHaveClass(/tampered/);
});

test("you can only seal the truth: re-sealing tampered evidence binds BROKEN, not PASS", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("tamper").click();
  await expect(page.getByTestId("repro-pill")).toContainText("STALE_OR_MISMATCH");

  await page.getByTestId("seal").click();
  await expect(page.getByTestId("repro-pill")).toContainText("BOUND_AND_REPRODUCED");
  await expect(page.getByTestId("outcome-pill")).toContainText("BROKEN_PROMISE");

  // Reset returns to the passing, reproduced baseline.
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("outcome-pill")).toContainText("PASS");
  await expect(page.getByTestId("repro-pill")).toContainText("BOUND_AND_REPRODUCED");
});

test("bring-your-own invalid evidence surfaces validation issues, not a verdict", async ({
  page,
}) => {
  await open(page);
  const bogus = JSON.stringify({ not: "a bundle" });
  await page
    .locator("#vf-file-off")
    .setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from(bogus) });
  // Wait for the local FileReader to finish before verifying.
  await expect(page.locator("#vf-name-off")).toHaveText("bad.json");
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
  await expect(page.locator("#vf-byo-issues")).toBeVisible();
});

test("parity: the report the browser downloads is byte-identical to the CLI's", async ({
  page,
}) => {
  await open(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#vf-dl-json").click(),
  ]);
  const browserReport = readFileSync(await download.path(), "utf8");

  // Produce the CLI report for the same OFF/ON examples the page ships.
  const kit = mkdtempSync(path.join(tmpdir(), "pp-parity-"));
  const offPath = path.join(kit, "off.json");
  const onPath = path.join(kit, "on.json");
  writeFileSync(offPath, `${JSON.stringify(passingOffExample, null, 2)}\n`);
  writeFileSync(onPath, `${JSON.stringify(passingOnExample, null, 2)}\n`);
  execFileSync(
    "npx",
    ["tsx", "src/verify/cli.ts", "gate", "--off", offPath, "--on", onPath, "--out", kit],
    { cwd: REPO, stdio: "pipe", shell: process.platform === "win32" },
  );
  const cliReport = readFileSync(path.join(kit, "report.json"), "utf8");

  expect(browserReport).toBe(cliReport);
});
