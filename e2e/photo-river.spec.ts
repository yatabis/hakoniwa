import { expect, test } from '@playwright/test';

test('photo mode hides hud and restores previous interaction mode', async ({ page }) => {
  await page.goto('/');

  const hud = page.locator('.hud');
  const overlay = page.getByTestId('photo-overlay');
  const cameraButton = page.getByTestId('camera-mode');

  await expect(hud).toBeVisible();
  await expect(cameraButton).not.toHaveClass(/active/);

  await page.keyboard.press('P');
  await expect(hud).toBeHidden();
  await expect(overlay).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect(hud).toBeVisible();
  await expect(cameraButton).not.toHaveClass(/active/);
});

test('photo mode preserves camera mode and river guide toggles', async ({ page }) => {
  await page.goto('/');

  const overlay = page.getByTestId('photo-overlay');
  const cameraButton = page.getByTestId('camera-mode');

  await page.keyboard.press('0');
  await expect(cameraButton).toHaveClass(/active/);

  await page.keyboard.press('P');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('R river guide: ON');

  await page.keyboard.press('R');
  await expect(overlay).toContainText('R river guide: OFF');

  await page.keyboard.press('R');
  await expect(overlay).toContainText('R river guide: ON');

  await page.keyboard.press('Escape');
  await expect(cameraButton).toHaveClass(/active/);
});
