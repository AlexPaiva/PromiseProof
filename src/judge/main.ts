import "./styles.css";

import {
  loadJudgeData,
  REPLAY_TITLES,
  TIMELINE_TITLES,
  type JudgeData,
  type ObserveRow,
} from "./bundle-contract.js";

type StageId = "observe" | "investigate" | "replay" | "repair" | "prove";

interface Stage {
  readonly id: StageId;
  readonly label: string;
  readonly render: (data: JudgeData) => HTMLElement;
}

const STAGE_ORDER: readonly StageId[] = [
  "observe",
  "investigate",
  "replay",
  "repair",
  "prove",
];

/**
 * Criteria descriptions for each validated verification-matrix key. The PASS
 * value itself is always read from the validated bundle; these strings only
 * name what the unchanged verifier requires for that key.
 */
const MATRIX_ROWS: readonly {
  readonly key: "off" | "reload" | "on" | "browser" | "propagationControl";
  readonly label: string;
  readonly criteria: readonly string[];
}[] = [
  {
    key: "off",
    label: "OFF",
    criteria: ["0 identifiable activity", "Contextual recommendations working"],
  },
  {
    key: "reload",
    label: "RELOAD",
    criteria: ["Preference remains OFF", "0 identifiable activity"],
  },
  {
    key: "on",
    label: "ON",
    criteria: [
      "Expected identifiable activity",
      "Behavioral recommendations working",
    ],
  },
  {
    key: "browser",
    label: "BROWSER",
    criteria: ["0 console errors", "0 page errors"],
  },
  {
    key: "propagationControl",
    label: "CONTROL",
    criteria: ["Propagation defect remains independently detectable"],
  },
];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function required<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) {
    throw new Error(`Judge interface element is missing: ${selector}`);
  }
  return node;
}

function stageHeader(
  eyebrow: string,
  title: string,
  lede?: string,
): HTMLElement {
  const header = element("header", "stage-header");
  header.append(element("p", "stage-eyebrow", eyebrow));
  header.append(element("h1", "stage-title", title));
  if (lede !== undefined) {
    header.append(element("p", "stage-lede", lede));
  }
  return header;
}

function provenanceTag(text: string, testId: string): HTMLElement {
  const tag = element("p", "provenance-tag", text);
  tag.dataset.testid = testId;
  return tag;
}

function sourceNote(text: string): HTMLElement {
  const note = element("p", "source-note", text);
  return note;
}

function observeRow(row: ObserveRow): HTMLElement {
  const item = element("div", "observe-row");
  item.dataset.state = row.state;
  item.dataset.testid = "observe-row";

  const label = element("dt", "observe-label");
  label.append(element("span", "observe-label-text", row.label));
  label.append(sourceNote(row.source));

  const value = element("dd", "observe-value");
  value.dataset.testid = `observe-value-${row.state}`;

  const readout = element("span", "observe-readout", row.value);
  readout.dataset.state = row.state;
  value.append(readout);
  value.append(
    element(
      "span",
      "observe-flag",
      row.state === "leak" ? "Not permitted" : "As chosen",
    ),
  );

  item.append(label, value);
  return item;
}

function renderObserve(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-observe");
  section.append(
    stageHeader(
      "Observe",
      "Personalization was OFF. Identifiable activity still reached recommendations.",
      data.bundle.canonicalPromise,
    ),
  );

  const verdict = element("div", "verdict verdict-broken");
  verdict.dataset.testid = "observe-verdict";
  verdict.append(element("p", "verdict-eyebrow", "Result"));
  // The contract pins `result` to "broken"; validation already rejected anything else.
  verdict.append(element("p", "verdict-value", "BROKEN PROMISE"));
  const code = element("code", "verdict-code");
  code.textContent = data.bundle.observedContradiction.violationCode;
  code.dataset.testid = "observe-violation-code";
  verdict.append(code);

  const rows = element("dl", "observe-rows");
  for (const row of data.observeRows) {
    rows.append(observeRow(row));
  }

  const contradiction = element("div", "observe-grid");
  contradiction.append(rows, verdict);
  section.append(contradiction);

  section.append(renderBoundary(data));

  const feed = element("div", "note-card");
  feed.dataset.testid = "observe-feed-note";
  feed.append(
    element("p", "note-title", "Contextual recommendations kept working"),
  );
  feed.append(
    element(
      "p",
      "note-body",
      "The OFF experience still served a working contextual feed, so this is not a broken feature. It is a boundary that let identifiable activity through.",
    ),
  );
  feed.append(sourceNote(`${data.feedClause} · clause passed`));
  section.append(feed);

  return section;
}

function renderBoundary(data: JudgeData): HTMLElement {
  const wrap = element("div", "boundary");
  wrap.dataset.testid = "observe-boundary";

  const browser = element("div", "boundary-node");
  browser.append(element("p", "boundary-name", "Browser"));
  browser.append(element("p", "boundary-detail", "Signal Shelf · OFF"));

  const preference = element("div", "boundary-node");
  preference.append(element("p", "boundary-name", "Preference state"));
  preference.append(
    element("p", "boundary-detail", "Stored OFF · Backend OFF"),
  );

  const service = element("div", "boundary-node boundary-node-service");
  service.append(element("p", "boundary-name", "Recommendation service"));
  service.append(
    element(
      "p",
      "boundary-detail",
      `Received ${String(data.raceFacts.identifiableActivityReceipts)} identifiable activity`,
    ),
  );

  const crossing = element("div", "boundary-crossing");
  crossing.dataset.testid = "boundary-crossing";
  crossing.append(element("span", "boundary-arrow", "→"));
  crossing.append(
    element(
      "span",
      "boundary-crossing-label",
      "identifiable activity crossed this boundary while the choice was OFF",
    ),
  );

  // The three nodes form one row; the crossing indicator spans beneath them.
  wrap.append(browser, preference, service, crossing);
  return wrap;
}

function hypothesisCard(hypothesis: {
  readonly id: string;
  readonly statement: string;
  readonly result: "supported" | "not_selected";
}): HTMLElement {
  const card = element("article", "hypothesis-card");
  card.dataset.result = hypothesis.result;
  card.dataset.testid = "hypothesis-card";

  const head = element("div", "hypothesis-head");
  const id = element("span", "hypothesis-id", hypothesis.id);
  const status = element(
    "span",
    "hypothesis-status",
    hypothesis.result === "supported" ? "Supported" : "Not selected",
  );
  status.dataset.testid = `hypothesis-status-${hypothesis.result}`;
  head.append(id, status);

  card.append(head);
  card.append(element("p", "hypothesis-statement", hypothesis.statement));
  return card;
}

function renderInvestigate(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-investigate");
  section.append(
    stageHeader(
      "Investigate",
      "More than one boundary could explain the contradiction.",
      "The deterministic evaluator had already decided the promise was broken. GPT-5.6 was given a sanitized dossier and asked only to rank explanations and choose one registered replay.",
    ),
  );
  section.append(
    provenanceTag(data.bundle.investigation.label, "investigate-provenance"),
  );

  const cards = element("div", "hypothesis-grid");
  for (const hypothesis of data.bundle.initialHypotheses) {
    cards.append(hypothesisCard(hypothesis));
  }
  section.append(cards);

  const lanes = element("div", "authority-lanes");
  lanes.dataset.testid = "authority-lanes";
  lanes.append(
    laneCard(
      "Deterministic violation",
      data.bundle.observedContradiction.violationCode,
      "Decided before any model ran.",
      "deterministic",
    ),
  );
  lanes.append(
    laneCard(
      "Model diagnostic proposal",
      "Ranked explanations · one replay request",
      "A proposal only. It cannot decide the outcome.",
      "model",
    ),
  );
  lanes.append(
    laneCard(
      "Final deterministic verdict",
      "Unchanged Playwright and evaluator",
      "Shown at the Prove stage.",
      "deterministic",
    ),
  );
  section.append(lanes);

  return section;
}

function laneCard(
  title: string,
  value: string,
  note: string,
  kind: "deterministic" | "model",
): HTMLElement {
  const card = element("article", "lane-card");
  card.dataset.kind = kind;
  card.append(
    element(
      "p",
      "lane-kind",
      kind === "model" ? "Model" : "Deterministic code",
    ),
  );
  card.append(element("p", "lane-title", title));
  card.append(element("p", "lane-value", value));
  card.append(element("p", "lane-note", note));
  return card;
}

function renderReplay(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-replay");
  section.append(
    stageHeader(
      "Replay",
      "GPT-5.6 selected one registered replay to test the leading explanation.",
      data.bundle.investigation.replayExpectation,
    ),
  );

  const selected = element("div", "selected-replay");
  selected.dataset.testid = "selected-replay";
  selected.append(element("p", "selected-replay-eyebrow", "Selected replay"));
  selected.append(
    element(
      "p",
      "selected-replay-title",
      REPLAY_TITLES[data.bundle.investigation.selectedReplay],
    ),
  );
  selected.append(
    element(
      "p",
      "selected-replay-note",
      "Deterministic code executed the replay and captured the evidence. The model did not run or verify it.",
    ),
  );
  section.append(selected);

  section.append(provenanceTag("Recorded authentic replay", "replay-provenance"));

  const timeline = element("ol", "replay-timeline");
  timeline.dataset.testid = "replay-timeline";
  for (const [index, event] of data.bundle.investigation.observedTimeline.entries()) {
    const item = element("li", "replay-event");
    item.dataset.event = event;
    item.dataset.testid = "replay-event";
    if (event === "identifiable_activity_received") {
      item.dataset.emphasis = "boundary";
    }
    item.append(element("span", "replay-index", String(index + 1).padStart(2, "0")));
    const body = element("span", "replay-body");
    body.append(element("strong", "replay-name", TIMELINE_TITLES[event]));
    body.append(element("code", "replay-raw", event));
    item.append(body);
    timeline.append(item);
  }
  section.append(timeline);

  const finding = element("div", "finding-card");
  finding.dataset.testid = "replay-finding";
  finding.append(element("p", "finding-eyebrow", "What the replay showed"));
  finding.append(
    element(
      "p",
      "finding-body",
      "The replay confirmed that collection began before the saved OFF preference became authoritative.",
    ),
  );
  finding.append(
    element("p", "finding-recorded", data.bundle.investigation.postReplayResult),
  );
  section.append(finding);

  return section;
}

function renderRepair(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-repair");
  section.append(
    stageHeader(
      "Repair",
      "Source changes were allowed only after evidence supported the boundary.",
      "PromiseProof then independently tested both the restricted behavior and the behavior that must keep working.",
    ),
  );
  section.append(provenanceTag(data.bundle.repair.label, "repair-provenance"));

  const facts = element("dl", "repair-facts");
  facts.dataset.testid = "repair-facts";
  facts.append(factRow("Files changed", String(data.bundle.repair.changedPaths.length)));
  facts.append(
    factRow("Patch size", `${String(data.bundle.repair.patchBytes)} bytes`, "repair-patch-bytes"),
  );
  // The contract pins `humanApproval` to "approved"; validation rejected anything else.
  facts.append(factRow("Human approval", "Approved", "repair-approval"));
  facts.append(factRow("Merged to main", "No — never automatic"));
  facts.append(factRow("Environments", "Disposable candidate + verification worktrees"));
  section.append(facts);

  const diff = element("div", "diff-card");
  diff.dataset.testid = "repair-diff";
  diff.append(element("p", "diff-path", data.bundle.repair.changedPaths[0]));
  const columns = element("div", "diff-columns");
  columns.append(diffColumn("Before", ["runStartupCollector()", "hydratePreference()"], "before"));
  columns.append(diffColumn("After", ["hydratePreference()", "runStartupCollector()"], "after"));
  diff.append(columns);
  diff.append(
    element(
      "p",
      "diff-note",
      "The order was the defect. The collector no longer runs before the saved preference is authoritative.",
    ),
  );
  section.append(diff);

  const regression = element("article", "note-card note-card-compact");
  regression.dataset.testid = "repair-regression";
  regression.append(element("p", "note-title", "Added regression test"));
  const path = element("code", "note-code");
  path.textContent = data.bundle.repair.changedPaths[1];
  regression.append(path);
  regression.append(
    element(
      "p",
      "note-body",
      "Runs the real browser journey and fails if collection ever starts before the saved OFF preference is restored.",
    ),
  );
  section.append(regression);

  const evidence = element("details", "evidence-details");
  evidence.dataset.testid = "repair-evidence-details";
  const summary = element("summary", "evidence-summary", "Patch evidence");
  evidence.append(summary);
  const list = element("dl", "evidence-list");
  list.append(factRow("Repair ID", data.bundle.repair.repairId));
  list.append(factRow("Base commit", data.bundle.repair.baseCommit));
  list.append(factRow("Patch SHA-256", data.bundle.repair.patchSha256, "repair-patch-digest"));
  for (const changed of data.bundle.repair.changedPaths) {
    list.append(factRow("Changed path", changed));
  }
  evidence.append(list);
  section.append(evidence);

  return section;
}

function diffColumn(
  title: string,
  lines: readonly string[],
  kind: "before" | "after",
): HTMLElement {
  const column = element("div", "diff-column");
  column.dataset.kind = kind;
  column.dataset.testid = `diff-${kind}`;
  column.append(element("p", "diff-column-title", title));
  const code = element("pre", "diff-code");
  code.textContent = lines.join("\n");
  column.append(code);
  return column;
}

function factRow(label: string, value: string, testId?: string): HTMLElement {
  const row = element("div", "fact-row");
  row.append(element("dt", "fact-label", label));
  const node = element("dd", "fact-value", value);
  if (testId !== undefined) {
    node.dataset.testid = testId;
  }
  row.append(node);
  return row;
}

function renderProve(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-prove");
  section.append(
    stageHeader(
      "Prove",
      "The unchanged verifier decided the result.",
      "The approved patch was applied only in a fresh disposable worktree, then judged by the same Playwright journey and deterministic evaluator used on the broken state.",
    ),
  );
  section.append(provenanceTag(data.bundle.verification.label, "prove-provenance"));

  const matrix = element("div", "matrix");
  matrix.dataset.testid = "verification-matrix";
  for (const row of MATRIX_ROWS) {
    const card = element("article", "matrix-row");
    card.dataset.testid = "matrix-row";
    card.dataset.key = row.key;

    card.append(element("p", "matrix-label", row.label));
    const criteria = element("ul", "matrix-criteria");
    for (const criterion of row.criteria) {
      criteria.append(element("li", "matrix-criterion", criterion));
    }
    card.append(criteria);

    const value = data.bundle.verification.matrix[row.key];
    const badge = element("p", "matrix-badge", value.toUpperCase());
    badge.dataset.value = value;
    badge.dataset.testid = "matrix-badge";
    card.append(badge);
    matrix.append(card);
  }
  section.append(matrix);

  const authority = element("div", "authority");
  authority.dataset.testid = "verification-authority";
  authority.append(element("p", "authority-eyebrow", "Authority"));
  authority.append(
    element(
      "p",
      "authority-value",
      "Unchanged Playwright and deterministic evaluator",
    ),
  );
  const raw = element("code", "authority-code");
  raw.textContent = data.bundle.verification.authority;
  raw.dataset.testid = "authority-code";
  authority.append(raw);
  section.append(authority);

  const attribution = element("ul", "attribution");
  attribution.dataset.testid = "attribution";
  for (const line of [
    "GPT-5.6 proposed the diagnosis.",
    "Codex proposed the repair.",
    "A human approved the exact patch.",
  ]) {
    attribution.append(element("li", "attribution-item", line));
  }
  const decisive = element("li", "attribution-item attribution-decisive", "None of them determined PASS.");
  decisive.dataset.testid = "attribution-decisive";
  attribution.append(decisive);
  section.append(attribution);

  const impact = element("div", "note-card");
  impact.dataset.testid = "impact-statement";
  impact.append(element("p", "note-title", "Why this matters"));
  impact.append(
    element(
      "p",
      "note-body",
      "Product controls often cross UI, browser storage, network requests and backend state. A UI that displays OFF can still permit behavior elsewhere. PromiseProof gives product, QA and platform engineers one evidence trail for locating the inconsistent boundary and verifying that the repair did not disable allowed functionality.",
    ),
  );
  section.append(impact);

  return section;
}

const STAGES: readonly Stage[] = [
  { id: "observe", label: "Observe", render: renderObserve },
  { id: "investigate", label: "Investigate", render: renderInvestigate },
  { id: "replay", label: "Replay", render: renderReplay },
  { id: "repair", label: "Repair", render: renderRepair },
  { id: "prove", label: "Prove", render: renderProve },
];

function isStageId(value: string): value is StageId {
  return (STAGE_ORDER as readonly string[]).includes(value);
}

function stageFromHash(): StageId {
  const raw = window.location.hash.replace(/^#/u, "");
  return isStageId(raw) ? raw : "observe";
}

function start(): void {
  const root = required<HTMLElement>("#judge-root");
  const stageHost = required<HTMLElement>("#judge-stage");
  const navList = required<HTMLOListElement>("#judge-nav-list");
  const previous = required<HTMLButtonElement>("#judge-previous");
  const next = required<HTMLButtonElement>("#judge-next");
  const reset = required<HTMLButtonElement>("#judge-reset");

  const data = loadJudgeData();
  let current: StageId = stageFromHash();

  const navButtons = new Map<StageId, HTMLButtonElement>();
  for (const [index, stage] of STAGES.entries()) {
    const item = element("li", "judge-nav-item");
    const button = element("button", "judge-nav-button");
    button.type = "button";
    button.dataset.stage = stage.id;
    button.dataset.testid = `judge-nav-${stage.id}`;
    button.append(element("span", "judge-nav-index", String(index + 1)));
    button.append(element("span", "judge-nav-label", stage.label));
    button.addEventListener("click", () => {
      show(stage.id);
    });
    item.append(button);
    navList.append(item);
    navButtons.set(stage.id, button);
  }

  function show(stage: StageId, options: { focus?: boolean } = {}): void {
    current = stage;
    const index = STAGE_ORDER.indexOf(stage);
    const definition = STAGES[index];
    if (definition === undefined) {
      return;
    }

    root.dataset.stage = stage;
    stageHost.replaceChildren(definition.render(data));

    for (const [id, button] of navButtons) {
      const isCurrent = id === stage;
      button.dataset.current = String(isCurrent);
      button.setAttribute("aria-current", isCurrent ? "step" : "false");
    }

    previous.disabled = index === 0;
    next.disabled = index === STAGE_ORDER.length - 1;

    if (window.location.hash !== `#${stage}`) {
      window.history.replaceState(null, "", `#${stage}`);
    }
    if (options.focus === true) {
      stageHost.focus();
    }
  }

  function step(delta: number): void {
    const index = STAGE_ORDER.indexOf(current) + delta;
    const target = STAGE_ORDER[index];
    if (target !== undefined) {
      show(target, { focus: true });
    }
  }

  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  reset.addEventListener("click", () => show("observe", { focus: true }));
  window.addEventListener("hashchange", () => show(stageFromHash()));

  show(current);
  root.dataset.ready = "true";
}

start();

export {};
