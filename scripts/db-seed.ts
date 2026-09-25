/**
 * DEVELOPMENT SEED DATA. Everything created here is fictional and clearly labelled:
 *   - usernames start with `dev_`, e-mails end with `@example.test`, bios say "DEV DATA".
 *   - it goes through the real HTTP API in-process, so every rule (age bands, privacy defaults, audit) applies.
 *   - it refuses to run unless APP_ENV is `development` or `test`.
 * The shared dev password is printed so you can log in. It must never be used anywhere else.
 * Idempotent: users that already exist are reused; a user only gets seed posts if they have none.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { migrate } from '@yapilapi/database';
import { buildApp } from '../apps/api/src/app.js';
import { createContext } from '../apps/api/src/context-factory.js';
import { MemoryEmailSender } from '../apps/api/src/lib/email.js';

loadDotEnv();
process.env.LOG_LEVEL ??= 'warn';
process.env.RATE_LIMIT_ENABLED = 'false'; // dev seeding is a local, trusted bulk operation
const config = loadConfig();
if (config.APP_ENV !== 'development' && config.APP_ENV !== 'test') {
  console.error(`Refusing to seed dev data into APP_ENV=${config.APP_ENV}`);
  process.exit(1);
}

const PASSWORD = 'Dev-Only-Passphrase-42';
const ORIGIN = config.corsAllowedOrigins[0] ?? 'http://localhost:3000';

const ctx = createContext(config, { email: new MemoryEmailSender() });
await migrate(ctx.db);
const app = await buildApp(ctx);
await app.ready();

interface Session {
  token: string;
  id: string;
  username: string;
}

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  token: string | null,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {},
  };
}

async function ensureUser(
  username: string,
  displayName: string,
  birthDate: string,
  bio: string,
): Promise<Session> {
  const email = `${username}@example.test`;
  const reg = await call('POST', '/v1/auth/register', null, {
    email,
    password: PASSWORD,
    username,
    displayName,
    birthDate,
    acceptTerms: true,
    deliver: 'token',
  });
  let token: string;
  let id: string;
  if (reg.status === 201) {
    token = reg.body.token;
    id = reg.body.user.id;
    await call('PATCH', '/v1/profile', token, { bio }).catch(() => undefined);
    (created as Set<string>).add(username);
  } else {
    const login = await call('POST', '/v1/auth/login', null, {
      email,
      password: PASSWORD,
      deliver: 'token',
    });
    if (login.status !== 200)
      throw new Error(
        `cannot create or log in ${username}: ${reg.status} ${JSON.stringify(reg.body)}`,
      );
    token = login.body.token;
    id = login.body.user.id;
  }
  return { token, id, username };
}

const created = new Set<string>();
const people = [
  ['dev_amara', 'Amara (dev)', '1994-03-12', 'DEV DATA: a fictional user for local development.'],
  ['dev_kwame', 'Kwame (dev)', '1990-07-01', 'DEV DATA: a fictional user for local development.'],
  ['dev_lin', 'Lin (dev)', '1998-11-23', 'DEV DATA: a fictional user for local development.'],
  ['dev_sofia', 'Sofia (dev)', '1988-01-30', 'DEV DATA: a fictional user for local development.'],
] as const;

const sessions: Session[] = [];
for (const [u, n, b, bio] of people) sessions.push(await ensureUser(u, n, b, bio));

const [amara, kwame, lin, sofia] = sessions as [Session, Session, Session, Session];

for (const a of sessions) {
  for (const b of sessions) {
    if (a.id !== b.id) await call('PUT', `/v1/users/${b.username}/follow`, a.token);
  }
}
await call('POST', '/v1/friends/requests', amara.token, { username: kwame.username });
await call('POST', '/v1/friends/requests', kwame.token, { username: amara.username });

const posts: Array<[Session, string]> = [
  [amara, 'DEV DATA: hello YAPILAPI! Testing the For You feed. #dev'],
  [kwame, 'DEV DATA: first post from a fictional user. Reactions and comments welcome.'],
  [lin, 'DEV DATA: what is everyone building this weekend?'],
  [
    sofia,
    'DEV DATA: a longer fictional post to check wrapping, links and layout on small screens.',
  ],
];
for (const [s, body] of posts) {
  const { rows } = await ctx.db.query('SELECT 1 FROM posts WHERE author_id = $1 LIMIT 1', [s.id]);
  if (rows.length === 0) {
    const r = await call('POST', '/v1/posts', s.token, { body, visibility: 'public' });
    if (r.status !== 201)
      console.warn(`post for ${s.username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

const community = await call('POST', '/v1/communities', amara.token, {
  name: 'Dev Builders',
  slug: 'dev-builders',
  description: 'DEV DATA: a fictional community for local development.',
});
if (community.status === 201) console.log('created community dev-builders');

console.log(
  `\nSeeded ${sessions.length} dev users (${created.size} new). Log in with e-mail <username>@example.test`,
);
console.log(`Shared DEV-ONLY password: ${PASSWORD}`);
console.log('Usernames:', people.map((p) => p[0]).join(', '));

await app.close();
await ctx.pubsub.close();
await ctx.db.end();

// Some subsystems keep timers/connections open; the seed is a one-shot CLI.
process.exit(0);
