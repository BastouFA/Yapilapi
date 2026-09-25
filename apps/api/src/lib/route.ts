import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AppError, forbidden, unauthenticated, type PlatformRole } from '@yapilapi/shared';
import type { AppContext } from './context.js';
import type { AuthContext } from './auth-context.js';
import { resolveAuth } from './session.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type AuthMode = 'public' | 'optional' | 'user' | { staff: readonly PlatformRole[] };

export interface RateLimitSpec {
  limit: number;
  windowSec: number;
  by?: 'ip' | 'user';
}

export interface RouteMeta {
  method: Method;
  url: string;
  summary: string;
  tags: string[];
  auth: AuthMode;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
  rateLimit?: RateLimitSpec;
}

/** All routes registered in this process (deduped) — used to generate the OpenAPI document. */
export const routeRegistry = new Map<string, RouteMeta>();

type NoSchema = z.ZodType<undefined>;
type Out<T extends z.ZodType | undefined> = T extends z.ZodType ? z.output<T> : undefined;

export interface RouteDef<
  A extends AuthMode,
  P extends z.ZodType | undefined,
  Q extends z.ZodType | undefined,
  B extends z.ZodType | undefined,
> extends Omit<RouteMeta, 'auth' | 'params' | 'query' | 'body'> {
  auth: A;
  params?: P;
  query?: Q;
  body?: B;
  handler(args: {
    req: FastifyRequest;
    reply: FastifyReply;
    auth: A extends 'public' | 'optional' ? AuthContext | null : AuthContext;
    params: Out<P>;
    query: Out<Q>;
    body: Out<B>;
  }): Promise<unknown> | unknown;
}

function parse(schema: z.ZodType | undefined, value: unknown, where: string): unknown {
  if (!schema) return undefined;
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('validation_failed', `Invalid ${where}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/**
 * Register a route with the mandatory pipeline: authentication -> authorization (role) ->
 * rate limiting -> input validation -> handler. Authorization of *resources* (ownership,
 * visibility, membership) is the handler's job and is always done server-side.
 */
export function route<
  A extends AuthMode,
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(app: FastifyInstance, ctx: AppContext, def: RouteDef<A, P, Q, B>): void {
  const { handler, ...meta } = def;
  routeRegistry.set(`${def.method} ${def.url}`, meta as RouteMeta);

  app.route({
    method: def.method,
    url: def.url,
    config: { routeMeta: meta },
    handler: async (req, reply) => {
      let auth: AuthContext | null = null;
      if (def.auth !== 'public') {
        auth = await resolveAuth(ctx, req);
        if (def.auth !== 'optional' && !auth) throw unauthenticated();
      }
      if (typeof def.auth === 'object') {
        if (!auth || !def.auth.staff.includes(auth.platformRole))
          throw forbidden('Staff access required');
        if (!auth.mfaVerified)
          throw forbidden('Staff accounts must sign in with multi-factor authentication');
      }

      const rl = def.rateLimit;
      if (rl && ctx.config.RATE_LIMIT_ENABLED) {
        const id = rl.by === 'user' && auth ? `u:${auth.userId}` : `ip:${req.clientIp}`;
        const res = await ctx.limiter.hit(`${def.method}:${def.url}:${id}`, rl.limit, rl.windowSec);
        if (!res.allowed) {
          void reply.header('retry-after', String(res.retryAfterSec));
          throw new AppError('rate_limited', 'Too many requests. Please slow down.', {
            retryAfterSec: res.retryAfterSec,
          });
        }
      }

      const params = parse(def.params, req.params, 'path parameters');
      const query = parse(def.query, req.query, 'query parameters');
      const body = parse(def.body, req.body, 'request body');

      const result = await handler({
        req,
        reply,
        auth: auth as never,
        params: params as Out<P>,
        query: query as Out<Q>,
        body: body as Out<B>,
      });
      if (reply.sent) return reply;
      return result === undefined ? reply.code(204).send() : result;
    },
  });
}

export type { NoSchema };
