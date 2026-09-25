import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../lib/context.js';

export interface ApiModule {
  name: string;
  register(app: FastifyInstance, ctx: AppContext): void | Promise<void>;
}
