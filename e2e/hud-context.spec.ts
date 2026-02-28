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
