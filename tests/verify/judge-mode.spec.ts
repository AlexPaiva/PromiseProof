import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page, type Request } from "@playwright/test";

import { EVALUATOR_SOURCE_SHA256 } from "../../src/verify/binding.js";
import {
  brokenOffExample,
  passingOffExample,
  passingOnExample,
} from "../../src/verify/examples.js";
import { MAX_INPUT_BYTES, MAX_COLLECTION_ITEMS } from "../../src/verify/schema.js";

const ROUTE = "/verify/";
const REPO = process.cwd();

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function downloadBytes(page: Page, selector: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(selector).click(),
  ]);
  const filename = await download.path();
  if (filename === null) throw new Error("browser download has no local path");
  return readFileSync(filename);
}

function cliGateReports(
  off: unknown,
  on: unknown,
  expectedExit: 0 | 2,
): { json: Buffer; markdown: Buffer } {
  const kit = mkdtempSync(path.join(tmpdir(), "pp-parity-"));
  try {
    const offPath = path.join(kit, "off.json");
    const onPath = path.join(kit, "on.json");
    writeFileSync(offPath, `${JSON.stringify(off, null, 2)}\n`);
    writeFileSync(onPath, `${JSON.stringify(on, null, 2)}\n`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(REPO, "src", "verify", "cli.ts"),
        "gate",
        "--off",
        offPath,
        "--on",
        onPath,
        "--out",
        kit,
      ],
      { cwd: REPO, encoding: "utf8", windowsHide: true },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== expectedExit) {
      throw new Error(
        `CLI gate exited ${String(result.status)} instead of ${expectedExit}: ${result.stderr}`,
      );
    }
    return {
      json: readFileSync(path.join(kit, "report.json")),
      markdown: readFileSync(path.join(kit, "report.md")),
    };
  } finally {
    rmSync(kit, { recursive: true, force: true });
  }
}

function rawStatus(baseURL: string, pathname: string): Promise<number> {
  const url = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: pathname,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

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

test("nothing leaves the page across every Judge and BYO interaction", async ({
  page,
  baseURL,
}) => {
  await open(page);
  const offenders: string[] = [];
  const evidenceValues = [
    passingOffExample.evidence.subjectId,
    passingOnExample.evidence.activity.capturedActivities[0]!.itemId,
  ];
  const record = (request: Request): void => {
    const url = request.url();
    const body = request.postData() ?? "";
    const local = url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("about:");
    const networkApi = ["fetch", "xhr", "websocket", "eventsource", "ping"].includes(
      request.resourceType(),
    );
    const evidenceDerived = evidenceValues.some(
      (value) => url.includes(value) || body.includes(value),
    );
    if (
      !local &&
      (networkApi ||
        request.method() === "POST" ||
        request.isNavigationRequest() ||
        evidenceDerived)
    ) {
      offenders.push(`${request.method()} ${request.resourceType()} ${url}`);
    }
  };
  page.on("request", record);
  page.on("websocket", (socket) => offenders.push(`WEBSOCKET ${socket.url()}`));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url() !== `${baseURL}${ROUTE}`) {
      offenders.push(`NAVIGATION ${frame.url()}`);
    }
  });

  await page.getByTestId("tamper").click();
  await expect(page.getByTestId("outcome-pill")).toContainText("BROKEN_PROMISE");
  await page.getByTestId("evaluate").click();
  await page.getByTestId("check").click();
  await page.getByTestId("seal").click();
  await page.getByTestId("reset").click();
  await downloadBytes(page, "#vf-dl-json");
  await downloadBytes(page, "#vf-dl-md");

  await page.locator("#vf-file-off").setInputFiles({
    name: "passing-off.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(passingOffExample)),
  });
  await page.locator("#vf-file-on").setInputFiles({
    name: "passing-on.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(passingOnExample)),
  });
  await expect(page.locator("#vf-name-on")).toHaveText("passing-on.json");
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("PASS");

  await page.locator("#vf-byo-clear").click();
  await page.locator("#vf-file-off").setInputFiles({
    name: "passing-single.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(passingOffExample)),
  });
  await expect(page.locator("#vf-name-off")).toHaveText("passing-single.json");
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("PASS");

  await page.locator("#vf-byo-clear").click();
  await page.locator("#vf-file-off").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not-json"),
  });
  await expect(page.locator("#vf-name-off")).toHaveText("invalid.json");
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
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
  await expect(page.getByTestId("violations").locator("li")).toHaveCount(1);
  await expect(page.locator("#vf-off-facts")).toContainText("Identifiable captured activity1");
  await expect(page.locator("#vf-off-facts")).toContainText("Recommendation-service receipts1");
  await expect(page.getByTestId("clauses").locator(".vf-tag.fail")).toHaveCount(1);
  await expect(page.getByTestId("clauses").locator(".vf-tag.pass")).toHaveCount(4);

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
  const originalOn = await page.locator("#vf-on-facts").textContent();
  const originalDigests = await page.locator("#vf-digests").textContent();
  const originalJson = await downloadBytes(page, "#vf-dl-json");
  await page.getByTestId("tamper").click();
  await expect(page.getByTestId("repro-pill")).toContainText("STALE_OR_MISMATCH");
  await expect(page.locator("#vf-on-facts")).toHaveText(originalOn ?? "");

  await page.getByTestId("seal").click();
  await expect(page.getByTestId("repro-pill")).toContainText("BOUND_AND_REPRODUCED");
  await expect(page.getByTestId("outcome-pill")).toContainText("BROKEN_PROMISE");

  // Reset returns to the passing, reproduced baseline.
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("outcome-pill")).toContainText("PASS");
  await expect(page.getByTestId("repro-pill")).toContainText("BOUND_AND_REPRODUCED");
  await expect(page.locator("#vf-digests")).toHaveText(originalDigests ?? "");
  await expect(page.locator("#vf-on-facts")).toHaveText(originalOn ?? "");
  expect(await downloadBytes(page, "#vf-dl-json")).toEqual(originalJson);
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

test("bring-your-own gate rejects swapped scenario slots atomically", async ({ page }) => {
  await open(page);
  await page.locator("#vf-file-off").setInputFiles({
    name: "wrong-off.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(passingOnExample)),
  });
  await page.locator("#vf-file-on").setInputFiles({
    name: "wrong-on.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(passingOffExample)),
  });
  await expect(page.locator("#vf-name-on")).toHaveText("wrong-on.json");
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
  await expect(page.locator("#vf-byo-issues")).toContainText(
    "--off bundle must contain OFF-scenario evidence",
  );
  await expect(page.locator("#vf-byo-issues")).toContainText(
    "--on bundle must contain ON-scenario evidence",
  );
  await expect(page.locator("#vf-byo-table")).toBeHidden();
  await expect(page.locator("#vf-byo-digests")).toBeEmpty();
});

test("passing and sealed-broken JSON and Markdown are byte-identical to CLI output", async ({
  page,
}) => {
  await open(page);
  const passingCli = cliGateReports(passingOffExample, passingOnExample, 0);
  expect(await downloadBytes(page, "#vf-dl-json")).toEqual(passingCli.json);
  expect(await downloadBytes(page, "#vf-dl-md")).toEqual(passingCli.markdown);

  await page.getByTestId("tamper").click();
  await page.getByTestId("seal").click();
  await expect(page.getByTestId("outcome-pill")).toContainText("BROKEN_PROMISE");
  await expect(page.getByTestId("repro-pill")).toContainText("BOUND_AND_REPRODUCED");
  const brokenCli = cliGateReports(brokenOffExample, passingOnExample, 2);
  expect(await downloadBytes(page, "#vf-dl-json")).toEqual(brokenCli.json);
  expect(await downloadBytes(page, "#vf-dl-md")).toEqual(brokenCli.markdown);
});

test("hostile local files render inertly and invalid input never inherits a verdict", async ({
  page,
}) => {
  await open(page);
  const hostileKey = '<img id="pp-injected" src=x onerror="window.ppOwned=1">';
  const hostile = clone(passingOffExample) as any;
  hostile.evidence.subjectId = "<b>& &#96; ` | \\ visible text";

  await page.locator("#vf-file-off").setInputFiles({
    name: `${hostileKey}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(hostile)),
  });
  await expect(page.locator("#vf-name-off")).toHaveText(`${hostileKey}.json`);
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("PASS");
  await expect(page.locator("#pp-injected")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).ppOwned)).toBeUndefined();

  const unknown = clone(hostile);
  unknown.evidence.control[hostileKey] = true;
  await page.locator("#vf-file-off").setInputFiles({
    name: "unknown-key.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(unknown)),
  });
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
  await expect(page.locator("#vf-byo-issues")).toContainText("Invalid input");
  await expect(page.locator("#pp-injected")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).ppOwned)).toBeUndefined();

  const bidi = clone(passingOffExample) as any;
  bidi.evidence.subjectId = "safe\u202Eunsafe";
  await page.locator("#vf-file-off").setInputFiles({
    name: "bidi.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bidi)),
  });
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
  await expect(page.locator("#vf-byo-issues")).toContainText("forbidden control or bidi");

  const long = clone(passingOffExample) as any;
  long.evidence.subjectId = "x".repeat(257);
  await page.locator("#vf-file-off").setInputFiles({
    name: "long.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(long)),
  });
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");

  const collection = clone(passingOffExample) as any;
  collection.evidence.recommendations.renderedItemIds = Array.from(
    { length: MAX_COLLECTION_ITEMS + 1 },
    (_, index) => `item-${index}`,
  );
  await page.locator("#vf-file-off").setInputFiles({
    name: "collection.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(collection)),
  });
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
});

test("input and drag/drop reject oversized or malformed files without a product verdict", async ({
  page,
}) => {
  await open(page);
  await page.locator("#vf-file-off").setInputFiles({
    name: "oversized.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20),
  });
  await expect(page.locator("#vf-name-off")).toContainText("rejected");
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
  await expect(page.locator("#vf-byo-issues")).toContainText("input exceeds");
  await expect(page.getByTestId("byo-outcome")).not.toContainText("PASS");
  await expect(page.getByTestId("byo-outcome")).not.toContainText("BROKEN_PROMISE");

  await page.locator("#vf-byo-clear").click();
  await page.evaluate(() => {
    const file = new File(["{not-json"], "drop-bad.json", {
      type: "application/json",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.querySelector("#vf-drop-off")!.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(page.locator("#vf-name-off")).toHaveText("drop-bad.json");
  await page.getByTestId("byo-run").click();
  await expect(page.getByTestId("byo-outcome")).toContainText("INVALID_EVIDENCE");
  await expect(page.locator("#vf-byo-issues")).toContainText("malformed JSON");
  await expect(page.getByTestId("byo-outcome")).not.toContainText("PASS");
  await expect(page.getByTestId("byo-outcome")).not.toContainText("BROKEN_PROMISE");
});

test("assembled root, walkthrough, verifier routes, assets, refresh, and traversal boundary", async ({
  page,
  request,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error("missing test baseURL");
  const root = await request.get("/");
  expect(root.status()).toBe(200);
  expect(Buffer.from(await root.body())).toEqual(readFileSync(path.join(REPO, "landing", "index.html")));

  for (const route of ["/walkthrough/", "/verify/"]) {
    const response = await request.get(route);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const subpath = route.slice(0, -1);
    const assets = [...html.matchAll(new RegExp(`${subpath}/assets/[^"'?#]+`, "gu"))].map(
      (match) => match[0],
    );
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of new Set(assets)) {
      expect((await request.get(asset)).status()).toBe(200);
    }
  }

  await page.goto("/verify/");
  await expect(page.getByTestId("outcome-pill")).toContainText("PASS");
  await page.reload();
  await expect(page.getByTestId("repro-pill")).toContainText("BOUND_AND_REPRODUCED");

  expect(await rawStatus(baseURL, "/%2e%2e%2fpackage.json")).toBe(403);
  expect([403, 404]).toContain(
    await rawStatus(baseURL, "/%2e%2e%5cpackage.json"),
  );
});

test("JavaScript-disabled verifier gives an honest fallback", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}${ROUTE}`);
    await expect(page.locator(".vf-fallback")).toBeVisible();
    await expect(page.locator(".vf-fallback")).toContainText(
      "interactive and needs JavaScript",
    );
    await expect(page.locator(".vf-fallback")).toContainText("GitHub repository");
  } finally {
    await context.close();
  }
});
