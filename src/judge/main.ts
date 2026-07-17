import "./styles.css";

import {
  loadJudgeData,
  REPLAY_TITLES,
  TIMELINE_TITLES,
  type JudgeData,
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
  options: {
    readonly lede?: string;
    readonly titleTestId?: string;
    readonly aside?: HTMLElement;
  } = {},
): HTMLElement {
  const header = element("header", "stage-header");
  const main = element("div", "stage-head-main");
  main.append(element("p", "stage-eyebrow", eyebrow));
  const title1 = element("h1", "stage-title", title);
  if (options.titleTestId !== undefined) {
    title1.dataset.testid = options.titleTestId;
  }
  main.append(title1);
  if (options.lede !== undefined) {
    main.append(element("p", "stage-lede", options.lede));
  }
  header.append(main);
  if (options.aside !== undefined) {
    header.append(options.aside);
  }
  return header;
}

function provenanceTag(text: string, testId: string): HTMLElement {
  const tag = element("p", "provenance-tag", text);
  tag.dataset.testid = testId;
  return tag;
}

function arrow(text: string, className: string): HTMLElement {
  const node = element("span", className, text);
  node.setAttribute("aria-hidden", "true");
  return node;
}

/* ------------------------------ Observe ------------------------------ */

function causalBeat(input: {
  readonly variant: "neutral" | "breach" | "result";
  readonly eyebrow: string;
  readonly value: string;
  readonly note: string;
  readonly testId?: string;
  readonly valueTestId?: string;
  readonly code?: string;
  readonly codeTestId?: string;
}): HTMLElement {
  const beat = element("div", `seq-beat seq-beat-${input.variant}`);
  if (input.testId !== undefined) {
    beat.dataset.testid = input.testId;
  }
  beat.append(element("p", "seq-eyebrow", input.eyebrow));
  const value = element("p", "seq-value", input.value);
  if (input.valueTestId !== undefined) {
    value.dataset.testid = input.valueTestId;
  }
  beat.append(value);
  if (input.code !== undefined) {
    const code = element("code", "verdict-code", input.code);
    if (input.codeTestId !== undefined) {
      code.dataset.testid = input.codeTestId;
    }
    beat.append(code);
  } else {
    beat.append(element("p", "seq-note", input.note));
  }
  return beat;
}

function renderObserve(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-observe");
  section.append(
    stageHeader(
      "Observe",
      "Personalization was OFF. Identifiable activity still reached recommendations.",
    ),
  );

  // Three-beat causal sequence: OFF → 1 crossed → BROKEN PROMISE.
  const sequence = element("div", "observe-sequence");
  sequence.dataset.testid = "observe-sequence";
  sequence.append(
    causalBeat({
      variant: "neutral",
      eyebrow: "Personalization",
      value: data.bundle.observedContradiction.scenario.toUpperCase(),
      note: "chosen by the user · survives reload",
      testId: "observe-beat-off",
    }),
  );
  sequence.append(arrow("→", "seq-arrow"));
  sequence.append(
    causalBeat({
      variant: "breach",
      eyebrow: "Identifiable activity",
      value: String(data.raceFacts.identifiableActivityRequests),
      note: "crossed the service boundary while OFF",
      valueTestId: "observe-activity-count",
    }),
  );
  sequence.append(arrow("→", "seq-arrow seq-arrow-breach"));
  const verdict = causalBeat({
    variant: "result",
    eyebrow: "Result",
    value: "BROKEN PROMISE",
    note: "",
    testId: "observe-verdict",
    code: data.bundle.observedContradiction.violationCode,
    codeTestId: "observe-violation-code",
  });
  sequence.append(verdict);
  section.append(sequence);

  // Compact system map + the negative control side by side.
  const cols = element("div", "observe-cols");
  cols.append(renderBoundaryStrip(data));
  cols.append(renderNegativeControl(data));
  section.append(cols);

  section.append(renderEvidenceBasis(data));
  return section;
}

function renderBoundaryStrip(data: JudgeData): HTMLElement {
  const strip = element("div", "boundary-strip");
  strip.dataset.testid = "observe-boundary";
  strip.append(element("p", "panel-eyebrow", "Where the boundary sits"));

  const row = element("div", "boundary-row");
  const browser = element("div", "boundary-node");
  browser.append(element("p", "boundary-name", "Browser"));
  browser.append(element("p", "boundary-detail", "Signal Shelf · OFF"));

  const preference = element("div", "boundary-node");
  preference.append(element("p", "boundary-name", "Preference state"));
  preference.append(element("p", "boundary-detail", "Stored OFF · Backend OFF"));

  const service = element("div", "boundary-node boundary-node-service");
  service.append(element("p", "boundary-name", "Recommendation service"));
  service.append(
    element(
      "p",
      "boundary-detail",
      `Received ${String(data.raceFacts.identifiableActivityReceipts)} identifiable`,
    ),
  );

  row.append(browser, arrow("→", "boundary-arrow"), preference, arrow("→", "boundary-arrow boundary-arrow-breach"), service);
  strip.append(row);

  const chips = element("div", "state-chips");
  for (const chip of ["Personalization · OFF", "Stored · OFF", "Backend · OFF"]) {
    chips.append(element("span", "state-chip", chip));
  }
  const breach = element(
    "span",
    "state-chip state-chip-breach",
    `Identifiable activity · ${String(data.raceFacts.identifiableActivityRequests)} ✕`,
  );
  chips.append(breach);
  strip.append(chips);
  return strip;
}

function renderNegativeControl(data: JudgeData): HTMLElement {
  const card = element("div", "control-card");
  card.dataset.testid = "observe-feed-note";
  const head = element("div", "control-head");
  const check = element("span", "control-check", "✓");
  check.setAttribute("aria-hidden", "true");
  head.append(check);
  head.append(element("p", "control-title", "Contextual recommendations kept working"));
  card.append(head);
  card.append(
    element(
      "p",
      "control-body",
      "The OFF experience still served a working contextual feed — a boundary that let identifiable activity through, not a broken feature.",
    ),
  );
  card.append(
    element("p", "source-note", `${data.feedClause} · negative control · passed`),
  );
  return card;
}

function renderEvidenceBasis(data: JudgeData): HTMLElement {
  const details = element("details", "evidence-basis");
  details.dataset.testid = "observe-evidence-basis";
  details.append(
    element("summary", "evidence-summary", "Evidence basis · clause IDs & sources"),
  );
  const list = element("div", "evidence-list");

  const promise = element("div", "evidence-row");
  promise.append(element("span", "evidence-row-label", "Canonical promise"));
  promise.append(element("span", "evidence-row-value", data.bundle.canonicalPromise));
  list.append(promise);

  for (const row of data.observeRows) {
    const item = element("div", "evidence-row");
    item.dataset.testid = "observe-row";
    item.dataset.state = row.state;
    item.append(element("span", "evidence-row-label", row.label));
    const value = element("span", "evidence-row-value");
    value.dataset.testid = `observe-value-${row.state}`;
    value.textContent = row.value;
    const source = element("span", "evidence-row-source", row.source);
    item.append(value, source);
    list.append(item);
  }
  details.append(list);
  return details;
}

/* ---------------------------- Investigate ---------------------------- */

const HYPOTHESIS_LABELS = {
  supported: "Selected for replay",
  not_selected: "Competing explanation",
} as const;

function hypothesisCard(hypothesis: {
  readonly id: string;
  readonly statement: string;
  readonly result: "supported" | "not_selected";
}): HTMLElement {
  const card = element("article", "hypothesis-card");
  // The underlying result enum is preserved and still validated; only the
  // rendered label is mapped to a neutral, pre-verdict term.
  card.dataset.result = hypothesis.result;
  card.dataset.testid = "hypothesis-card";

  const head = element("div", "hypothesis-head");
  head.append(element("span", "hypothesis-id", hypothesis.id));
  const status = element(
    "span",
    "hypothesis-status",
    HYPOTHESIS_LABELS[hypothesis.result],
  );
  status.dataset.testid = `hypothesis-status-${hypothesis.result}`;
  head.append(status);

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
      {
        lede: "The deterministic evaluator had already decided the promise was broken. GPT-5.6 received a sanitized dossier and was asked only to rank explanations and choose one registered replay.",
        aside: provenanceTag(
          data.bundle.investigation.label,
          "investigate-provenance",
        ),
      },
    ),
  );

  const fork = element("div", "fork");
  fork.dataset.testid = "investigate-fork";

  const top = element("div", "fork-top");
  top.append(element("span", "fork-top-eyebrow", "Observed contradiction"));
  top.append(
    element(
      "span",
      "fork-top-value",
      `Broken promise · ${data.bundle.observedContradiction.violationCode}`,
    ),
  );
  fork.append(top);
  fork.append(element("p", "fork-split", "↙ two possible boundaries ↘"));

  const cards = element("div", "hypothesis-grid");
  for (const hypothesis of data.bundle.initialHypotheses) {
    cards.append(hypothesisCard(hypothesis));
  }
  fork.append(cards);

  const down = element("div", "fork-down");
  down.append(arrow("↓", "fork-down-arrow"));
  const chip = element("div", "registered-replay");
  chip.dataset.testid = "registered-replay";
  chip.append(element("span", "registered-replay-eyebrow", "Registered replay"));
  chip.append(
    element(
      "span",
      "registered-replay-title",
      REPLAY_TITLES[data.bundle.investigation.selectedReplay],
    ),
  );
  down.append(chip);
  fork.append(down);
  section.append(fork);

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
    element("p", "lane-kind", kind === "model" ? "Model" : "Deterministic code"),
  );
  card.append(element("p", "lane-title", title));
  card.append(element("p", "lane-value", value));
  card.append(element("p", "lane-note", note));
  return card;
}

/* ------------------------------ Replay ------------------------------- */

interface ReplayEventLayout {
  readonly side: "browser" | "service";
  readonly crossing?: boolean;
  readonly tag?: string;
  readonly cardClass: string;
}

const REPLAY_EVENT_LAYOUT: Record<string, ReplayEventLayout> = {
  collector_started: { side: "browser", cardClass: "ppa ppa-e1" },
  identifiable_activity_received: {
    side: "service",
    crossing: true,
    cardClass: "ppa ppa-e2",
  },
  preference_hydration_completed: {
    side: "browser",
    tag: "Hydrated too late",
    cardClass: "ppa ppa-e3",
  },
};

function renderReplay(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-replay");
  section.append(
    stageHeader(
      "Replay",
      "GPT-5.6 selected one registered replay to test the leading explanation.",
      {
        lede: data.bundle.investigation.replayExpectation,
        aside: provenanceTag("Recorded authentic replay", "replay-provenance"),
      },
    ),
  );

  const selected = element("div", "selected-replay");
  selected.dataset.testid = "selected-replay";
  const selectedMain = element("div", "selected-replay-main");
  selectedMain.append(element("p", "selected-replay-eyebrow", "Selected replay"));
  selectedMain.append(
    element(
      "p",
      "selected-replay-title",
      REPLAY_TITLES[data.bundle.investigation.selectedReplay],
    ),
  );
  selected.append(selectedMain);
  selected.append(element("span", "selected-replay-divider"));
  selected.append(
    element(
      "p",
      "selected-replay-note",
      "Deterministic code executed the replay and captured the evidence. The model did not run or verify it.",
    ),
  );
  section.append(selected);

  section.append(renderFlightRecorder(data));
  section.append(renderFlightRecorderCompact(data));
  section.append(renderReplayFinding(data));
  return section;
}

function renderFlightRecorder(data: JudgeData): HTMLElement {
  const rec = element("div", "flight-recorder");
  rec.dataset.testid = "replay-recorder";
  rec.setAttribute("aria-hidden", "true");

  rec.append(element("div", "fr-side fr-side-browser"));
  rec.append(element("div", "fr-side fr-side-service"));
  rec.append(element("div", "fr-boundary"));
  rec.append(element("p", "fr-label fr-label-browser", "Browser side"));
  rec.append(element("p", "fr-label fr-label-service", "Recommendation-service side"));
  rec.append(element("span", "fr-spine ppa ppa-spine"));

  data.bundle.investigation.observedTimeline.forEach((event, index) => {
    const layout = REPLAY_EVENT_LAYOUT[event];
    if (layout === undefined) {
      return;
    }
    const timecode = String(index + 1).padStart(2, "0");

    const rail = element("span", "fr-timecode", timecode);
    rail.dataset.event = event;
    rec.append(rail);

    if (layout.crossing === true) {
      rec.append(element("span", "fr-cross-dot ppa ppa-dot"));
      rec.append(element("span", "fr-cross-line ppa ppa-line"));
      rec.append(element("span", "fr-cross-arrow ppa ppa-arrow"));
    }

    const card = element("div", `fr-event ${layout.cardClass}`);
    card.dataset.event = event;
    card.dataset.side = layout.side;
    card.dataset.testid = "replay-event";
    if (layout.crossing === true) {
      card.dataset.emphasis = "boundary";
    }

    const cardHead = element("div", "fr-event-head");
    cardHead.append(element("span", "fr-event-name", TIMELINE_TITLES[event]));
    if (layout.tag !== undefined) {
      cardHead.append(element("span", "fr-event-tag", layout.tag));
    }
    card.append(cardHead);
    const raw =
      layout.crossing === true ? `${event} · receipt ×${String(data.raceFacts.identifiableActivityReceipts)}` : event;
    card.append(element("code", "fr-event-raw", raw));
    rec.append(card);
  });

  return rec;
}

function renderFlightRecorderCompact(data: JudgeData): HTMLElement {
  const list = element("div", "flight-recorder-compact");
  list.dataset.testid = "replay-recorder-compact";
  data.bundle.investigation.observedTimeline.forEach((event, index) => {
    const layout = REPLAY_EVENT_LAYOUT[event];
    if (layout === undefined) {
      return;
    }
    const item = element("div", "fr-compact-item");
    item.dataset.event = event;
    item.dataset.testid = "replay-event-compact";
    if (layout.crossing === true) {
      item.dataset.emphasis = "boundary";
    }
    const badge =
      layout.crossing === true
        ? `${String(index + 1).padStart(2, "0")} · CROSSED → SERVICE`
        : `${String(index + 1).padStart(2, "0")} · ${layout.side.toUpperCase()}`;
    item.append(element("p", "fr-compact-badge", badge));
    item.append(element("p", "fr-compact-name", TIMELINE_TITLES[event]));
    if (layout.tag !== undefined) {
      item.append(element("p", "fr-compact-tag", layout.tag));
    }
    list.append(item);
  });
  return list;
}

function renderReplayFinding(data: JudgeData): HTMLElement {
  const finding = element("div", "replay-finding ppa ppa-finding");
  finding.dataset.testid = "replay-finding";
  const main = element("div", "replay-finding-main");
  main.append(element("p", "replay-finding-eyebrow", "Startup-order explanation"));
  main.append(element("p", "replay-finding-title", "Supported by recorded replay"));
  finding.append(main);
  finding.append(
    element("p", "replay-finding-recorded", data.bundle.investigation.postReplayResult),
  );
  return finding;
}

/* ------------------------------ Repair ------------------------------- */

function renderRepair(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-repair");
  section.append(
    stageHeader(
      "Repair",
      "Source changes were allowed only after evidence supported the boundary.",
      {
        aside: provenanceTag(data.bundle.repair.label, "repair-provenance"),
      },
    ),
  );

  // Before/after ordering swap is the central visual.
  const swap = element("div", "swap-card");
  swap.dataset.testid = "repair-diff";
  swap.append(
    element("p", "swap-path", `${data.bundle.repair.changedPaths[0]} · initialization order`),
  );
  const columns = element("div", "swap-columns");
  columns.append(codeBlock("Before", ["runStartupCollector()", "hydratePreference()"], "before"));
  const swapMark = element("div", "swap-indicator");
  swapMark.setAttribute("aria-hidden", "true");
  swapMark.append(element("span", "swap-glyph", "⇄"));
  swapMark.append(element("span", "swap-glyph-label", "swap"));
  columns.append(swapMark);
  columns.append(codeBlock("After", ["hydratePreference()", "runStartupCollector()"], "after"));
  swap.append(columns);
  swap.append(
    element(
      "p",
      "swap-caption",
      "The order was the defect. The collector no longer runs before the saved preference is authoritative.",
    ),
  );
  section.append(swap);

  const cols = element("div", "repair-cols");
  cols.append(renderGuardrail(data));
  cols.append(renderProofLock(data));
  section.append(cols);

  section.append(renderPatchEvidence(data));
  return section;
}

function codeBlock(
  title: string,
  lines: readonly string[],
  kind: "before" | "after",
): HTMLElement {
  const block = element("div", "code-block");
  block.dataset.kind = kind;
  block.dataset.testid = `diff-${kind}`;
  block.append(element("p", "code-block-head", title));
  const pre = element("pre", "code-block-pre");
  for (const [index, line] of lines.entries()) {
    const row = element("span", "code-line");
    row.append(element("span", "code-line-no", String(index + 1).padStart(2, "0")));
    row.append(element("span", "code-line-text", line));
    pre.append(row);
  }
  block.append(pre);
  return block;
}

function renderGuardrail(data: JudgeData): HTMLElement {
  const panel = element("div", "guardrail");
  panel.dataset.testid = "repair-guardrail";
  panel.append(element("p", "panel-eyebrow", "Guardrails"));

  const files = guardrailItem(`${String(data.bundle.repair.changedPaths.length)} files changed`);
  panel.append(files);

  const bytes = guardrailItem(
    `${formatBytes(data.bundle.repair.patchBytes)}-byte patch`,
  );
  const bytesValue = bytes.querySelector<HTMLElement>(".guardrail-text");
  if (bytesValue !== null) {
    bytesValue.dataset.testid = "repair-patch-bytes";
    bytesValue.dataset.bytes = String(data.bundle.repair.patchBytes);
  }
  panel.append(bytes);

  // The contract pins `humanApproval` to "approved".
  const approval = guardrailItem("Exact digest approved by a human");
  const approvalText = approval.querySelector<HTMLElement>(".guardrail-text");
  if (approvalText !== null) {
    approvalText.dataset.testid = "repair-approval";
    approvalText.dataset.approval = data.bundle.repair.humanApproval;
  }
  panel.append(approval);

  panel.append(guardrailItem("No automatic merge"));
  panel.append(guardrailItem("Disposable candidate + verification worktrees"));
  return panel;
}

function guardrailItem(text: string): HTMLElement {
  const item = element("div", "guardrail-item");
  const marker = element("span", "guardrail-marker", "▪");
  marker.setAttribute("aria-hidden", "true");
  item.append(marker);
  item.append(element("span", "guardrail-text", text));
  return item;
}

function renderProofLock(data: JudgeData): HTMLElement {
  const card = element("div", "proof-lock");
  card.dataset.testid = "repair-proof-lock";

  // A CSS/HTML-drawn padlock, never an emoji.
  const badge = element("span", "proof-lock-badge");
  badge.setAttribute("aria-hidden", "true");
  const glyph = element("span", "lock-glyph");
  glyph.append(element("span", "lock-shackle"));
  glyph.append(element("span", "lock-body"));
  badge.append(glyph);
  card.append(badge);

  const body = element("div", "proof-lock-body");
  body.append(element("p", "proof-lock-title", "Regression test · proof-lock"));
  const regression = element("code", "proof-lock-path");
  regression.dataset.testid = "repair-regression";
  regression.textContent = data.bundle.repair.changedPaths[1];
  body.append(regression);
  card.append(body);
  return card;
}

function renderPatchEvidence(data: JudgeData): HTMLElement {
  const details = element("details", "evidence-basis");
  details.dataset.testid = "repair-evidence-details";
  details.append(
    element("summary", "evidence-summary", "Patch evidence · hashes & IDs"),
  );
  const list = element("div", "evidence-list");
  list.append(evidenceLine("repairId", data.bundle.repair.repairId));
  list.append(evidenceLine("baseCommit", data.bundle.repair.baseCommit));
  list.append(evidenceLine("patchSha256", data.bundle.repair.patchSha256, "repair-patch-digest"));
  list.append(evidenceLine("changedPaths", data.bundle.repair.changedPaths.join(" · ")));
  details.append(list);
  return details;
}

function evidenceLine(label: string, value: string, testId?: string): HTMLElement {
  const row = element("div", "evidence-row");
  row.append(element("span", "evidence-row-label", label));
  const node = element("span", "evidence-row-value", value);
  if (testId !== undefined) {
    node.dataset.testid = testId;
  }
  row.append(node);
  return row;
}

function formatBytes(value: number): string {
  return value.toLocaleString("en-US");
}

/* ------------------------------- Prove ------------------------------- */

function renderProve(data: JudgeData): HTMLElement {
  const section = element("section", "stage stage-prove");

  const groups = Object.values(data.bundle.verification.matrix);
  const passing = groups.filter((value) => value === "pass").length;

  const aside = element("div", "prove-head-aside");
  const pill = element(
    "span",
    "groups-pill",
    `${String(passing)} / ${String(groups.length)} VERIFICATION GROUPS PASS`,
  );
  pill.dataset.testid = "prove-groups-pill";
  aside.append(pill);
  aside.append(provenanceTag(data.bundle.verification.label, "prove-provenance"));

  section.append(
    stageHeader("Prove", "APPROVED PATCH VERIFIED IN ISOLATION", {
      titleTestId: "prove-headline",
      lede: "The approved patch was applied only in a fresh disposable worktree, then judged by the same Playwright journey and deterministic evaluator used on the broken state.",
      aside,
    }),
  );

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
  const authorityMain = element("div", "authority-main");
  authorityMain.append(element("p", "authority-eyebrow", "Authority"));
  authorityMain.append(
    element("p", "authority-value", "Unchanged Playwright and deterministic evaluator"),
  );
  authority.append(authorityMain);
  const raw = element("code", "authority-code", data.bundle.verification.authority);
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
  const decisive = element(
    "li",
    "attribution-item attribution-decisive",
    "None of them determined PASS.",
  );
  decisive.dataset.testid = "attribution-decisive";
  attribution.append(decisive);
  section.append(attribution);

  const note = element(
    "p",
    "worktree-note",
    "Applied only in a fresh disposable verification worktree. Main intentionally remains seeded-broken.",
  );
  note.dataset.testid = "prove-worktree-note";
  section.append(note);
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
