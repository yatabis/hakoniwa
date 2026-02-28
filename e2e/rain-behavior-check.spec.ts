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

type WindDiagnostics = {
  atmosphereWindStrength: number;
  atmosphereWindDirection: number;
  atmosphereWindGustiness: number;
  appliedUniformStrength: number;
  appliedUniformSpeed: number;
  appliedUniformGustiness: number;
  rainVisible: boolean;
  rainDriftX: number;
  rainDriftZ: number;
};

async function getWindDiagnostics(page: Page): Promise<WindDiagnostics> {
  const diagnostics = await page.evaluate(() => {
    return window.__hakoniwaDebug?.getWindDiagnostics() ?? null;
  });
  if (!diagnostics) {
    throw new Error('Wind diagnostics API is not available');
  }
  return diagnostics as WindDiagnostics;
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

test('wind force zero disables vegetation sway uniforms', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(800);

  await page.getByTestId('debug-toggle').click();
  await page.getByTestId('wind-mode').selectOption('manual');
  await setRange(page, 'manual-wind-strength', 0);
  await setRange(page, 'manual-wind-gustiness', 1);
  await setRange(page, 'manual-wind-direction', 90);
  await page.waitForTimeout(250);

  const diagnostics = await getWindDiagnostics(page);
  expect(diagnostics.atmosphereWindStrength).toBeCloseTo(0, 4);
  expect(diagnostics.appliedUniformStrength).toBeCloseTo(0, 4);
});

test('wind direction 0 and 180 flips rain drift sign', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(800);

  await page.getByTestId('debug-toggle').click();
  await page.getByTestId('weather-mode').selectOption('manual');
  await setRange(page, 'manual-cloudiness', 1);
  await setRange(page, 'manual-rain-intensity', 1);
  await page.getByTestId('wind-mode').selectOption('manual');
  await setRange(page, 'manual-wind-strength', 1);
  await setRange(page, 'manual-wind-gustiness', 1);

  await setRange(page, 'manual-wind-direction', 0);
  await page.waitForTimeout(300);
  const eastDiagnostics = await getWindDiagnostics(page);

  await setRange(page, 'manual-wind-direction', 180);
  await page.waitForTimeout(300);
  const westDiagnostics = await getWindDiagnostics(page);

  expect(eastDiagnostics.rainVisible).toBeTruthy();
  expect(westDiagnostics.rainVisible).toBeTruthy();
  expect(eastDiagnostics.rainDriftX).toBeGreaterThan(0.05);
  expect(westDiagnostics.rainDriftX).toBeLessThan(-0.05);
});
