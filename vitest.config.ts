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
          // fileParallelism:false only guarantees test BODIES don't run concurrently across files - Vitest's
          // fork pool can still prepare (and run setupFiles for) the next file while this file's own afterAll
          // is still tearing down. Every file's setupFiles DROPs and recreates the SAME database, so that
          // overlap intermittently rips the connection out from under the previous file's still-finishing
          // queries ("database ... does not exist" / "it seems to have just been dropped or renamed") - seen
          // on GitHub's runners under load, though it doesn't reproduce reliably on a quieter machine.
          // singleFork pins the whole project to one persistent process, so there is no neighboring fork left
          // to prefetch into and file transitions become fully sequential.
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
