import { randomBytes } from 'node:crypto';
import type { TestApp, TestUser } from './helpers.js';

/** Make `a` and `b` friends through the real API (the teen must initiate when ages differ). */
export async function befriend(a: TestUser, b: TestUser): Promise<void> {
  const r = await a.client.post('/v1/friends/requests', { username: b.username });
  if (r.status === 201) {
    const acc = await b.client.post(`/v1/friends/requests/${a.id}/accept`);
    if (acc.status !== 200)
      throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  } else if (r.status !== 200)
    throw new Error(`friend request failed ${r.status} ${JSON.stringify(r.body)}`);
}

export async function follow(a: TestUser, b: TestUser): Promise<void> {
  const r = await a.client.put(`/v1/users/${b.username}/follow`);
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`follow failed ${r.status} ${JSON.stringify(r.body)}`);
}

export async function block(a: TestUser, b: TestUser): Promise<void> {
  const r = await a.client.put(`/v1/users/${b.username}/block`);
  if (r.status >= 300) throw new Error(`block failed ${r.status} ${JSON.stringify(r.body)}`);
}

/** Insert a ready, world-readable image owned by `owner` (the upload pipeline itself is the media module's job). */
export async function insertImage(
  t: TestApp,
  ownerId: string,
  over: { status?: string; purpose?: string; kind?: string } = {},
): Promise<string> {
  const { rows } = await t.ctx.db.query<{ id: string }>(
    `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status, purpose) VALUES ($1,$2,$3,'image/jpeg',1000,$4,$5) RETURNING id`,
    [
      ownerId,
      over.kind ?? 'image',
      `test/${randomBytes(8).toString('hex')}.jpg`,
      over.status ?? 'ready',
      over.purpose ?? 'public',
    ],
  );
  return rows[0]!.id;
}

export const inDays = (days: number, hours = 0): string =>
  new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();
export const notifCount = async (t: TestApp, userId: string, kind: string): Promise<number> =>
  Number(
    (
      await t.ctx.db.query(
        'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2',
        [userId, kind],
      )
    ).rows[0].n,
  );
export const auditCount = async (t: TestApp, action: string, targetId: string): Promise<number> =>
  Number(
    (
      await t.ctx.db.query(
        'SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2',
        [action, targetId],
      )
    ).rows[0].n,
  );
export const teenBirth = (): string => `${new Date().getUTCFullYear() - 15}-02-02`;
