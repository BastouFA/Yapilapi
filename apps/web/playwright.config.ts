import { defineConfig, devices } from '@playwright/test';

/**
 * Accessibility and keyboard checks (e2e/). They need a running web app and API:
 * point A11Y_BASE_URL at the web app (default http://localhost:3100); the API is
 * reached through the web app's /api proxy. See docs/accessibility.md.
 */
const baseURL = process.env.A11Y_BASE_URL ?? 'http://localhost:3100';

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
const mobile = { ...devices['Pixel 7'], browserName: 'chromium' as const };

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.output',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
    { name: 'mobile-light', use: { ...mobile, colorScheme: 'light' } },
    { name: 'mobile-dark', use: { ...mobile, colorScheme: 'dark' } },
  ],
});
