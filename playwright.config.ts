import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--use-gl=angle']
    }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'env -u NO_COLOR pnpm dev --host 127.0.0.1 --port 4173',
    port: 4173,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI
  }
});
