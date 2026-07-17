import { expect, test, type Page } from '@playwright/test';

import bundle from '../../artifacts/judge/judge-bundle.json' with { type: 'json' };

const JUDGE_ROUTE = '/judge';

const STAGES = ['observe', 'investigate', 'replay', 'repair', 'prove'] as const;

type Stage = (typeof STAGES)[number];

interface PageProblems {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

function changedPath(index: number): string {
  const value = bundle.repair.changedPaths[index];
  if (value === undefined) {
    throw new Error(`judge bundle repair.changedPaths[${index}] is missing.`);
  }
  return value;
}

function watchForProblems(page: Page): PageProblems {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  return { consoleErrors, pageErrors };
}

async function openJudge(page: Page, stage?: Stage): Promise<void> {
  const target = stage === undefined ? JUDGE_ROUTE : `${JUDGE_ROUTE}#${stage}`;
  // A hash-only change is a same-document navigation, so goto resolves to null.
  const response = await page.goto(target);
  if (response !== null) {
    expect(response.ok()).toBe(true);
  }
  await expect(page.getByTestId('judge-root')).toHaveAttribute('data-ready', 'true');
  if (stage !== undefined) {
    await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', stage);
  }
}

async function stageText(page: Page): Promise<string> {
  return (await page.getByTestId('judge-stage').innerText()).trim();
}

async function allStageText(page: Page): Promise<string> {
  const chunks: string[] = [];
  for (const stage of STAGES) {
    await openJudge(page, stage);
    chunks.push(await stageText(page));
  }
  return chunks.join('\n');
}

test('serves the judge route with no account and no key', async ({ page }) => {
  const response = await page.goto(JUDGE_ROUTE);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('judge-root')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', 'observe');
});

test('renders all five stages from the strict judge bundle', async ({ page }) => {
  const problems = watchForProblems(page);
  await openJudge(page);

  for (const stage of STAGES) {
    await page.getByTestId(`judge-nav-${stage}`).click();
    await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', stage);
    await expect(page.getByTestId('judge-stage')).toContainText(/\S/);
  }

  // Observe values are read from the validated bundle, not hard-coded prose.
  await openJudge(page, 'observe');
  await expect(page.getByTestId('observe-violation-code')).toHaveText(
    bundle.observedContradiction.violationCode,
  );
  await expect(page.getByTestId('observe-verdict')).toContainText('BROKEN PROMISE');
  await expect(page.getByTestId('observe-beat-off')).toContainText('OFF');
  // The prominent activity count and the collapsed evidence row are the same
  // validated number rendered twice, never invented per view.
  const beatCount = (await page.getByTestId('observe-activity-count').innerText()).trim();
  // The evidence row lives inside a collapsed <details>; read textContent.
  const rowCount = ((await page.getByTestId('observe-value-leak').textContent()) ?? '').trim();
  expect(beatCount).toBe(rowCount);
  expect(Number.parseInt(beatCount, 10)).toBeGreaterThan(0);
  await expect(page.getByTestId('observe-row')).toHaveCount(4);

  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

test('navigation supports next, previous, direct selection and reset', async ({ page }) => {
  await openJudge(page);
  const root = page.getByTestId('judge-root');

  await expect(root).toHaveAttribute('data-stage', 'observe');
  await expect(page.getByTestId('judge-previous')).toBeDisabled();

  await page.getByTestId('judge-next').click();
  await expect(root).toHaveAttribute('data-stage', 'investigate');

  await page.getByTestId('judge-next').click();
  await expect(root).toHaveAttribute('data-stage', 'replay');

  await page.getByTestId('judge-previous').click();
  await expect(root).toHaveAttribute('data-stage', 'investigate');

  await page.getByTestId('judge-nav-prove').click();
  await expect(root).toHaveAttribute('data-stage', 'prove');
  await expect(page.getByTestId('judge-next')).toBeDisabled();

  await page.getByTestId('judge-reset').click();
  await expect(root).toHaveAttribute('data-stage', 'observe');

  // Direct stage selection must be recordable from a URL.
  await openJudge(page, 'replay');
  await expect(root).toHaveAttribute('data-stage', 'replay');
});

test('the highlighted nav step always matches the rendered stage', async ({ page }) => {
  await openJudge(page);
  for (const stage of STAGES) {
    await page.getByTestId(`judge-nav-${stage}`).click();
    // Exactly one step may be current, and it must not lag the stage content.
    const current = await page
      .getByTestId('judge-nav')
      .locator('button[data-current="true"]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.stage ?? ''));
    expect(current).toEqual([stage]);
    await expect(page.getByTestId(`judge-nav-${stage}`)).toHaveAttribute('aria-current', 'step');
  }
});

test('stage controls are keyboard operable and expose focus', async ({ page }) => {
  await openJudge(page);
  const next = page.getByTestId('judge-next');
  await next.focus();
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', 'investigate');
});

test('provenance labels mark recorded material and never claim a live run', async ({ page }) => {
  await openJudge(page, 'investigate');
  await expect(page.getByTestId('investigate-provenance')).toHaveText(
    bundle.investigation.label,
  );
  await expect(page.getByTestId('investigate-provenance')).toContainText('Recorded');

  await openJudge(page, 'replay');
  await expect(page.getByTestId('replay-provenance')).toHaveText('Recorded authentic replay');

  await openJudge(page, 'repair');
  await expect(page.getByTestId('repair-provenance')).toHaveText(bundle.repair.label);
  await expect(page.getByTestId('repair-provenance')).toContainText('Recorded');

  await openJudge(page, 'prove');
  await expect(page.getByTestId('prove-provenance')).toHaveText(bundle.verification.label);

  // Nothing anywhere may present the recorded material as a fresh live session.
  const text = await allStageText(page);
  expect(text).not.toMatch(/\blive (?:run|session|call|model)\b/iu);
  expect(text).not.toMatch(/\b(?:streaming|calling|contacting) (?:gpt|openai|codex)\b/iu);
  expect(text).not.toMatch(/\brunning now\b/iu);
});

test('the offline chip states that no live model call is made', async ({ page }) => {
  await openJudge(page);
  await expect(page.getByTestId('offline-chip')).toContainText('no live model calls');
});

test('Investigate uses neutral pre-verdict labels and never reveals a winner', async ({ page }) => {
  await openJudge(page, 'investigate');

  await expect(page.getByTestId('hypothesis-card')).toHaveCount(
    bundle.initialHypotheses.length,
  );
  for (const hypothesis of bundle.initialHypotheses) {
    await expect(page.getByTestId('hypothesis-card').filter({ hasText: hypothesis.statement })).toHaveCount(1);
  }

  // The underlying result enum is unchanged (proof the map is view-only)...
  await expect(page.locator('.hypothesis-card[data-result="supported"]')).toHaveCount(1);
  await expect(page.locator('.hypothesis-card[data-result="not_selected"]')).toHaveCount(1);
  // ...but the visible label is neutral, not a pre-Replay verdict.
  await expect(page.getByTestId('hypothesis-status-supported')).toHaveText('Selected for replay');
  await expect(page.getByTestId('hypothesis-status-not_selected')).toHaveText('Competing explanation');
  await expect(page.getByTestId('registered-replay')).toContainText('Inspect startup order');

  const text = await stageText(page);
  expect(text).not.toMatch(/\bSupported\b/u);
  expect(text).not.toMatch(/\bNot selected\b/u);
  // "Final deterministic verdict" is a legitimate authority-lane label; a winner
  // is what must not be revealed here.
  expect(text).not.toMatch(/\b(?:rejected|winner)\b/iu);

  // The bundle carries no confidence value, so no percentage may be rendered.
  const all = await allStageText(page);
  expect(all).not.toMatch(/\d+\s?%/u);
  expect(all).not.toMatch(/\bconfidence\b/iu);
  expect(all).not.toMatch(/\bprobability\b/iu);
});

test('replay flight-recorder shows the boundary crossing in recorded order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openJudge(page, 'replay');

  await expect(page.getByTestId('selected-replay')).toContainText('Inspect startup order');
  await expect(page.getByTestId('replay-event')).toHaveCount(
    bundle.investigation.observedTimeline.length,
  );

  const events = await page.getByTestId('replay-event').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.event ?? ''),
  );
  expect(events).toEqual(bundle.investigation.observedTimeline);

  // Event 02 is the money shot: it originates on the browser side and crosses
  // to the recommendation service, drawn with a directional arrowhead.
  const crossing = page.locator('.fr-event[data-emphasis="boundary"]');
  await expect(crossing).toHaveCount(1);
  await expect(crossing).toHaveAttribute('data-event', 'identifiable_activity_received');
  await expect(crossing).toHaveAttribute('data-side', 'service');
  await expect(page.locator('.fr-cross-arrow')).toHaveCount(1);
  await expect(page.locator('.fr-cross-line')).toHaveCount(1);

  await expect(page.getByTestId('replay-finding')).toContainText('Supported by recorded replay');
  await expect(page.getByTestId('replay-finding')).toContainText(
    bundle.investigation.postReplayResult,
  );

  // The replay is executed by deterministic code, never by the model.
  const text = await stageText(page);
  expect(text).not.toMatch(/optimal replay|information gain|proof of causation|mathematically decisive|autonomous root-cause/iu);
});

test('the replay finding is gated behind the recorded reveal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openJudge(page, 'replay');
  // With motion, the finding reveals only after the timeline resolves.
  const delay = await page
    .getByTestId('replay-finding')
    .evaluate((node) => window.getComputedStyle(node).animationDelay);
  expect(Number.parseFloat(delay)).toBeGreaterThan(0.5);

  // With reduced motion, the resolved end-state shows immediately (no animation).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJudge(page, 'replay');
  const reduced = await page
    .getByTestId('replay-finding')
    .evaluate((node) => window.getComputedStyle(node).animationName);
  expect(reduced).toBe('none');
  await expect(page.getByTestId('replay-finding')).toBeVisible();
});

test('repair metadata matches the validated bundle exactly', async ({ page }) => {
  await openJudge(page, 'repair');

  // The order-swap is the primary visual: before runs the collector first,
  // after hydrates first.
  await expect(page.getByTestId('diff-before')).toContainText('runStartupCollector()');
  await expect(page.getByTestId('diff-after')).toContainText('hydratePreference()');

  // Guardrail facts come from the bundle (byte count carried as a data attr so
  // the presentation format never drifts from the validated number).
  await expect(page.getByTestId('repair-patch-bytes')).toHaveAttribute(
    'data-bytes',
    String(bundle.repair.patchBytes),
  );
  await expect(page.getByTestId('repair-patch-bytes')).toContainText('2,311');
  await expect(page.getByTestId('repair-approval')).toHaveAttribute(
    'data-approval',
    bundle.repair.humanApproval,
  );
  await expect(page.getByTestId('repair-regression')).toContainText(changedPath(1));

  // The proof-lock is a drawn padlock, never an emoji.
  await expect(page.getByTestId('repair-proof-lock')).toBeVisible();
  const repairText = await stageText(page);
  expect(repairText).not.toMatch(/[\u{1F500}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F5FF}]/u);

  // The exact digest stays behind progressive disclosure.
  const details = page.getByTestId('repair-evidence-details');
  expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  await expect(page.getByTestId('repair-patch-digest')).toBeHidden();
  await details.locator('summary').click();
  await expect(page.getByTestId('repair-patch-digest')).toHaveText(bundle.repair.patchSha256);
});

test('the final matrix authority is deterministic and no model determines PASS', async ({ page }) => {
  await openJudge(page, 'prove');

  await expect(page.getByTestId('prove-headline')).toHaveText(
    'APPROVED PATCH VERIFIED IN ISOLATION',
  );

  await expect(page.getByTestId('matrix-row')).toHaveCount(5);
  await expect(page.getByTestId('matrix-badge')).toHaveCount(5);
  const badges = await page.getByTestId('matrix-badge').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.value ?? ''),
  );
  expect(badges).toEqual([
    bundle.verification.matrix.off,
    bundle.verification.matrix.reload,
    bundle.verification.matrix.on,
    bundle.verification.matrix.browser,
    bundle.verification.matrix.propagationControl,
  ]);

  // The 5/5 pill is derived from the validated matrix, not hard-coded.
  const groups = Object.values(bundle.verification.matrix);
  const passing = groups.filter((value) => value === 'pass').length;
  await expect(page.getByTestId('prove-groups-pill')).toHaveText(
    `${String(passing)} / ${String(groups.length)} VERIFICATION GROUPS PASS`,
  );

  await expect(page.getByTestId('authority-code')).toHaveText(bundle.verification.authority);
  await expect(page.getByTestId('verification-authority')).toContainText(
    'Unchanged Playwright and deterministic evaluator',
  );
  await expect(page.getByTestId('attribution-decisive')).toHaveText(
    'None of them determined PASS.',
  );

  // PASS must never appear on a model-owned stage.
  for (const stage of ['investigate', 'replay'] as const) {
    await openJudge(page, stage);
    expect(await stageText(page)).not.toMatch(/\b(PASS|FIXED)\b/u);
  }
});

test('Prove does not imply main or production was permanently repaired', async ({ page }) => {
  await openJudge(page, 'prove');
  await expect(page.getByTestId('prove-worktree-note')).toContainText(
    'Main intentionally remains seeded-broken',
  );
  await expect(page.getByTestId('prove-worktree-note')).toContainText(
    'disposable verification worktree',
  );

  const text = await allStageText(page);
  expect(text).not.toMatch(/\bcompliance\b|\bcompliant\b|\bregulatory\b|\bGDPR\b|\bcertif/iu);
  expect(text).not.toMatch(/\bcustomers use\b|\bin production at\b|\bsaves \d/iu);
  // Never claim the deployed app or main branch was fixed for good.
  expect(text).not.toMatch(/\b(?:permanently|production) (?:fixed|repaired)\b/iu);
});

test('exposes no local absolute paths and no secret-shaped values', async ({ page }) => {
  await openJudge(page, 'repair');
  await page.getByTestId('repair-evidence-details').locator('summary').click();
  const text = `${await allStageText(page)}\n${await page.getByTestId('judge-stage').innerText()}`;

  expect(text).not.toMatch(/[A-Za-z]:\\{1,2}Users/u);
  expect(text).not.toMatch(/\/(?:home|Users)\//u);
  expect(text).not.toMatch(/\bsk-[A-Za-z0-9]/u);
  expect(text).not.toMatch(/\bBearer\s+\S/u);
  expect(text).not.toMatch(/\bresp_[a-z0-9]/u);
  expect(text).not.toMatch(/OPENAI_API_KEY|CODEX_HOME|USERPROFILE/u);
});

test('respects reduced motion', async ({ page }) => {
  const problems = watchForProblems(page);
  const transitionSeconds = async (): Promise<number> =>
    Number.parseFloat(
      await page
        .getByTestId('judge-next')
        .evaluate((node) => window.getComputedStyle(node).transitionDuration),
    );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJudge(page);
  // Reduced motion must collapse transitions to an imperceptible duration.
  expect(await transitionSeconds()).toBeLessThanOrEqual(0.001);

  // Contrast: without the preference the transition is real, so the media query
  // is doing the work rather than the rule simply being absent.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openJudge(page);
  expect(await transitionSeconds()).toBeGreaterThan(0.001);

  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

test('has no critical clipping at 1440x900 and emits no page errors', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const stage of STAGES) {
    await openJudge(page, stage);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `stage ${stage} overflows horizontally`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  }

  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

test('does not alter or reach the Signal Shelf application', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      requests.push(url.pathname);
    }
  });

  await openJudge(page);
  for (const stage of STAGES) {
    await page.getByTestId(`judge-nav-${stage}`).click();
  }

  // The judge route is static evidence only: no product or model API traffic.
  expect(requests).toEqual([]);
});
