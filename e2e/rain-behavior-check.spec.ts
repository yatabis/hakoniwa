import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function setRange(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((node, next) => {
    const input = node as HTMLInputElement;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function readTotalWater(text: string): number {
  const match = text.match(/world totalWater=([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    throw new Error(`totalWater not found in debug readout: ${text}`);
  }
  return Number(match[1]);
}

test('rain increases total water over time', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);

  await page.getByTestId('debug-toggle').click();
  await page.getByTestId('weather-mode').selectOption('manual');
  await setRange(page, 'manual-cloudiness', 1);
  await setRange(page, 'manual-rain-intensity', 1);
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas bounding box not available');
  }
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);

  await page.waitForTimeout(300);
  const readout = page.getByTestId('debug-readout');
  const before = readTotalWater((await readout.textContent()) ?? '');

  await page.waitForTimeout(2200);
  const after = readTotalWater((await readout.textContent()) ?? '');

  expect(after).toBeGreaterThan(before + 0.05);
});
