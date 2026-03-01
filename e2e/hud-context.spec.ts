import { expect, test } from '@playwright/test';

function parseLifeActive(readoutText: string, kind: 'birds' | 'insects'): number {
  const pattern =
    kind === 'birds' ? /life birds total=\d+ active=(\d+)/ : /life insects total=\d+ active=(\d+)/;
  const match = readoutText.match(pattern);
  if (!match || !match[1]) {
    throw new Error(`Unable to parse ${kind} activity from debug readout`);
  }
  return Number(match[1]);
}

test('contextual sliders follow active mode', async ({ page }) => {
  await page.goto('/');

  const strengthRow = page.locator('.control-row', { hasText: 'Strength' });
  const flattenRow = page.locator('.control-row', { hasText: 'Flatten' });
  const sourceRow = page.locator('.control-row', { hasText: 'Source/s' });

  await expect(strengthRow).toBeVisible();
  await expect(flattenRow).toBeHidden();
  await expect(sourceRow).toBeHidden();

  await page.keyboard.press('3');
  await expect(strengthRow).toBeVisible();
  await expect(flattenRow).toBeVisible();
  await expect(sourceRow).toBeHidden();

  await page.keyboard.press('4');
  await expect(strengthRow).toBeHidden();
  await expect(flattenRow).toBeHidden();
  await expect(sourceRow).toBeVisible();

  await page.keyboard.press('0');
  await expect(strengthRow).toBeHidden();
  await expect(flattenRow).toBeHidden();
  await expect(sourceRow).toBeHidden();

  await page.keyboard.press('1');
  await expect(strengthRow).toBeVisible();
  await expect(flattenRow).toBeHidden();
  await expect(sourceRow).toBeHidden();
});

test('debug readout includes vegetation diagnostics', async ({ page }) => {
  await page.goto('/');

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas bounding box not available');
  }

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.getByTestId('debug-toggle').click();
  await page.getByTestId('debug-readout-tab-life').click();
  await page.getByTestId('debug-readout-expand').click();

  const readout = page.getByTestId('debug-readout');
  await expect(readout).toContainText('vegetation draw');
  await expect(readout).toContainText('vegetation cell');
  await expect(readout).toContainText('vegetation suit');
  await expect(readout).toContainText('life birds');
  await expect(readout).toContainText('life insects');
});

test('audio can be toggled from HUD button and keyboard', async ({ page }) => {
  await page.goto('/');

  const audioToggle = page.getByTestId('audio-toggle');
  await expect(audioToggle).toHaveText('M Audio: ON');

  await audioToggle.click();
  await expect(audioToggle).toHaveText('M Audio: OFF');

  await page.keyboard.press('M');
  await expect(audioToggle).toHaveText('M Audio: ON');
});

test('heavy rain reduces bird activity in debug readout', async ({ page }) => {
  await page.goto('/');

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas bounding box not available');
  }
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);

  await page.getByTestId('debug-toggle').click();
  await page.getByTestId('debug-tab-weather').click();
  await page.getByTestId('weather-mode').selectOption('manual');
  await page.getByTestId('manual-rain-intensity').evaluate((node) => {
    const input = node as HTMLInputElement;
    input.value = '0.00';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(650);

  const readout = page.getByTestId('debug-readout');
  const calmText = (await readout.textContent()) ?? '';
  const calmBirds = parseLifeActive(calmText, 'birds');

  await page.getByTestId('manual-rain-intensity').evaluate((node) => {
    const input = node as HTMLInputElement;
    input.value = '1.00';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  const stormText = (await readout.textContent()) ?? '';
  const stormBirds = parseLifeActive(stormText, 'birds');

  expect(stormBirds).toBeLessThan(calmBirds);

  await page.getByTestId('debug-toggle').click();
  await expect(readout).toBeHidden();
});
