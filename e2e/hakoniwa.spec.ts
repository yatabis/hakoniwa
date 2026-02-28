import { expect, test } from '@playwright/test';

test('terrain edit, source placement, save and load flow', async ({ page }) => {
  await page.goto('/');

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas bounding box not available');
  }

  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 36, centerY + 24);
  await page.mouse.up();

  await page.keyboard.press('4');
  await page.mouse.click(centerX, centerY);

  await page.getByTestId('save-slot-1').click();
  await expect(page.getByTestId('hud-status')).toContainText('Saved slot 1');

  await page.reload();

  await page.getByTestId('load-slot-1').click();
  await expect(page.getByTestId('hud-status')).toContainText('Loaded slot 1');
});
