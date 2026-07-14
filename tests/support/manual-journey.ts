import { expect, type APIRequestContext, type Page } from '@playwright/test';

import type {
  PersonalizationPreference,
  RunEvidenceLedger,
} from '../../src/shared/types.js';
import type { ScenarioIds } from './scenario.js';

export interface ManualJourneyResult {
  totalActivityReceipts: number;
  displayedActivityReceipts: number;
  receiptLabel: string;
  backendPreference: PersonalizationPreference;
  agreement: 'match' | 'mismatch';
  status: 'synced' | 'error';
  browserErrors: string[];
}

export interface ManualRetakeResult {
  totalActivityReceipts: number;
  displayedActivityReceipts: number;
  receiptLabel: string;
}

export async function runManualJourneyWithoutReset(
  page: Page,
  request: APIRequestContext,
  ids: ScenarioIds,
): Promise<ManualJourneyResult> {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    browserErrors.push(`pageerror: ${error.message}`);
  });

  const seed = await request.put(`/api/preferences/${ids.userId}`, {
    data: { preference: 'on', runId: ids.runId },
  });
  expect(seed.ok()).toBe(true);
  const clear = await request.delete(`/api/evidence/${ids.runId}`);
  expect(clear.ok()).toBe(true);

  const navigation = await page.goto(
    `/?runId=${encodeURIComponent(ids.runId)}&userId=${encodeURIComponent(ids.userId)}`,
  );
  expect(navigation?.ok()).toBe(true);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('activity-receipt-count')).toHaveText('1');

  await page.getByTestId('personalization-toggle').click();
  await expect(page.getByTestId('personalization-toggle')).not.toBeChecked();
  await expect(page.getByTestId('recommendation-source')).toHaveAttribute(
    'data-source',
    'contextual',
  );
  await expect(page.getByTestId('personalization-toggle')).toBeEnabled();

  const reload = await page.reload();
  expect(reload?.ok()).toBe(true);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-ready', 'true');

  const ledgerResponse = await request.get(`/api/evidence/${ids.runId}`);
  expect(ledgerResponse.ok()).toBe(true);
  const ledger = (await ledgerResponse.json()) as RunEvidenceLedger;
  const backendPreference = await page
    .getByTestId('backend-preference')
    .getAttribute('data-state');
  const agreement = await page
    .getByTestId('preference-agreement')
    .getAttribute('data-state');
  const status = await page.getByTestId('sync-status').getAttribute('data-state');

  if (backendPreference !== 'on' && backendPreference !== 'off') {
    throw new Error(`Unexpected backend preference: ${String(backendPreference)}`);
  }
  if (agreement !== 'match' && agreement !== 'mismatch') {
    throw new Error(`Unexpected agreement state: ${String(agreement)}`);
  }
  if (status !== 'synced' && status !== 'error') {
    throw new Error(`Unexpected status state: ${String(status)}`);
  }

  return {
    totalActivityReceipts: ledger.activityReceipts.length,
    displayedActivityReceipts: Number(
      await page.getByTestId('activity-receipt-count').innerText(),
    ),
    receiptLabel: (
      await page.locator('#activity-receipt-label').innerText()
    ).trim(),
    backendPreference,
    agreement,
    status,
    browserErrors,
  };
}

export async function runManualRetakeCycle(
  page: Page,
  request: APIRequestContext,
  ids: ScenarioIds,
): Promise<ManualRetakeResult> {
  const toggle = page.getByTestId('personalization-toggle');

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId('recommendation-source')).toHaveAttribute(
    'data-source',
    'behavioral',
  );
  await expect(toggle).toBeEnabled();

  const onReload = await page.reload();
  expect(onReload?.ok()).toBe(true);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-ready', 'true');

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('recommendation-source')).toHaveAttribute(
    'data-source',
    'contextual',
  );
  await expect(toggle).toBeEnabled();

  const offReload = await page.reload();
  expect(offReload?.ok()).toBe(true);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-ready', 'true');

  const ledgerResponse = await request.get(`/api/evidence/${ids.runId}`);
  expect(ledgerResponse.ok()).toBe(true);
  const ledger = (await ledgerResponse.json()) as RunEvidenceLedger;

  return {
    totalActivityReceipts: ledger.activityReceipts.length,
    displayedActivityReceipts: Number(
      await page.getByTestId('activity-receipt-count').innerText(),
    ),
    receiptLabel: (
      await page.locator('#activity-receipt-label').innerText()
    ).trim(),
  };
}
