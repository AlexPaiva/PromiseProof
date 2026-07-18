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
    criteria: [
      "Second, unrelated seeded bug still caught",
      "the write that does not stick, still flagged",
    ],
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

const STAGE_COUNT = 5;

function stageHeader(
  eyebrow: string,
  title: string,
  options: {
    readonly step?: number;
    readonly lede?: string;
    readonly titleTestId?: string;
    readonly aside?: HTMLElement;
  } = {},
): HTMLElement {
  const header = element("header", "stage-header");
  const main = element("div", "stage-head-main");

  const eyebrowRow = element("p", "stage-eyebrow");
  if (options.step !== undefined) {
    eyebrowRow.append(
      element(
        "span",
        "stage-step",
        `Step ${String(options.step)} / ${String(STAGE_COUNT)}`,
      ),
    );
  }
  eyebrowRow.append(element("span", "stage-eyebrow-label", eyebrow));
  main.append(eyebrowRow);

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

function provenanceTag(
  text: string,
  testId: string,
  explanation?: string,
): HTMLElement {
  const tag = element("p", "provenance-tag", text);
  tag.dataset.testid = testId;
  if (explanation === undefined) {
    return tag;
  }
  // The "?" lives beside the badge, not inside it, so the badge keeps its exact
  // recorded-run label while still offering a plain-language explanation.
  const wrap = element("div", "provenance-wrap");
  wrap.append(tag, infoDot(text, explanation, "end"));
  return wrap;
}

const RECORDED_RUN_EXPLANATION =
  "This step really ran once and was recorded with response ids and fingerprints. The page replays that recording, so it never contacts a model while you browse.";

function arrow(text: string, className: string): HTMLElement {
  const node = element("span", className, text);
  node.setAttribute("aria-hidden", "true");
  return node;
}

let infoCounter = 0;

/**
 * A small, keyboard-accessible "?" that reveals a plain-language explanation of
 * a domain term on hover or focus. Hidden by default, so it never clutters a
 * still; it only appears when a presenter hovers it in the walkthrough video.
 */
function infoDot(term: string, explanation: string, align: "start" | "end" = "start"): HTMLElement {
  const wrap = element("span", "info");
  const id = `info-tip-${String((infoCounter += 1))}`;
  const button = element("button", "info-dot", "?");
  button.type = "button";
  button.setAttribute("aria-label", `Explain: ${term}`);
  button.setAttribute("aria-describedby", id);
  const pop = element("span", `info-pop info-pop-${align}`, explanation);
  pop.id = id;
  pop.setAttribute("role", "tooltip");
  wrap.append(button, pop);
  return wrap;
}

function labelWithInfo(
  tag: keyof HTMLElementTagNameMap,
  className: string,
  text: string,
  term: string,
  explanation: string,
  align: "start" | "end" = "start",
): HTMLElement {
  const node = element(tag, className);
  node.append(document.createTextNode(text), infoDot(term, explanation, align));
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

  // Landing frame: a cold judge lands here first, so state what PromiseProof is
  // and its one differentiator before the example, without a separate screen.
  const intro = element("div", "observe-intro");
  intro.append(element("p", "observe-intro-kicker", "What PromiseProof does"));
  const lead = element("p", "observe-intro-lead");
  lead.append(
    document.createTextNode(
      "It proves whether software keeps a promise to its users, and a ",
    ),
    element("strong", "observe-intro-hl", "deterministic test, never a model,"),
    document.createTextNode(" decides pass or fail."),
  );
  intro.append(lead);
  intro.append(
    element(
      "p",
      "observe-intro-sub",
      "Below is one real promise caught being broken, then proven fixed, in five steps. The model can propose the fix; it never gets to grade its own work.",
    ),
  );
  section.append(intro);

  section.append(
    stageHeader(
      "Observe",
      "Personalization was OFF. Identifiable activity still reached recommendations.",
      {
        step: 1,
        lede: "The user's choice was OFF everywhere they could see. Watch what still crossed to the recommendation service.",
      },
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
      note: "The user turned it off, and it stays off after a reload.",
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
  strip.append(
    labelWithInfo(
      "p",
      "panel-eyebrow",
      "Where the boundary sits",
      "Service boundary",
      "The line between the browser and the recommendation service. Identifiable activity crossing it while personalization is OFF is the broken promise.",
    ),
  );

  const row = element("div", "boundary-row");
  const browser = element("div", "boundary-node");
  browser.append(element("p", "boundary-name", "Browser"));
  browser.append(element("p", "boundary-detail", "The app the user sees says OFF"));

  const preference = element("div", "boundary-node");
  preference.append(element("p", "boundary-name", "Saved preference"));
  preference.append(element("p", "boundary-detail", "Storage and backend both say OFF"));

  const service = element("div", "boundary-node boundary-node-service");
  service.append(element("p", "boundary-name", "Recommendation service"));
  service.append(
    element(
      "p",
      "boundary-detail",
      `Still received ${String(data.raceFacts.identifiableActivityReceipts)} identifiable request`,
    ),
  );

  row.append(browser, arrow("→", "boundary-arrow"), preference, arrow("→", "boundary-arrow boundary-arrow-breach"), service);
  strip.append(row);

  const chips = element("div", "state-chips");
  for (const chip of ["Personalization OFF", "Storage OFF", "Backend OFF"]) {
    chips.append(element("span", "state-chip", chip));
  }
  const breach = element(
    "span",
    "state-chip state-chip-breach",
    `${String(data.raceFacts.identifiableActivityRequests)} identifiable request got through`,
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
  head.append(
    labelWithInfo(
      "p",
      "control-title",
      "Contextual recommendations kept working",
      "Contextual recommendations",
      "These are recommendations chosen without any user identity. This is the mode OFF is meant to use, and it kept working.",
    ),
  );
  card.append(head);
  card.append(
    element(
      "p",
      "control-body",
      "So the feature itself is fine. Recommendations still work with personalization off. The only problem is that one identifiable request slipped across the boundary.",
    ),
  );
  card.append(
    element(
      "p",
      "source-note",
      "This is the control that proves a fix cannot simply switch recommendations off.",
    ),
  );
  return card;
}

function renderEvidenceBasis(data: JudgeData): HTMLElement {
  const details = element("details", "evidence-basis");
  details.dataset.testid = "observe-evidence-basis";
  details.append(
    element("summary", "evidence-summary", "Show the underlying checks and sources"),
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
  supported: "Candidate explanation",
  not_selected: "Alternative explanation",
} as const;

function hypothesisCard(hypothesis: {
  readonly id: string;
  readonly statement: string;
  readonly result: "supported" | "not_selected";
}): HTMLElement {
  const card = element("article", "hypothesis-card");
  // The underlying result enum is preserved and still validated; the view does
  // not infer that a particular initial hypothesis was selected before replay.
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
      "Two implementation boundaries can break the same promise.",
      {
        step: 2,
        lede: "The deterministic check already knows the promise broke, but two code paths could explain how. GPT-5.6 ranks the candidates, read only, then asks for one pre-registered replay to gather the evidence. It proposes; it never decides the verdict.",
        aside: provenanceTag(
          data.bundle.investigation.label,
          "investigate-provenance",
          RECORDED_RUN_EXPLANATION,
        ),
      },
    ),
  );

  const fork = element("div", "fork");
  fork.dataset.testid = "investigate-fork";

  const top = element("div", "fork-top");
  top.append(element("span", "fork-top-eyebrow", "What we know"));
  top.append(element("span", "fork-top-value", "The promise is broken"));
  const code = element("code", "fork-top-code");
  code.textContent = data.bundle.observedContradiction.violationCode;
  top.append(code);
  fork.append(top);
  fork.append(element("p", "fork-split", "But two different code paths could explain it"));

  const cards = element("div", "hypothesis-grid");
  for (const hypothesis of data.bundle.initialHypotheses) {
    cards.append(hypothesisCard(hypothesis));
  }
  fork.append(cards);

  const down = element("div", "fork-down");
  down.append(arrow("↓", "fork-down-arrow"));
  const chip = element("div", "registered-replay");
  chip.dataset.testid = "registered-replay";
  chip.append(
    labelWithInfo(
      "span",
      "registered-replay-eyebrow",
      "Registered replay",
      "Registered replay",
      "A small, pre-approved diagnostic the model can ask for by name. It cannot run arbitrary code. Our own code runs the check and records what happened.",
    ),
  );
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
      "Ranked the explanations, asked for one replay",
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
        step: 3,
        lede: data.bundle.investigation.replayExpectation,
        aside: provenanceTag(
          "Recorded authentic replay",
          "replay-provenance",
          RECORDED_RUN_EXPLANATION,
        ),
      },
    ),
  );

  const selected = element("div", "selected-replay");
  selected.dataset.testid = "selected-replay";
  const selectedMain = element("div", "selected-replay-main");
  selectedMain.append(
    labelWithInfo(
      "p",
      "selected-replay-eyebrow",
      "Selected replay",
      "Who runs the replay",
      "The model only names the replay. Our own code runs it and records the order of events. The model never runs or checks it.",
    ),
  );
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

  const toolbar = element("div", "replay-toolbar");
  toolbar.append(
    labelWithInfo(
      "p",
      "replay-toolbar-hint",
      "Watch the request cross before the saved preference finishes loading:",
      "hydration",
      "The timeline below calls this \"hydration\": reading the saved \"off\" preference into the running app before it acts. Here, collection starts before that finishes, so for a moment the app behaves as if personalization were on.",
    ),
  );
  const playAgain = element("button", "replay-again", "Play the crossing");
  playAgain.type = "button";
  playAgain.dataset.testid = "replay-again";
  toolbar.append(playAgain);
  section.append(toolbar);

  // The reveal is a fresh CSS animation on mount, so re-rendering these nodes
  // replays it on demand — the crossing is the one moment judges should see move.
  const slot = element("div", "replay-slot");
  const fill = (): void => {
    slot.replaceChildren(
      renderFlightRecorder(data),
      renderFlightRecorderCompact(data),
      renderReplayFinding(data),
    );
  };
  fill();
  playAgain.addEventListener("click", fill);
  section.append(slot);
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
      layout.crossing === true
        ? `${event}  (${String(data.raceFacts.identifiableActivityReceipts)} receipt recorded)`
        : event;
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
        ? `${String(index + 1).padStart(2, "0")}  crossed to the service`
        : `${String(index + 1).padStart(2, "0")}  ${layout.side}`;
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
        step: 4,
        lede: "Codex could change exactly two files, in a throwaway checkout. The behavioral fix is a two-line reorder; the patch also adds a regression test that locks the order in.",
        aside: provenanceTag(
          data.bundle.repair.label,
          "repair-provenance",
          RECORDED_RUN_EXPLANATION,
        ),
      },
    ),
  );

  // Before/after ordering swap is the central visual.
  const swap = element("div", "swap-card");
  swap.dataset.testid = "repair-diff";
  swap.append(
    element("p", "swap-path", `In ${data.bundle.repair.changedPaths[0]}, the startup order`),
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
  approval.append(
    infoDot(
      "Patch digest",
      "A SHA-256 fingerprint of the exact diff. A human approves this precise hash; any different patch is rejected.",
    ),
  );
  panel.append(approval);

  panel.append(guardrailItem("No automatic merge"));
  const worktrees = guardrailItem("Disposable candidate + verification worktrees");
  worktrees.append(
    infoDot(
      "Disposable worktree",
      "A throwaway Git checkout. The fix is applied and tested there and never touches the main branch.",
    ),
  );
  panel.append(worktrees);
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
  body.append(element("p", "proof-lock-title", "A new regression test locks the fix in"));
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
    element("summary", "evidence-summary", "Show the patch hashes and IDs"),
  );
  const list = element("div", "evidence-list");
  list.append(evidenceLine("repairId", data.bundle.repair.repairId));
  list.append(evidenceLine("baseCommit", data.bundle.repair.baseCommit));
  list.append(evidenceLine("patchSha256", data.bundle.repair.patchSha256, "repair-patch-digest"));
  list.append(evidenceLine("changedPaths", data.bundle.repair.changedPaths.join(", ")));
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
  const pillWrap = element("span", "groups-pill-wrap");
  pillWrap.append(
    pill,
    infoDot(
      "Verification groups",
      "Five independent checks: OFF, reload, ON, zero browser errors, and the second defect left untouched. All five must hold for a green result.",
      "end",
    ),
  );
  aside.append(pillWrap);
  aside.append(
    provenanceTag(
      data.bundle.verification.label,
      "prove-provenance",
      "The check was re-run offline from the pinned repository and produced the same result, so anyone can reproduce it without a network.",
    ),
  );

  section.append(
    stageHeader("Prove", "APPROVED PATCH VERIFIED IN ISOLATION", {
      step: 5,
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
  authorityMain.append(
    labelWithInfo(
      "p",
      "authority-eyebrow",
      "Authority",
      "Unchanged verifier",
      "The same Playwright journey and deterministic evaluator used on the broken state decides the result. No model gets a vote.",
    ),
  );
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

// Per-stage dwell times (ms) for the opt-in cinematic auto-play used to record
// a hands-free walkthrough. Replay dwells longest so its reveal can resolve.
const PLAY_DWELL: Record<StageId, number> = {
  observe: 5200,
  investigate: 6200,
  replay: 9000,
  repair: 6400,
  prove: 8000,
};

const HOW_IT_WORKS: readonly string[] = [
  "PromiseProof checks whether a product keeps a promise it makes to users. Here, someone turned personalization off, so no identifiable activity should reach the recommendation service.",
  "This page is a recording. Nothing on it calls an AI live. GPT-5.6 and Codex already did their work, and you are watching what they did, one step at a time.",
  "GPT-5.6 read the evidence and ranked where the leak might be. Codex proposed a small, tightly limited fix. A human approved the exact patch. Then the same automated tests that caught the bug decided whether the fix actually worked.",
  "The whole point: the AI can propose, but it never gets to declare its own work correct.",
];

function setUpHowItWorks(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>("#judge-how");
  if (button === null) {
    return;
  }

  const modal = element("div", "judge-modal");
  modal.dataset.testid = "judge-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "judge-modal-title");
  modal.hidden = true;

  const backdrop = element("div", "judge-modal-backdrop");
  const card = element("div", "judge-modal-card");
  const heading = element("h2", "judge-modal-title", "How this works");
  heading.id = "judge-modal-title";
  card.append(heading);
  for (const paragraph of HOW_IT_WORKS) {
    card.append(element("p", "judge-modal-text", paragraph));
  }
  const close = element("button", "judge-button judge-button-primary judge-modal-close", "Got it");
  close.type = "button";
  card.append(close);
  modal.append(backdrop, card);
  root.append(modal);

  const setOpen = (open: boolean): void => {
    modal.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      close.focus();
    } else {
      button.focus();
    }
  };

  button.addEventListener("click", () => setOpen(true));
  close.addEventListener("click", () => setOpen(false));
  backdrop.addEventListener("click", () => setOpen(false));
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    // Trap focus inside the dialog while it is open.
    const focusables = Array.from(
      card.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
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

  const autoPlay = new URLSearchParams(window.location.search).get("play") === "1";
  const progress = element("div", "judge-progress");
  progress.dataset.testid = "judge-progress";
  const progressFill = element("div", "judge-progress-fill");
  progress.append(progressFill);
  root.prepend(progress);
  let playing = false;
  let playTimer = 0;

  setUpHowItWorks(root);

  function stopPlaying(): void {
    if (!playing) {
      return;
    }
    playing = false;
    window.clearTimeout(playTimer);
    root.dataset.playing = "false";
    progressFill.style.transition = "none";
    progressFill.style.width = "0%";
  }

  function playTick(stage: StageId): void {
    if (!playing) {
      return;
    }
    const ms = PLAY_DWELL[stage];
    progressFill.style.transition = "none";
    progressFill.style.width = "0%";
    void progressFill.offsetWidth; // reflow so the fill restarts each stage
    progressFill.style.transition = `width ${String(ms)}ms linear`;
    progressFill.style.width = "100%";
    playTimer = window.setTimeout(() => {
      const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
      if (nextStage === undefined) {
        stopPlaying();
        return;
      }
      show(nextStage);
      playTick(nextStage);
    }, ms);
  }

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
      stopPlaying();
      show(stage.id);
    });
    item.append(button);
    navList.append(item);
    navButtons.set(stage.id, button);
  }

  let firstRender = true;
  let swapTimer = 0;

  function renderInto(stage: StageId, focus: boolean): void {
    const definition = STAGES[STAGE_ORDER.indexOf(stage)];
    if (definition === undefined) {
      return;
    }
    stageHost.replaceChildren(definition.render(data));
    // Marks that the DOM now holds THIS stage — the signal transitions settle on.
    root.dataset.rendered = stage;
    if (focus) {
      stageHost.focus();
    }
  }

  function show(stage: StageId, options: { focus?: boolean } = {}): void {
    current = stage;
    const index = STAGE_ORDER.indexOf(stage);
    if (STAGES[index] === undefined) {
      return;
    }

    // Navigation + routing state is applied instantly so the highlighted step
    // never lags the content, even mid-transition.
    root.dataset.stage = stage;
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

    window.clearTimeout(swapTimer);
    const focus = options.focus === true;
    // The stage cross-fade runs on every navigation after the first paint: the
    // old content eases out, the DOM is swapped while invisible, then the new
    // content eases in.
    const animate = !firstRender && stageHost.firstElementChild !== null;
    firstRender = false;

    if (!animate) {
      stageHost.classList.remove("is-leaving", "is-entering");
      renderInto(stage, focus);
      return;
    }

    // Ease the outgoing content out, swap, then ease the incoming content in —
    // a real crossfade instead of a hard cut.
    stageHost.classList.remove("is-entering");
    stageHost.classList.add("is-leaving");
    swapTimer = window.setTimeout(() => {
      renderInto(stage, focus);
      stageHost.classList.remove("is-leaving");
      stageHost.classList.add("is-entering");
      void stageHost.offsetWidth; // commit the entered-from state before releasing
      stageHost.classList.remove("is-entering");
    }, 160);
  }

  function step(delta: number): void {
    const index = STAGE_ORDER.indexOf(current) + delta;
    const target = STAGE_ORDER[index];
    if (target !== undefined) {
      show(target, { focus: true });
    }
  }

  previous.addEventListener("click", () => {
    stopPlaying();
    step(-1);
  });
  next.addEventListener("click", () => {
    stopPlaying();
    step(1);
  });
  reset.addEventListener("click", () => {
    stopPlaying();
    show("observe", { focus: true });
  });
  // The controls ship disabled in static HTML so a blocked/slow bundle never
  // shows working-looking buttons; JS enables them once wired (Previous/Next
  // get their per-stage state from renderInto, Reset is always available now).
  reset.disabled = false;
  window.addEventListener("hashchange", () => show(stageFromHash()));

  if (autoPlay) {
    playing = true;
    root.dataset.playing = "true";
    show("observe");
    playTick("observe");
  } else {
    show(current);
  }
  root.dataset.ready = "true";
}

start();

export {};
