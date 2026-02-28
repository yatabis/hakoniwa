import { expect, test } from '@playwright/test';

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

  const readout = page.getByTestId('debug-readout');
  await expect(readout).toContainText('vegetation draw');
  await expect(readout).toContainText('vegetation cell');
  await expect(readout).toContainText('vegetation suit');
});
