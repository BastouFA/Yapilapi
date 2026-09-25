import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '@yapilapi/config';
import { buildApp } from '../apps/api/src/app.js';
import { createContext } from '../apps/api/src/context-factory.js';
import { routeRegistry, type RouteMeta } from '../apps/api/src/lib/route.js';

const schemaOf = (s: z.ZodType | undefined) =>
  s
    ? (z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>)
    : undefined;

export function buildOpenApi(routes: RouteMeta[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of [...routes].sort((a, b) => (a.url + a.method).localeCompare(b.url + b.method))) {
    const url = r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const parameters: unknown[] = [];
    const pathProps = (schemaOf(r.params)?.properties ?? {}) as Record<string, unknown>;
    for (const [name, schema] of Object.entries(pathProps))
      parameters.push({ name, in: 'path', required: true, schema });
    const q = schemaOf(r.query);
    for (const [name, schema] of Object.entries((q?.properties ?? {}) as Record<string, unknown>)) {
      parameters.push({
        name,
        in: 'query',
        required: ((q?.required ?? []) as string[]).includes(name),
        schema,
      });
    }
    const security =
      r.auth === 'public'
        ? []
        : r.auth === 'optional'
          ? [{}, { cookieAuth: [] }, { bearerAuth: [] }]
          : [{ cookieAuth: [] }, { bearerAuth: [] }];
    (paths[url] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      tags: r.tags,
      parameters,
      ...(r.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schemaOf(r.body) } },
            },
          }
        : {}),
      responses: {
        '200': { description: 'Success' },
        '400': { $ref: '#/components/responses/Error' },
        ...(r.auth !== 'public' ? { '401': { $ref: '#/components/responses/Error' } } : {}),
        '404': { $ref: '#/components/responses/Error' },
        ...(r.rateLimit ? { '429': { $ref: '#/components/responses/Error' } } : {}),
      },
      security,
      ...(typeof r.auth === 'object' ? { 'x-required-staff-roles': r.auth.staff } : {}),
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'YAPILAPI API', version: '0.1.0', description: 'Your social world. One place.' },
    servers: [{ url: 'http://localhost:4000' }],
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'yl_session',
          description:
            'Browser sessions. Unsafe methods also require the `x-yl-csrf: 1` header and an allowed Origin.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Mobile/API clients (opaque session token).',
        },
      },
      responses: {
        Error: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      message: { type: 'string' },
                      requestId: { type: 'string' },
                      details: {},
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused:unused@127.0.0.1:5432/unused',
    REDIS_URL: '',
    LOG_LEVEL: 'silent',
  });
  const ctx = createContext(config);
  const app = await buildApp(ctx);
  await app.ready();
  const doc = buildOpenApi([...routeRegistry.values()]);
  const out = path.join(process.cwd(), 'docs', 'api', 'openapi.json');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(
    `OpenAPI: ${Object.keys(doc.paths).length} paths -> ${path.relative(process.cwd(), out)}`,
  );
  await app.close();
  await ctx.db.end();
}
