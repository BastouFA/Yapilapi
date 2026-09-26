// Tracing must start before fastify, pg and ioredis are loaded, so everything else is imported after it.
import { shutdownTracing, startTracing } from './lib/tracing.ts';

await startTracing();
const { migrate } = await import('@yapilapi/database');
const { buildApp } = await import('./app.ts');
const { loadConfig } = await import('./config.ts');

const config = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') await migrate(config.DATABASE_URL);

const { app, close } = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await close();
    await shutdownTracing();
    process.exit(0);
  });

await app.listen({ port: config.API_PORT, host: config.API_HOST });
