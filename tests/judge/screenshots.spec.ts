import path from 'node:path';

import { test, expect } from '@playwright/test';

// Capture harness for judge-experience review and submission stills. Run with
// `npm run test:judge:screenshots`. Output goes to the ignored test-results tree
// and is never committed.
const OUT = path.resolve('test-results/judge-screenshots');

const DESKTOP = { width: 1440, height: 900 } as const;
const VIDEO = { width: 1920, height: 1080 } as const;
const MOBILE = { width: 390, height: 844 } as const;

const STAGES = ['observe', 'investigate', 'replay', 'repair', 'prove'] as const;

async function settleStage(page: import('@playwright/test').Page): Promise<void> {
  const host = page.getByTestId('judge-stage');
  // Wait for the crossfade to finish, then for every remaining animation/
  // transition in the stage (including the Replay reveal) to resolve.
  await expect(host).not.toHaveClass(/is-leaving|is-entering/u);
  await host.evaluate((node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

async function settleReplayReveal(page: import('@playwright/test').Page): Promise<void> {
  // The Replay reveal is a one-time timed animation; wait for the resolved frame.
  await page
    .getByTestId('replay-finding')
    .evaluate(
      (node) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            if (window.getComputedStyle(node).opacity === '1') {
              resolve();
            } else {
              window.requestAnimationFrame(done);
            }
          };
          done();
        }),
    );
}

test('capture judge stages', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  for (const stage of STAGES) {
    await page.goto(`/judge#${stage}`);
    await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', stage);
    await expect(page.getByTestId('judge-root')).toHaveAttribute('data-rendered', stage);
    await settleStage(page);
    if (stage === 'replay') {
      await settleReplayReveal(page);
    }
    await page.screenshot({ path: path.join(OUT, `${stage}-1440x900.png`) });
  }

  await page.setViewportSize(VIDEO);
  await page.goto('/judge#prove');
  await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', 'prove');
  await page.screenshot({ path: path.join(OUT, 'prove-1920x1080.png') });

  await page.setViewportSize(MOBILE);
  await page.goto('/judge#observe');
  await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', 'observe');
  await page.screenshot({ path: path.join(OUT, 'observe-mobile.png'), fullPage: true });
});
