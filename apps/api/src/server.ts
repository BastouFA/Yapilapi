import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { buildApp } from './app.js';
import { createContext } from './context-factory.js';

loadDotEnv();
const config = loadConfig();
const ctx = createContext(config);
const app = await buildApp(ctx);

const shutdown = async (signal: string) => {
  ctx.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await ctx.pubsub.close();
    await ctx.limiter.close();
    await ctx.db.end();
    process.exit(0);
  } catch (err) {
    ctx.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
