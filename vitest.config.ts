import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/**/src/**/*.unit.test.ts',
            'tests/unit/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'apps/**/test/**/*.test.ts',
            'packages/**/test/**/*.test.ts',
            'tests/integration/**/*.test.ts',
          ],
          environment: 'node',
          env: {
            APP_ENV: 'test',
            NODE_ENV: 'test',
            TEST_DATABASE_URL:
              process.env.TEST_DATABASE_URL ??
              'postgres://yapilapi:yapilapi_dev_password@127.0.0.1:5432/yapilapi_test',
          },
          globalSetup: ['tests/setup/global-setup.ts'],
          setupFiles: ['tests/setup/per-file-db.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
