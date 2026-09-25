import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, WEB_PORT, WEB_URL } from './support/env';

/**
 * Runs against the real API (private test database) and the production build of the web app.
 * One worker: the API and database are shared and the suite is deliberately light on CPU.
 */
export default defineConfig({
  testDir: './specs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalTeardown: undefined,
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    locale: 'en-GB',
    contextOptions: { reducedMotion: 'reduce' },
    timezoneId: 'Africa/Lagos',
  },
  webServer: [
    {
      command: 'node --import tsx e2e/support/start-api.ts',
      cwd: '..',
      url: `${API_URL}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: `npx next start -p ${WEB_PORT}`,
      cwd: '..',
      url: `${WEB_URL}/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NEXT_PUBLIC_API_URL: API_URL,
        API_INTERNAL_URL: API_URL,
        PORT: String(WEB_PORT),
        HOSTNAME: '127.0.0.1',
      },
    },
  ],
});
void API_PORT;
