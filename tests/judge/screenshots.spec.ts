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

test('capture judge stages', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  for (const stage of STAGES) {
    await page.goto(`/judge#${stage}`);
    await expect(page.getByTestId('judge-root')).toHaveAttribute('data-stage', stage);
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
