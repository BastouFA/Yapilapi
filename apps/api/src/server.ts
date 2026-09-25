import { migrate } from '@yapilapi/database';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') await migrate(config.DATABASE_URL);

const { app, close } = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await close();
    process.exit(0);
  });

await app.listen({ port: config.API_PORT, host: config.API_HOST });
