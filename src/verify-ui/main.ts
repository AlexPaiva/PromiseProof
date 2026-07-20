import "./styles.css";

import {
  CANONICAL_JSON_ID,
  EVALUATOR_SOURCE_SHA256,
  SHA256_ALGORITHM,
} from "../verify/binding.js";
import { checkGate } from "../verify/check.js";
import { passingOffExample, passingOnExample } from "../verify/examples.js";
import { REPORT_SCHEMA_VERSION } from "../verify/outcome.js";
import {
  createGateReport,
  createVerifyReport,
  serializeGateReportMarkdown,
  serializeReportJson,
  type GateReport,
} from "../verify/report.js";
import type { ExternalActivity } from "../verify/schema.js";
import { runGate, verifyBundle, type VerifyResult } from "../verify/verify.js";

// ---------------------------------------------------------------------------
// Working evidence. runGate/verifyBundle/checkGate take `unknown`, so the page
// keeps mutable working copies of the shipped examples and never re-implements
// any evaluator rule. Tampering the OFF bundle just adds the one identifiable
// activity + receipt that the shipped broken-off example carries, so the
// tampered digest matches what the CLI would compute for the same evidence.
// ---------------------------------------------------------------------------
interface WorkEvidence {
  scenario: "off" | "on";
  subjectId: string;
  control: {
    uiPreference: string;
    toggleChecked: boolean;
    storedPreference: string;
    backendPreference: string;
    reloadObserved: boolean;
  };
  activity: {
    capturedActivities: ExternalActivity[];
    recommendationServiceReceipts: ExternalActivity[];
  };
  recommendations: {
    feedFunctional: boolean;
    renderedSource: string;
    renderedItemIds: string[];
    recommendationServiceReceipts: unknown[];
  };
}
interface WorkBundle {
  schemaVersion: string;
  contractFamily: string;
  evidence: WorkEvidence;
}

const LEAK_ACTIVITY: ExternalActivity = {
  runId: "article-atlas-broken-off",
  subjectId: "article-atlas-reader-001",
  eventType: "page_view",
  itemId: "article-atlas-origin-001",
  clientSequence: 1,
  occurredAt: "2026-01-15T12:00:01.000Z",
};

function freshOff(): WorkBundle {
  return structuredClone(passingOffExample as unknown as WorkBundle);
}
function freshOn(): WorkBundle {
  return structuredClone(passingOnExample as unknown as WorkBundle);
}
function withLeak(base: WorkBundle): WorkBundle {
  const next = structuredClone(base);
  next.evidence.activity.capturedActivities = [{ ...LEAK_ACTIVITY }];
  next.evidence.activity.recommendationServiceReceipts = [{ ...LEAK_ACTIVITY }];
  return next;
}

interface State {
  off: WorkBundle;
  on: WorkBundle;
  sealed: GateReport;
  tampered: boolean;
}

// ---------------------------------------------------------------------------
// Small DOM helpers. Every value derived from evidence is written with
// textContent, never innerHTML, so a hostile BYO file cannot inject markup.
// ---------------------------------------------------------------------------
function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing element #${id}`);
  }
  return node as T;
}
function tag<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = tag("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface Fact {
  k: string;
  v: string;
  leak?: boolean;
}
function offFacts(ev: WorkEvidence): Fact[] {
  const captured = ev.activity.capturedActivities.length;
  const receipts = ev.activity.recommendationServiceReceipts.length;
  return [
    { k: "Scenario", v: "OFF — personalization off" },
    { k: "Subject", v: ev.subjectId },
    {
      k: "Preference (ui / stored / backend)",
      v: `${ev.control.uiPreference} / ${ev.control.storedPreference} / ${ev.control.backendPreference}`,
    },
    { k: "Reload witnessed", v: ev.control.reloadObserved ? "yes" : "no" },
    { k: "Identifiable captured activity", v: String(captured), leak: captured > 0 },
    { k: "Recommendation-service receipts", v: String(receipts), leak: receipts > 0 },
    {
      k: "Feed",
      v: `${ev.recommendations.renderedSource}, ${ev.recommendations.renderedItemIds.length} item(s)`,
    },
  ];
}
function onFacts(ev: WorkEvidence): Fact[] {
  return [
    { k: "Scenario", v: "ON — personalization on" },
    { k: "Subject", v: ev.subjectId },
    {
      k: "Preference (ui / stored / backend)",
      v: `${ev.control.uiPreference} / ${ev.control.storedPreference} / ${ev.control.backendPreference}`,
    },
    {
      k: "Correlated activity captured",
      v: String(ev.activity.capturedActivities.length),
    },
    {
      k: "Feed",
      v: `${ev.recommendations.renderedSource}, ${ev.recommendations.renderedItemIds.length} item(s)`,
    },
  ];
}
function renderFacts(container: HTMLElement, facts: Fact[]): void {
  container.replaceChildren();
  for (const fact of facts) {
    const row = tag("div", `vf-fact${fact.leak ? " leak" : ""}`);
    row.append(tag("span", "vf-fact-k", fact.k), tag("span", "vf-fact-v", fact.v));
    container.append(row);
  }
}

interface ClauseLike {
  id: string;
  passed: boolean;
  expected: string;
  observed: string;
}
function renderClauses(
  tbody: HTMLElement,
  off: readonly ClauseLike[],
  on: readonly ClauseLike[],
): void {
  tbody.replaceChildren();
  const scoped: Array<{ scope: string; clause: ClauseLike }> = [
    ...off.map((clause) => ({ scope: "OFF", clause })),
    ...on.map((clause) => ({ scope: "ON", clause })),
  ];
  for (const { scope, clause } of scoped) {
    const row = tag("tr");

    const idCell = tag("td");
    idCell.append(
      tag("span", "vf-clause-scope", scope),
      tag("span", "vf-clause-id", clause.id),
    );

    const resultCell = tag("td");
    resultCell.append(
      tag(
        "span",
        `vf-tag ${clause.passed ? "pass" : "fail"}`,
        clause.passed ? "PASS" : "FAIL",
      ),
    );

    const detailCell = tag("td", "vf-clause-detail");
    detailCell.append(
      tag("b", undefined, "Expected "),
      document.createTextNode(clause.expected),
      tag("br"),
      tag("b", undefined, "Observed "),
      document.createTextNode(clause.observed),
    );

    row.append(idCell, resultCell, detailCell);
    tbody.append(row);
  }
}

interface ViolationLike {
  code: string;
  clause: string;
  message: string;
}
function renderViolations(list: HTMLElement, violations: readonly ViolationLike[]): void {
  list.replaceChildren();
  if (violations.length === 0) {
    list.className = "vf-violations empty";
    list.append(tag("li", undefined, "Promise verified — no violations."));
    return;
  }
  list.className = "vf-violations";
  for (const violation of violations) {
    const item = tag("li");
    item.append(
      tag("code", undefined, violation.code),
      document.createTextNode(` (${violation.clause}) — ${violation.message}`),
    );
    list.append(item);
  }
}

function setPill(pill: HTMLElement, text: string, kind: "good" | "bad" | "warn" | "idle"): void {
  const label = pill.querySelector(".vf-pill-label");
  pill.className = `vf-pill${kind === "idle" ? "" : ` ${kind}`}`;
  pill.replaceChildren();
  if (label !== null) pill.append(label);
  pill.append(document.createTextNode(text));
}

function outcomeKind(outcome: string): "good" | "bad" | "warn" {
  if (outcome === "PASS") return "good";
  if (outcome === "BROKEN_PROMISE") return "bad";
  return "warn";
}
function reproKind(status: string): "good" | "warn" {
  return status === "BOUND_AND_REPRODUCED" ? "good" : "warn";
}
function noteFor(outcome: string, repro: string, tampered: boolean): string {
  if (outcome === "INVALID_EVIDENCE") {
    return "This evidence does not pass strict validation, so the deterministic evaluator does not run on it.";
  }
  if (outcome === "PASS" && repro === "BOUND_AND_REPRODUCED") {
    return "PASS. The deterministic evaluator verified the promise over the recorded evidence, and the sealed report reproduces exactly from it. No model graded this — an unchanged evaluator did.";
  }
  if (outcome === "BROKEN_PROMISE" && repro !== "BOUND_AND_REPRODUCED") {
    return "Broken promise. Identifiable activity is present in the OFF evidence, so the same evaluator now fails no_identifiable_activity and raises PP_IDENTIFIABLE_EVENT_LEAK. The report sealed a moment ago no longer reproduces from this evidence — a PASS cannot be silently carried onto changed evidence.";
  }
  if (outcome === "BROKEN_PROMISE" && repro === "BOUND_AND_REPRODUCED") {
    return "Broken promise, sealed honestly. A new report was sealed for the current evidence and it reproduces — as BROKEN_PROMISE. Sealing binds whatever is true; it cannot manufacture a PASS.";
  }
  if (tampered) {
    return "The evidence changed. Re-evaluate it, and verify the sealed report against it.";
  }
  return "PASS on this evidence, but the sealed report was bound to different evidence, so it does not reproduce here.";
}

// ---------------------------------------------------------------------------
// Page assembly.
// ---------------------------------------------------------------------------
const APP_HTML = `
  <section class="vf-panel">
    <div class="vf-panel-head">
      <span>Deterministic verifier &middot; running in this page</span>
      <span>contract activity-personalization/v1</span>
    </div>
    <div class="vf-authority">
      <div class="vf-auth-cell">
        <p class="vf-auth-k">Evaluator source SHA-256</p>
        <p class="vf-auth-v" id="vf-fp"></p>
        <p class="vf-auth-note">Pinned to this build and verified against evaluator.ts by repository tests.</p>
      </div>
      <div class="vf-auth-cell">
        <p class="vf-auth-k">Canonicalization / digest</p>
        <p class="vf-auth-v" id="vf-canon"></p>
        <p class="vf-auth-note">Evidence digests below are recomputed here from the evidence shown.</p>
      </div>
      <div class="vf-auth-cell">
        <p class="vf-auth-k">Report schema</p>
        <p class="vf-auth-v" id="vf-schema"></p>
        <p class="vf-auth-note">The same verifier modules the CLI ships. No evaluator rule runs in this UI.</p>
      </div>
    </div>
    <div class="vf-panel-body">
      <div class="vf-evidence">
        <div class="vf-ev" id="vf-ev-off">
          <div class="vf-ev-head"><span>OFF evidence</span><span class="vf-ev-badge">the promise under test</span></div>
          <div class="vf-ev-body" id="vf-off-facts"></div>
        </div>
        <div class="vf-ev" id="vf-ev-on">
          <div class="vf-ev-head"><span>ON control</span><span class="vf-ev-badge">the counter-example</span></div>
          <div class="vf-ev-body" id="vf-on-facts"></div>
        </div>
      </div>

      <div class="vf-actions" style="margin-top:18px">
        <button type="button" class="vf-btn vf-btn-tamper" id="vf-tamper" data-testid="tamper">Tamper OFF evidence</button>
        <button type="button" class="vf-btn vf-btn-primary" id="vf-evaluate" data-testid="evaluate">Evaluate current evidence</button>
        <button type="button" class="vf-btn" id="vf-check" data-testid="check">Verify loaded report</button>
        <button type="button" class="vf-btn" id="vf-seal" data-testid="seal">Seal current result</button>
        <button type="button" class="vf-btn vf-btn-quiet" id="vf-reset" data-testid="reset">Reset passing example</button>
        <button type="button" class="vf-btn vf-btn-quiet" id="vf-dl-json">Download report.json</button>
        <button type="button" class="vf-btn vf-btn-quiet" id="vf-dl-md">Download report.md</button>
      </div>

      <div class="vf-result" style="margin-top:20px">
        <div id="vf-live" role="status" aria-live="polite">
          <div class="vf-verdict">
            <span class="vf-pill" id="vf-outcome" data-testid="outcome-pill"><span class="vf-pill-label">Current evidence</span>—</span>
            <span class="vf-pill" id="vf-repro" data-testid="repro-pill"><span class="vf-pill-label">Sealed report</span>—</span>
          </div>
          <p class="vf-result-note" id="vf-note" data-testid="result-note"></p>
        </div>
        <table class="vf-clauses">
          <thead><tr><th>Clause</th><th>Result</th><th>Expected vs observed</th></tr></thead>
          <tbody id="vf-clauses" data-testid="clauses"></tbody>
        </table>
        <ul class="vf-violations" id="vf-violations" data-testid="violations"></ul>
        <div class="vf-digests" id="vf-digests"></div>
        <p class="vf-muted" id="vf-toast" role="status" aria-live="assertive" style="margin-top:12px;min-height:1.2em"></p>
      </div>
    </div>
  </section>

  <section class="vf-panel">
    <div class="vf-panel-head"><span>Reproduce it from a terminal</span><span>byte-identical report</span></div>
    <div class="vf-panel-body">
      <p class="vf-muted" style="margin-top:0">The browser and the CLI run the same modules, so the report you download here is byte-identical to the one the CLI writes for the same evidence.</p>
      <div class="vf-cli">
        <div class="vf-cli-head">passing example</div>
        <div class="vf-cli-body">
          <div class="vf-cli-line"><span class="p">$</span> npm run promiseproof -- gate --off passing-off.json --on passing-on.json</div>
          <div class="vf-cli-line"><span class="ok">PASS</span> <span class="c"># exit 0</span></div>
          <div class="vf-cli-line"><span class="p">$</span> npm run promiseproof -- check --report report.json --off passing-off.json --on passing-on.json</div>
          <div class="vf-cli-line"><span class="ok">BOUND_AND_REPRODUCED</span> <span class="c"># exit 0</span></div>
        </div>
      </div>
      <div class="vf-cli" style="margin-top:12px">
        <div class="vf-cli-head">after tampering the OFF evidence</div>
        <div class="vf-cli-body">
          <div class="vf-cli-line"><span class="p">$</span> npm run promiseproof -- gate --off tampered-off.json --on passing-on.json</div>
          <div class="vf-cli-line"><span class="no">BROKEN_PROMISE</span> <span class="c"># exit 2 · PP_IDENTIFIABLE_EVENT_LEAK</span></div>
          <div class="vf-cli-line"><span class="p">$</span> npm run promiseproof -- check --report report.json --off tampered-off.json --on passing-on.json</div>
          <div class="vf-cli-line"><span class="no">STALE_OR_MISMATCH</span> <span class="c"># exit 4</span></div>
        </div>
      </div>
    </div>
  </section>

  <section class="vf-panel">
    <div class="vf-panel-head"><span>Bring your own evidence</span><span>parsed locally, never uploaded</span></div>
    <div class="vf-panel-body">
      <div class="vf-byo-grid">
        <div class="vf-drop" id="vf-drop-off">
          <label for="vf-file-off">OFF bundle (.json)</label>
          <input type="file" id="vf-file-off" accept="application/json,.json" />
          <p class="vf-drop-name" id="vf-name-off"></p>
        </div>
        <div class="vf-drop" id="vf-drop-on">
          <label for="vf-file-on">ON bundle (.json, optional)</label>
          <input type="file" id="vf-file-on" accept="application/json,.json" />
          <p class="vf-drop-name" id="vf-name-on"></p>
        </div>
      </div>
      <div class="vf-actions">
        <button type="button" class="vf-btn vf-btn-primary" id="vf-byo-run" data-testid="byo-run">Verify local evidence</button>
        <button type="button" class="vf-btn vf-btn-quiet" id="vf-byo-clear">Clear</button>
      </div>
      <div class="vf-result" style="margin-top:16px" id="vf-byo-result" hidden>
        <div class="vf-verdict">
          <span class="vf-pill" id="vf-byo-outcome" data-testid="byo-outcome"><span class="vf-pill-label">Local evidence</span>—</span>
        </div>
        <ul class="vf-issues" id="vf-byo-issues" hidden></ul>
        <table class="vf-clauses" id="vf-byo-table" hidden>
          <thead><tr><th>Clause</th><th>Result</th><th>Expected vs observed</th></tr></thead>
          <tbody id="vf-byo-clauses"></tbody>
        </table>
        <ul class="vf-violations" id="vf-byo-violations"></ul>
        <div class="vf-digests" id="vf-byo-digests"></div>
      </div>
      <p class="vf-muted" style="margin-top:10px">Provide one bundle for a single verification, or both an OFF and ON bundle to run the gate. Files are read with the browser's local file API; nothing is sent anywhere.</p>
    </div>
  </section>

  <section class="vf-panel vf-disclose">
    <div class="vf-panel-head"><span>What this proves, and what it doesn't</span></div>
    <div class="vf-panel-body">
      <p><strong>What it proves.</strong> The verdict comes from one deterministic evaluator whose source is fingerprinted above. The AI that diagnoses and repairs the promise never writes PASS; this unchanged evaluator does, and you can re-derive it here or from the CLI and get the same answer.</p>
      <p><strong>Tamper-evidence.</strong> A sealed report is bound to the exact evidence it was computed from. Change the evidence and the report no longer reproduces (STALE_OR_MISMATCH); you can only ever seal what is actually true.</p>
      <p><strong>What it does not claim.</strong> Evidence is externally supplied and, here, synthetic. PromiseProof does not attest how evidence was collected — only that a bundle which passes strict validation is evaluated deterministically. Full loop and source: <a href="https://github.com/AlexPaiva/PromiseProof">github.com/AlexPaiva/PromiseProof</a>.</p>
    </div>
  </section>
`;

const state: State = {
  off: freshOff(),
  on: freshOn(),
  sealed: undefined as unknown as GateReport,
  tampered: false,
};

// Cached refs, populated after the shell renders.
let offFactsEl: HTMLElement;
let onFactsEl: HTMLElement;
let evOffEl: HTMLElement;
let outcomePill: HTMLElement;
let reproPill: HTMLElement;
let noteEl: HTMLElement;
let clausesEl: HTMLElement;
let violationsEl: HTMLElement;
let digestsEl: HTMLElement;
let toastEl: HTMLElement;
let tamperBtn: HTMLButtonElement;

function toast(message: string): void {
  toastEl.textContent = message;
}

function renderDigestPairs(target: HTMLElement, entries: Array<[string, string]>): void {
  target.replaceChildren();
  for (const [k, v] of entries) {
    const cell = tag("div");
    cell.append(tag("p", "vf-digest-k", k), tag("p", "vf-digest-v", v));
    target.append(cell);
  }
}
function gateDigestPairs(report: GateReport): Array<[string, string]> {
  return [
    ["OFF evidence SHA-256", report.inputBindings.off.sha256],
    ["ON evidence SHA-256", report.inputBindings.on.sha256],
  ];
}

async function refresh(): Promise<{ outcome: string; repro: string }> {
  const gate = runGate(state.off, state.on);
  renderFacts(offFactsEl, offFacts(state.off.evidence));
  renderFacts(onFactsEl, onFacts(state.on.evidence));
  evOffEl.classList.toggle("tampered", state.tampered);

  setPill(outcomePill, gate.outcome, outcomeKind(gate.outcome));
  renderClauses(
    clausesEl,
    gate.off.evaluation?.clauses ?? [],
    gate.on.evaluation?.clauses ?? [],
  );
  renderViolations(violationsEl, [
    ...(gate.off.evaluation?.violations ?? []),
    ...(gate.on.evaluation?.violations ?? []),
  ]);

  const repro = await checkGate(state.sealed, state.off, state.on);
  setPill(reproPill, repro.status, reproKind(repro.status));

  if (gate.outcome !== "INVALID_EVIDENCE") {
    renderDigestPairs(digestsEl, gateDigestPairs(await createGateReport(gate)));
  } else {
    digestsEl.replaceChildren();
  }

  noteEl.textContent = noteFor(gate.outcome, repro.status, state.tampered);
  tamperBtn.disabled = state.tampered;
  return { outcome: gate.outcome, repro: repro.status };
}

async function seal(): Promise<void> {
  const gate = runGate(state.off, state.on);
  if (gate.outcome === "INVALID_EVIDENCE") {
    toast("Cannot seal invalid evidence.");
    return;
  }
  state.sealed = await createGateReport(gate);
  const { outcome, repro } = await refresh();
  toast(`Sealed the current result: ${outcome} · ${repro}`);
}

async function currentReport(): Promise<GateReport | null> {
  const gate = runGate(state.off, state.on);
  if (gate.outcome === "INVALID_EVIDENCE") return null;
  return createGateReport(gate);
}

// ---- BYO ----
let byoOffText: string | null = null;
let byoOnText: string | null = null;

function parseBundle(text: string): unknown {
  return JSON.parse(text);
}

function renderByo(
  off: VerifyResult,
  on: VerifyResult | null,
  digests: Array<[string, string]>,
): void {
  const result = byId("vf-byo-result");
  const outcome = byId("vf-byo-outcome");
  const issues = byId("vf-byo-issues");
  const table = byId("vf-byo-table");
  const violations = byId("vf-byo-violations");
  const digestBox = byId("vf-byo-digests");
  result.hidden = false;

  const combinedOutcome =
    on === null
      ? off.outcome
      : off.outcome === "INVALID_EVIDENCE" || on.outcome === "INVALID_EVIDENCE"
        ? "INVALID_EVIDENCE"
        : off.outcome === "PASS" && on.outcome === "PASS"
          ? "PASS"
          : "BROKEN_PROMISE";
  setPill(outcome, combinedOutcome, outcomeKind(combinedOutcome));

  const allIssues = [
    ...off.issues.map((issue) => (on === null ? issue : `off · ${issue}`)),
    ...(on?.issues ?? []).map((issue) => `on · ${issue}`),
  ];
  issues.replaceChildren();
  issues.hidden = allIssues.length === 0;
  for (const issue of allIssues) issues.append(tag("li", undefined, issue));

  const offClauses = off.evaluation?.clauses ?? [];
  const onClauses = on?.evaluation?.clauses ?? [];
  const hasClauses = offClauses.length + onClauses.length > 0;
  table.hidden = !hasClauses;
  if (hasClauses) {
    renderClauses(byId("vf-byo-clauses"), offClauses, onClauses);
  }
  renderViolations(violations, [
    ...(off.evaluation?.violations ?? []),
    ...(on?.evaluation?.violations ?? []),
  ]);
  renderDigestPairs(digestBox, digests);
}

async function runByo(): Promise<void> {
  if (byoOffText === null && byoOnText === null) {
    toast("Select at least one bundle file first.");
    return;
  }
  try {
    if (byoOffText !== null && byoOnText !== null) {
      const off = verifyBundle(parseBundle(byoOffText));
      const on = verifyBundle(parseBundle(byoOnText));
      const gate = runGate(parseBundle(byoOffText), parseBundle(byoOnText));
      const digests =
        gate.outcome === "INVALID_EVIDENCE"
          ? []
          : gateDigestPairs(await createGateReport(gate));
      renderByo(off, on, digests);
    } else {
      const single = verifyBundle(parseBundle((byoOffText ?? byoOnText) as string));
      const digests =
        single.outcome === "INVALID_EVIDENCE"
          ? []
          : [
              [
                "Evidence SHA-256",
                (await createVerifyReport(single)).inputBinding.sha256,
              ] as [string, string],
            ];
      renderByo(single, null, digests);
    }
    toast("Verified local evidence.");
  } catch {
    toast("That file is not valid JSON.");
  }
}

function wireFile(
  inputId: string,
  dropId: string,
  nameId: string,
  assign: (text: string | null, name: string) => void,
): void {
  const input = byId<HTMLInputElement>(inputId);
  const drop = byId(dropId);
  const nameEl = byId(nameId);
  const load = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      assign(String(reader.result), file.name);
      nameEl.textContent = file.name;
    };
    reader.onerror = () => toast("Could not read that file.");
    reader.readAsText(file);
  };
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) load(file);
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("drag");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("drag");
    const file = event.dataTransfer?.files?.[0];
    if (file) load(file);
  });
}

async function init(): Promise<void> {
  const appRoot = byId("vf-app");
  appRoot.innerHTML = APP_HTML;

  offFactsEl = byId("vf-off-facts");
  onFactsEl = byId("vf-on-facts");
  evOffEl = byId("vf-ev-off");
  outcomePill = byId("vf-outcome");
  reproPill = byId("vf-repro");
  noteEl = byId("vf-note");
  clausesEl = byId("vf-clauses");
  violationsEl = byId("vf-violations");
  digestsEl = byId("vf-digests");
  toastEl = byId("vf-toast");
  tamperBtn = byId<HTMLButtonElement>("vf-tamper");

  byId("vf-fp").textContent = EVALUATOR_SOURCE_SHA256;
  byId("vf-canon").textContent = `${CANONICAL_JSON_ID} · ${SHA256_ALGORITHM}`;
  byId("vf-schema").textContent = `report schema v${REPORT_SCHEMA_VERSION}`;

  // Seal the passing example on load so Judge Mode opens on PASS + BOUND.
  state.sealed = await createGateReport(runGate(state.off, state.on));

  tamperBtn.addEventListener("click", async () => {
    state.off = withLeak(state.off);
    state.tampered = true;
    const { outcome, repro } = await refresh();
    toast(`Added one identifiable page_view + receipt to OFF evidence → ${outcome} · sealed report ${repro}`);
  });
  byId("vf-evaluate").addEventListener("click", async () => {
    const { outcome } = await refresh();
    toast(`Evaluated current evidence: ${outcome}`);
  });
  byId("vf-check").addEventListener("click", async () => {
    const check = await checkGate(state.sealed, state.off, state.on);
    await refresh();
    toast(`Loaded report vs current evidence: ${check.status}`);
  });
  byId("vf-seal").addEventListener("click", () => {
    void seal();
  });
  byId("vf-reset").addEventListener("click", async () => {
    state.off = freshOff();
    state.on = freshOn();
    state.tampered = false;
    state.sealed = await createGateReport(runGate(state.off, state.on));
    await refresh();
    toast("Reset to the passing example.");
  });
  byId("vf-dl-json").addEventListener("click", async () => {
    const report = await currentReport();
    if (report === null) {
      toast("No report for invalid evidence.");
      return;
    }
    download("promiseproof-report.json", serializeReportJson(report), "application/json");
  });
  byId("vf-dl-md").addEventListener("click", async () => {
    const report = await currentReport();
    if (report === null) {
      toast("No report for invalid evidence.");
      return;
    }
    download("promiseproof-report.md", serializeGateReportMarkdown(report), "text/markdown");
  });

  wireFile("vf-file-off", "vf-drop-off", "vf-name-off", (text) => {
    byoOffText = text;
  });
  wireFile("vf-file-on", "vf-drop-on", "vf-name-on", (text) => {
    byoOnText = text;
  });
  byId("vf-byo-run").addEventListener("click", () => {
    void runByo();
  });
  byId("vf-byo-clear").addEventListener("click", () => {
    byoOffText = null;
    byoOnText = null;
    byId("vf-name-off").textContent = "";
    byId("vf-name-on").textContent = "";
    byId<HTMLInputElement>("vf-file-off").value = "";
    byId<HTMLInputElement>("vf-file-on").value = "";
    byId("vf-byo-result").hidden = true;
  });

  await refresh();
}

void init();
