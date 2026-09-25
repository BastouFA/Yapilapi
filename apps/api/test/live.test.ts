import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  Client,
  ORIGIN,
  createTestApp,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { block, follow, teenBirth } from './entity-helpers.js';
import { idem, key, mkProduct, okToken } from './commerce-fixtures.js';
import {
  assertLiveGiftable,
  liveSocketSettings,
  overrideLiveRuntime,
  runLiveMaintenance,
  type IngestProvider,
} from '../src/modules/live/index.js';

let t: TestApp;
let port = 0;
let admin: TestUser;
let mod: TestUser;
let flagDefault = true;
beforeAll(async () => {
  t = await createTestApp();
  flagDefault = (await t.ctx.db.query(`SELECT enabled FROM feature_flags WHERE key = 'LIVE'`))
    .rows[0].enabled;
  await t.ctx.db.query(
    `UPDATE feature_flags SET enabled = true, rollout_pct = 100 WHERE key = 'LIVE'`,
  );
  t.ctx.flags.invalidate();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as { port: number }).port;
  admin = await signup(t);
  await makeStaff(t, admin, 'admin');
  mod = await signup(t);
  await makeStaff(t, mod, 'moderator');
});
afterAll(async () => {
  await t.close();
});

const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);
const n = async (q: string, p: unknown[] = []): Promise<number> =>
  Number((await sql(q, p)).rows[0].n);
const anon = () => new Client(t);
const auditN = (action: string, targetId?: string) =>
  n(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR target_id::text = $2)`,
    [action, targetId ?? null],
  );
const setFlag = async (flag: string, enabled: boolean) => {
  await sql(`UPDATE feature_flags SET enabled = $2, rollout_pct = 100 WHERE key = $1`, [
    flag,
    enabled,
  ]);
  t.ctx.flags.invalidate();
};
const TERMS = '2027-01';

async function mkLive(
  host: TestUser,
  over: Record<string, unknown> = {},
  start = false,
): Promise<any> {
  const r = await host.client.post('/v1/live', {
    title: `Live ${uniq('l')}`,
    visibility: 'public',
    mediaMode: 'interactive',
    ...over,
  });
  if (r.status !== 201) throw new Error(`create live failed ${r.status} ${JSON.stringify(r.body)}`);
  if (start) {
    const s = await host.client.post(`/v1/live/${r.body.id}/start`);
    if (s.status !== 200) throw new Error(`start failed ${s.status} ${JSON.stringify(s.body)}`);
    return s.body.session;
  }
  return r.body;
}
const join = (u: TestUser, id: string) => u.client.post(`/v1/live/${id}/join`);
async function joined(u: TestUser, id: string): Promise<TestUser> {
  const r = await join(u, id);
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
  return u;
}
const appoint = async (host: TestUser, id: string, u: TestUser, role: 'cohost' | 'moderator') => {
  const r = await host.client.put(`/v1/live/${id}/team/${u.id}`, { role });
  if (r.status !== 200) throw new Error(`appoint failed ${r.status} ${JSON.stringify(r.body)}`);
};
const say = (u: TestUser, id: string, body: string) =>
  u.client.post(`/v1/live/${id}/messages`, { body });
const viewers = async (id: string) =>
  (await sql('SELECT viewer_count, peak_viewers FROM live_sessions WHERE id = $1', [id]))
    .rows[0] as { viewer_count: number; peak_viewers: number };

async function mkCreator(): Promise<TestUser> {
  const u = await signup(t);
  const r = await u.client.post('/v1/creator/join', { termsVersion: TERMS, category: 'music' });
  if (r.status !== 201)
    throw new Error(`creator join failed ${r.status} ${JSON.stringify(r.body)}`);
  return u;
}
async function subscribe(u: TestUser, c: TestUser): Promise<void> {
  const plan = (
    await c.client.post('/v1/creator/plans', {
      name: `Plan ${uniq('p')}`,
      priceCents: 500,
      currency: 'USD',
      interval: 'month',
      tier: 1,
    })
  ).body;
  const r = await u.client.request('POST', `/v1/creators/${c.id}/subscribe`, {
    headers: idem(key()),
    body: { planId: plan.id, paymentMethod: okToken() },
  });
  if (r.status !== 201) throw new Error(`subscribe failed ${r.status} ${JSON.stringify(r.body)}`);
}
async function fakeVideo(owner: TestUser): Promise<string> {
  const { rows } = await sql(
    `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status, purpose, duration_ms, width, height, checksum_sha256) VALUES ($1,'video',$2,'video/mp4',1000,'ready','attachment',600000,320,240,$3) RETURNING id`,
    [owner.id, `test/${uniq('s')}.mp4`, uniq('sum')],
  );
  return rows[0].id;
}

// ------------------------------------------------------------------ WebSocket helper
class Sock {
  frames: any[] = [];
  private used = new Set<number>();
  closed: Promise<{ code: number }>;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(d.toString())));
    this.closed = new Promise((res) => ws.on('close', (code) => res({ code })));
  }
  async expect(pred: (f: any) => boolean, ms = 3000): Promise<any> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex((f, idx) => !this.used.has(idx) && pred(f));
      if (i >= 0) {
        this.used.add(i);
        return this.frames[i];
      }
      if (Date.now() > end)
        throw new Error(`timeout waiting for frame; got ${JSON.stringify(this.frames)}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  async none(pred: (f: any) => boolean, ms = 300) {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.frames.filter((f, idx) => !this.used.has(idx) && pred(f))).toEqual([]);
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
  close() {
    this.ws.close();
  }
}
const ticketFor = async (u: TestUser) =>
  (await u.client.post('/v1/ws/ticket')).body.ticket as string;
const open: Sock[] = [];
const wsUrl = (id: string, ticket: string) =>
  `ws://127.0.0.1:${port}/v1/live/${id}/ws?ticket=${encodeURIComponent(ticket)}`;
async function connect(u: TestUser, id: string): Promise<Sock> {
  const ws = new WebSocket(wsUrl(id, await ticketFor(u)), { headers: { origin: ORIGIN } });
  const s = new Sock(ws);
  open.push(s);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
    ws.once('unexpected-response', (_q, r) => rej(new Error(`rejected ${r.statusCode}`)));
  });
  await s.expect((f) => f.type === 'ready');
  return s;
}
function upgradeStatus(
  url: string,
  headers: Record<string, string> = { origin: ORIGIN },
): Promise<number> {
  return new Promise((res) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => {
      open.push(new Sock(ws));
      res(101);
    });
    ws.once('unexpected-response', (_q, r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    ws.once('error', () => res(0));
  });
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  liveSocketSettings.heartbeatMs = 30_000;
});

// ================================================================== flag
describe('feature flag', () => {
  it('LIVE is off by default: everything answers 404 feature_disabled, including the WebSocket', async () => {
    const u = await signup(t);
    expect(flagDefault).toBe(false); // shipped off
    await setFlag('LIVE', false);
    for (const r of [
      await u.client.post('/v1/live', { title: 'x' }),
      await u.client.get('/v1/live'),
      await u.client.get('/v1/live/mine'),
      await u.client.post(`/v1/live/${'0'.repeat(8)}-0000-4000-8000-000000000000/join`),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('feature_disabled');
    }
    expect(
      await upgradeStatus(wsUrl('00000000-0000-4000-8000-000000000000', await ticketFor(u))),
    ).toBe(404);
    await setFlag('LIVE', true);
    expect((await u.client.get('/v1/live')).status).toBe(200);
    expect((await anon().get('/v1/live')).status).toBe(401);
    expect((await anon().post('/v1/live', { title: 'x' })).status).toBe(401);
  });
});

// ================================================================== lifecycle
describe('session lifecycle', () => {
  it('scheduled -> live -> ended with the right people allowed at each step', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const s = await mkLive(host, {
      title: 'My show',
      description: 'hello',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(s).toMatchObject({
      status: 'scheduled',
      mediaMode: 'interactive',
      viewerRole: 'host',
      ticket: { required: false },
    });
    expect((await host.client.post('/v1/live', { title: '', visibility: 'public' })).status).toBe(
      400,
    );
    expect(
      (
        await host.client.post('/v1/live', {
          title: 'Late',
          scheduledFor: new Date(Date.now() - 1000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect((await host.client.post('/v1/live', { title: 'I will kill you tomorrow' })).status).toBe(
      422,
    );
    const patched = await host.client.patch(`/v1/live/${s.id}`, { title: 'Renamed' });
    expect(patched.body.title).toBe('Renamed');
    expect((await host.client.patch(`/v1/live/${s.id}`, {})).status).toBe(400);

    await appoint(host, s.id, co, 'cohost');
    expect((await co.client.patch(`/v1/live/${s.id}`, { title: 'Mine now' })).status).toBe(403);
    expect((await co.client.post(`/v1/live/${s.id}/start`)).status).toBe(403);
    expect((await co.client.post(`/v1/live/${s.id}/cancel`)).status).toBe(403);
    expect((await (await signup(t)).client.post(`/v1/live/${s.id}/start`)).status).toBe(403); // a stranger can see a public session but it is not theirs
  });

  it('starts once, ends once, and cannot go backwards', async () => {
    const host = await signup(t);
    const s = await mkLive(host);
    expect((await host.client.post(`/v1/live/${s.id}/end`, {})).status).toBe(409); // scheduled sessions are cancelled, not ended
    const started = await host.client.post(`/v1/live/${s.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ session: { status: 'live', video: null }, ingest: null });
    expect(started.headers['cache-control']).toBe('no-store');
    expect((await host.client.post(`/v1/live/${s.id}/start`)).status).toBe(409);
    expect((await host.client.post(`/v1/live/${s.id}/cancel`)).status).toBe(409);
    // One live session at a time per host.
    const other = await mkLive(host);
    const second = await host.client.post(`/v1/live/${other.id}/start`);
    expect(second.status).toBe(409);
    expect(second.body.error.details.reason).toBe('already_live');
    const ended = await host.client.post(`/v1/live/${s.id}/end`, { reason: 'all done' });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ status: 'ended', endReason: 'all done' });
    expect((await host.client.post(`/v1/live/${s.id}/end`, {})).status).toBe(409);
    expect((await host.client.post(`/v1/live/${s.id}/start`)).status).toBe(409);
    expect((await host.client.patch(`/v1/live/${s.id}`, { title: 'Too late' })).status).toBe(409);
    expect((await host.client.post(`/v1/live/${other.id}/start`)).status).toBe(200); // free again
    expect(await auditN('live.started', s.id)).toBe(1);
    expect(await auditN('live.ended', s.id)).toBe(1);
    const cancelled = await host.client.post(`/v1/live/${(await mkLive(host)).id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await host.client.get('/v1/live/mine')).body.items.map((x: any) => x.status)).toEqual(
      expect.arrayContaining(['live', 'ended', 'cancelled']),
    );
  });

  it('video sessions need an ingest provider: 501 and still scheduled without one; the stream key is shown once and never stored', async () => {
    const host = await signup(t);
    const s = await mkLive(host, { mediaMode: 'video' });
    const r = await host.client.post(`/v1/live/${s.id}/start`);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('feature_disabled');
    expect(r.body.error.details.reason).toBe('ingest_unavailable');
    expect(
      (await sql('SELECT status FROM live_sessions WHERE id = $1', [s.id])).rows[0].status,
    ).toBe('scheduled');

    const calls: string[] = [];
    const fake: IngestProvider = {
      name: 'fake',
      available: true,
      createStream: async ({ liveId }) => {
        calls.push(`create:${liveId}`);
        return {
          ref: `ref_${liveId.slice(0, 8)}`,
          ingestUrl: 'rtmp://ingest.example/live',
          streamKey: 'SECRET-STREAM-KEY-123',
          playbackUrl: 'https://cdn.example/p.m3u8',
        };
      },
      endStream: async (ref) => {
        calls.push(`end:${ref}`);
      },
    };
    overrideLiveRuntime(t.ctx, { ingest: fake });
    try {
      const ok = await host.client.post(`/v1/live/${s.id}/start`);
      expect(ok.status).toBe(200);
      expect(ok.body.ingest).toEqual({
        url: 'rtmp://ingest.example/live',
        streamKey: 'SECRET-STREAM-KEY-123',
        playbackUrl: 'https://cdn.example/p.m3u8',
      });
      expect(ok.body.session).toMatchObject({ status: 'live', video: { ingestState: 'waiting' } });
      expect(
        JSON.stringify((await sql('SELECT * FROM live_sessions WHERE id = $1', [s.id])).rows[0]),
      ).not.toContain('SECRET-STREAM-KEY');
      expect(JSON.stringify((await host.client.get(`/v1/live/${s.id}`)).body)).not.toContain(
        'SECRET',
      );
      expect(
        JSON.stringify(
          (await sql(`SELECT metadata FROM audit_logs WHERE target_id = $1`, [s.id])).rows,
        ),
      ).not.toContain('SECRET');
      // A start that fails (already live elsewhere) releases the stream it just created.
      const s2 = await mkLive(host, { mediaMode: 'video' });
      expect((await host.client.post(`/v1/live/${s2.id}/start`)).status).toBe(409);
      expect(calls.filter((c) => c.startsWith('end:'))).toHaveLength(1);
      await host.client.post(`/v1/live/${s.id}/end`, {});
      expect(calls).toContain(`end:ref_${s.id.slice(0, 8)}`);
    } finally {
      overrideLiveRuntime(t.ctx, {
        ingest: (await import('../src/modules/live/runtime.js')).noIngest,
      });
    }
  });

  it('maintenance ends sessions left running and cancels no-shows', async () => {
    const host = await signup(t);
    const stale = await mkLive(host, {}, true);
    await sql(`UPDATE live_sessions SET started_at = now() - interval '13 hours' WHERE id = $1`, [
      stale.id,
    ]);
    const noShow = await mkLive(host);
    await sql(
      `UPDATE live_sessions SET scheduled_for = now() - interval '25 hours' WHERE id = $1`,
      [noShow.id],
    );
    const fresh = await mkLive(host);
    const r = await runLiveMaintenance(t.ctx);
    expect(r.endedStale).toBeGreaterThanOrEqual(1);
    expect(r.cancelledNoShow).toBeGreaterThanOrEqual(1);
    expect(
      (await sql('SELECT status, end_reason FROM live_sessions WHERE id = $1', [stale.id])).rows[0],
    ).toMatchObject({ status: 'ended', end_reason: 'timeout' });
    expect(
      (await sql('SELECT status, end_reason FROM live_sessions WHERE id = $1', [noShow.id]))
        .rows[0],
    ).toMatchObject({ status: 'cancelled', end_reason: 'no_show' });
    expect(
      (await sql('SELECT status FROM live_sessions WHERE id = $1', [fresh.id])).rows[0].status,
    ).toBe('scheduled');
    expect(await runLiveMaintenance(t.ctx)).toEqual({ endedStale: 0, cancelledNoShow: 0 });
  });
});

// ================================================================== visibility
describe('who can see a session', () => {
  it('follows the visibility matrix (public/followers/subscribers/private) and hides blocks and cancelled sessions', async () => {
    const host = await mkCreator();
    const stranger = await signup(t);
    const follower = await signup(t);
    await follow(follower, host);
    const subscriber = await signup(t);
    await subscribe(subscriber, host);
    const co = await signup(t);
    const blocked = await signup(t);
    await block(host, blocked);
    const blocker = await signup(t);
    await block(blocker, host);
    const sessions: Record<string, any> = {};
    for (const v of ['public', 'followers', 'subscribers', 'private'])
      sessions[v] = await mkLive(host, {
        visibility: v,
        scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      });
    for (const s of Object.values(sessions)) await appoint(host, s.id, co, 'moderator');

    const seen = async (u: TestUser) =>
      (
        await Promise.all(
          Object.entries(sessions).map(
            async ([v, s]) => [v, (await u.client.get(`/v1/live/${s.id}`)).status] as const,
          ),
        )
      )
        .filter(([, st]) => st === 200)
        .map(([v]) => v)
        .sort();
    expect(await seen(host)).toEqual(['followers', 'private', 'public', 'subscribers']);
    expect(await seen(co)).toEqual(['followers', 'private', 'public', 'subscribers']);
    expect(await seen(stranger)).toEqual(['public']);
    expect(await seen(follower)).toEqual(['followers', 'public']);
    expect(await seen(subscriber)).toEqual(['public', 'subscribers']);
    expect(await seen(blocked)).toEqual([]);
    expect(await seen(blocker)).toEqual([]);
    // Hidden looks exactly like missing.
    const hidden = await stranger.client.get(`/v1/live/${sessions.private.id}`);
    const missing = await stranger.client.get('/v1/live/00000000-0000-4000-8000-000000000000');
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe(missing.body.error.code);
    // The listing agrees with the detail view.
    const listed = async (u: TestUser) =>
      (await u.client.get('/v1/live', { status: 'scheduled', hostId: host.id })).body.items
        .map((s: any) => s.visibility)
        .sort();
    expect(await listed(stranger)).toEqual(['public']);
    expect(await listed(subscriber)).toEqual(['public', 'subscribers']);
    expect(await listed(host)).toEqual(['followers', 'private', 'public', 'subscribers']);
    expect(await listed(blocked)).toEqual([]);
    // Cancelled sessions disappear for everyone but the host and team.
    await host.client.post(`/v1/live/${sessions.public.id}/cancel`);
    expect((await stranger.client.get(`/v1/live/${sessions.public.id}`)).status).toBe(404);
    expect((await host.client.get(`/v1/live/${sessions.public.id}`)).status).toBe(200);
    expect((await join(stranger, sessions.public.id)).status).toBe(404);
    // Subscriber-only sessions need a creator host, and a lapsed subscription closes the door.
    expect(
      (
        await (
          await signup(t)
        ).client.post('/v1/live', { title: 'Subs', visibility: 'subscribers' })
      ).status,
    ).toBe(403);
    await sql(
      `UPDATE subscriptions SET status = 'cancelled', ended_at = now() WHERE subscriber_id = $1`,
      [subscriber.id],
    );
    expect((await subscriber.client.get(`/v1/live/${sessions.subscribers.id}`)).status).toBe(404);
    // The staff view sees everything.
    expect((await mod.client.get(`/v1/staff/live/${sessions.private.id}`)).status).toBe(200);
    expect((await stranger.client.get(`/v1/staff/live/${sessions.private.id}`)).status).toBe(403);
  });

  it('teens host only for followers or privately, never sell tickets, and stay in their own age group', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    const adult = await signup(t);
    for (const v of ['public', 'subscribers'])
      expect((await teen.client.post('/v1/live', { title: 'T', visibility: v })).status).toBe(403);
    const ev = (
      await adult.client.post('/v1/events', {
        title: 'Adult event',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 90_000_000).toISOString(),
        locationText: 'Hall',
        publish: true,
        visibility: 'public',
      })
    ).body;
    const tt = (
      await adult.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Free',
        priceCents: 0,
        quantity: 5,
      })
    ).body;
    expect(
      (
        await teen.client.post('/v1/live', {
          title: 'T',
          visibility: 'followers',
          ticketTypeId: tt.id,
        })
      ).status,
    ).toBe(403);
    const s = await mkLive(teen, { visibility: 'followers' }, true);
    expect(s.visibility).toBe('followers');
    const friend = await signup(t, { birthDate: teenBirth() });
    await follow(friend, teen);
    await appoint(teen, s.id, friend, 'moderator');
    expect(
      (await teen.client.put(`/v1/live/${s.id}/team/${adult.id}`, { role: 'cohost' })).status,
    ).toBe(403);
    // A teen can watch and chat in an adult's public session.
    const pub = await mkLive(adult, {}, true);
    await joined(teen, pub.id);
    expect((await say(teen, pub.id, 'hi from a teen')).status).toBe(201);
  });
});

// ================================================================== audience
describe('joining and leaving', () => {
  it('needs an on-air session, is idempotent, counts viewers honestly and keeps the peak', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const s = await mkLive(host);
    const early = await join(a, s.id);
    expect(early.status).toBe(409);
    expect(early.body.error.details.reason).toBe('not_live');
    await host.client.post(`/v1/live/${s.id}/start`);
    const j = await join(a, s.id);
    expect(j.status).toBe(200);
    expect(j.body).toMatchObject({
      session: { status: 'live', viewerRole: 'audience', viewerCount: 1 },
      messages: [],
      openPolls: [],
      realtime: { url: `/v1/live/${s.id}/ws` },
    });
    expect(j.body.session.blockedTerms).toBeUndefined(); // team-only settings stay hidden
    await join(a, s.id); // again: still one viewer
    await joined(b, s.id);
    await joined(c, s.id);
    expect(await viewers(s.id)).toEqual({ viewer_count: 3, peak_viewers: 3 });
    expect((await host.client.post(`/v1/live/${s.id}/join`)).status).toBe(200); // the host is not a viewer
    expect((await viewers(s.id)).viewer_count).toBe(3);
    expect((await b.client.post(`/v1/live/${s.id}/leave`)).status).toBe(204);
    await b.client.post(`/v1/live/${s.id}/leave`); // idempotent
    expect(await viewers(s.id)).toEqual({ viewer_count: 2, peak_viewers: 3 });
    await joined(b, s.id);
    expect((await viewers(s.id)).viewer_count).toBe(3);
    await host.client.post(`/v1/live/${s.id}/end`, {});
    expect((await viewers(s.id)).viewer_count).toBe(0);
    expect(
      await n(
        'SELECT count(*)::int AS n FROM live_participants WHERE live_id = $1 AND left_at IS NULL',
        [s.id],
      ),
    ).toBe(0);
    expect((await join(a, s.id)).status).toBe(409);
  });
});

// ================================================================== chat
describe('chat', () => {
  it('needs the room, respects visibility and the rules of the text', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const s = await mkLive(host, {}, true);
    const notIn = await say(a, s.id, 'hello');
    expect(notIn.status).toBe(409);
    expect(notIn.body.error.details.reason).toBe('not_joined');
    await joined(a, s.id);
    await joined(b, s.id);
    const m = await say(a, s.id, '  hello everyone  ');
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({
      body: 'hello everyone',
      userId: a.id,
      author: { username: a.username },
    });
    expect((await say(a, s.id, '')).status).toBe(400);
    expect((await say(a, s.id, 'x'.repeat(501))).status).toBe(400);
    const bad = await say(a, s.id, 'I will kill you tomorrow');
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.reason).toBe('text_not_allowed');
    expect((await anon().post(`/v1/live/${s.id}/messages`, { body: 'x' })).status).toBe(401);
    expect((await (await signup(t)).client.get(`/v1/live/${s.id}/messages`)).status).toBe(200); // public: readable by any signed-in viewer
    const stranger = await signup(t);
    const priv = await mkLive(host, { visibility: 'private' });
    expect((await stranger.client.get(`/v1/live/${priv.id}/messages`)).status).toBe(404);
    // Not on air any more: no new messages, history stays readable for those who may see the session.
    await host.client.post(`/v1/live/${s.id}/end`, {});
    expect((await say(b, s.id, 'late')).status).toBe(409);
    expect((await b.client.get(`/v1/live/${s.id}/messages`)).body.items).toHaveLength(1);
  });

  it('pages history newest first and hides blocked people and removed messages', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const s = await mkLive(host, {}, true);
    for (const u of [a, b, c]) await joined(u, s.id);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await say(a, s.id, `msg ${i}`)).body.id);
    await sql(
      "UPDATE live_messages SET created_at = created_at + (random() * interval '0 seconds')",
    ); // no-op: keep insertion order
    const p1 = (await b.client.get(`/v1/live/${s.id}/messages`, { limit: '2' })).body;
    expect(p1.items.map((m: any) => m.body)).toEqual(['msg 4', 'msg 3']);
    const p2 = (
      await b.client.get(`/v1/live/${s.id}/messages`, { limit: '2', before: p1.nextBefore })
    ).body;
    expect(p2.items.map((m: any) => m.body)).toEqual(['msg 2', 'msg 1']);
    const p3 = (
      await b.client.get(`/v1/live/${s.id}/messages`, { limit: '2', before: p2.nextBefore })
    ).body;
    expect(p3.items.map((m: any) => m.body)).toEqual(['msg 0']);
    expect(p3.nextBefore).toBeNull();
    // c blocked a: c no longer sees a's lines; b still does.
    await block(c, a);
    expect((await c.client.get(`/v1/live/${s.id}/messages`)).body.items).toHaveLength(0);
    expect((await b.client.get(`/v1/live/${s.id}/messages`)).body.items).toHaveLength(5);
    // Own delete, and nobody else's (audience); the team can, with an audit trail.
    expect((await b.client.del(`/v1/live/${s.id}/messages/${ids[0]}`)).status).toBe(403);
    expect((await a.client.del(`/v1/live/${s.id}/messages/${ids[0]}`)).status).toBe(204);
    expect((await host.client.del(`/v1/live/${s.id}/messages/${ids[1]}`)).status).toBe(204);
    expect(await auditN('live.message_hidden', ids[1])).toBe(1);
    const seen = (await b.client.get(`/v1/live/${s.id}/messages`)).body.items.map(
      (m: any) => m.body,
    );
    expect(seen).toEqual(['msg 4', 'msg 3', 'msg 2']);
    const team = (await host.client.get(`/v1/live/${s.id}/messages`)).body.items;
    expect(team.filter((m: any) => m.hidden)).toHaveLength(2);
    expect(
      (await host.client.del(`/v1/live/${s.id}/messages/00000000-0000-4000-8000-000000000000`))
        .status,
    ).toBe(404);
  });

  it('slow mode, muting, blocked terms and turning chat off', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const co = await signup(t);
    const s = await mkLive(host, {}, true);
    await appoint(host, s.id, co, 'cohost');
    await joined(a, s.id);
    await joined(co, s.id);
    expect((await a.client.patch(`/v1/live/${s.id}/settings`, { slowModeSec: 30 })).status).toBe(
      403,
    );
    const set = await co.client.patch(`/v1/live/${s.id}/settings`, {
      slowModeSec: 30,
      blockedTerms: ['Spoiler', 'big  secret'],
    });
    expect(set.body).toMatchObject({ slowModeSec: 30, blockedTerms: ['spoiler', 'big secret'] });
    expect(
      (await host.client.patch(`/v1/live/${s.id}/settings`, { slowModeSec: 301 })).status,
    ).toBe(400);
    expect(
      (await host.client.patch(`/v1/live/${s.id}/settings`, { blockedTerms: ['a'] })).status,
    ).toBe(400);
    expect((await say(a, s.id, 'first')).status).toBe(201);
    const slow = await say(a, s.id, 'second');
    expect(slow.status).toBe(429);
    expect(slow.body.error.details.reason).toBe('slow_mode');
    expect((await say(co, s.id, 'one')).status).toBe(201); // the team is exempt
    expect((await say(co, s.id, 'two')).status).toBe(201);
    await sql(
      `UPDATE live_messages SET created_at = now() - interval '1 minute' WHERE user_id = $1`,
      [a.id],
    );
    const term = await say(a, s.id, 'no S.p.o.i.l.e.r please');
    expect(term.status).toBe(422);
    expect(term.body.error.details.reason).toBe('blocked_term');
    expect((await say(a, s.id, 'The BIG   secret')).status).toBe(422);
    expect((await say(host, s.id, 'a spoiler from the host')).status).toBe(201); // hosts speak freely
    expect((await say(a, s.id, 'category is fine')).status).toBe(201);

    await host.client.patch(`/v1/live/${s.id}/settings`, { slowModeSec: 0 });
    const mute = await host.client.put(`/v1/live/${s.id}/participants/${a.id}/mute`, {
      minutes: 5,
    });
    expect(mute.status).toBe(200);
    const muted = await say(a, s.id, 'still here');
    expect(muted.status).toBe(403);
    expect((await a.client.get(`/v1/live/${s.id}/messages`)).status).toBe(200); // muted people can still read
    expect((await a.client.post(`/v1/live/${s.id}/questions`, { body: 'can I ask?' })).status).toBe(
      403,
    );
    await sql(
      `UPDATE live_participants SET muted_until = now() - interval '1 second' WHERE live_id = $1 AND user_id = $2`,
      [s.id, a.id],
    );
    expect((await say(a, s.id, 'the mute expired')).status).toBe(201);

    await host.client.patch(`/v1/live/${s.id}/settings`, { chatEnabled: false });
    expect((await say(a, s.id, 'anyone?')).status).toBe(403);
    expect((await say(host, s.id, 'the host still can')).status).toBe(201);
    await host.client.patch(`/v1/live/${s.id}/settings`, { chatEnabled: true });
    expect((await say(a, s.id, 'back')).status).toBe(201);
    expect(await auditN('live.settings_changed', s.id)).toBeGreaterThanOrEqual(4);
  });

  it("serialises one person's messages so parallel requests cannot dodge slow mode", async () => {
    const host = await signup(t);
    const a = await signup(t);
    const s = await mkLive(host, {}, true);
    await joined(a, s.id);
    await host.client.patch(`/v1/live/${s.id}/settings`, { slowModeSec: 60 });
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => say(a, s.id, `burst ${i}`)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(4);
  });
});

describe('reactions', () => {
  it('aggregate, need the room and cap the burst', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const out = await signup(t);
    const s = await mkLive(host, {}, true);
    await joined(a, s.id);
    expect((await out.client.post(`/v1/live/${s.id}/reactions`, { kind: 'fire' })).status).toBe(
      409,
    );
    expect(
      (await a.client.post(`/v1/live/${s.id}/reactions`, { kind: 'fire', count: 3 })).body,
    ).toEqual({ kind: 'fire', total: 3 });
    expect((await a.client.post(`/v1/live/${s.id}/reactions`, { kind: 'fire' })).body.total).toBe(
      4,
    );
    await a.client.post(`/v1/live/${s.id}/reactions`, { kind: 'clap', count: 10 });
    expect(
      (await a.client.post(`/v1/live/${s.id}/reactions`, { kind: 'fire', count: 11 })).status,
    ).toBe(400);
    expect((await a.client.post(`/v1/live/${s.id}/reactions`, { kind: 'poop' })).status).toBe(400);
    expect((await a.client.get(`/v1/live/${s.id}/reactions`)).body.totals).toMatchObject({
      fire: 4,
      clap: 10,
      like: 0,
    });
  });
});

// ================================================================== polls and Q&A
describe('polls', () => {
  it('are run by the team, answered once by the audience, and closed at the end', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const mod1 = await signup(t);
    const s = await mkLive(host, {}, true);
    await appoint(host, s.id, mod1, 'moderator');
    for (const u of [a, b, mod1]) await joined(u, s.id);
    const body = { question: 'Best colour?', options: ['Red', 'Blue', 'Green'] };
    expect((await a.client.post(`/v1/live/${s.id}/polls`, body)).status).toBe(403);
    expect((await mod1.client.post(`/v1/live/${s.id}/polls`, body)).status).toBe(403); // moderators do not run polls
    expect(
      (await host.client.post(`/v1/live/${s.id}/polls`, { question: 'Q', options: ['only'] }))
        .status,
    ).toBe(400);
    expect(
      (await host.client.post(`/v1/live/${s.id}/polls`, { question: 'Q', options: ['a', 'A'] }))
        .status,
    ).toBe(400);
    const poll = await host.client.post(`/v1/live/${s.id}/polls`, body);
    expect(poll.status).toBe(201);
    expect((await host.client.post(`/v1/live/${s.id}/polls`, body)).status).toBe(409); // one at a time
    const [red, blue] = poll.body.options;
    expect(
      (
        await a.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/vote`, {
          optionIds: [red.id, blue.id],
        })
      ).status,
    ).toBe(400);
    const v = await a.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/vote`, {
      optionIds: [red.id],
    });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ voters: 1, myVotes: [red.id] });
    expect(v.body.options.find((o: any) => o.id === red.id).votes).toBe(1);
    expect(
      (await a.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/vote`, { optionIds: [blue.id] }))
        .status,
    ).toBe(409);
    await b.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/vote`, { optionIds: [red.id] });
    const parallel = await Promise.all([
      mod1.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/vote`, { optionIds: [blue.id] }),
      mod1.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/vote`, { optionIds: [red.id] }),
    ]);
    expect(parallel.map((r) => r.status).sort()).toEqual([200, 409]);
    const listed = (await b.client.get(`/v1/live/${s.id}/polls`)).body.items[0];
    expect(listed.voters).toBe(3);
    expect(listed.options.reduce((sum: number, o: any) => sum + o.votes, 0)).toBe(3);
    expect((await a.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/close`)).status).toBe(403);
    expect(
      (await host.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/close`)).body.status,
    ).toBe('closed');
    expect((await host.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/close`)).status).toBe(
      409,
    );
    const late = await signup(t);
    await joined(late, s.id);
    expect(
      (
        await late.client.post(`/v1/live/${s.id}/polls/${poll.body.id}/vote`, {
          optionIds: [red.id],
        })
      ).status,
    ).toBe(409);
    // Multiple choice, and polls still open when the session ends are closed with it.
    const multi = await host.client.post(`/v1/live/${s.id}/polls`, {
      question: 'Pick some',
      options: ['x', 'y', 'z'],
      multiple: true,
    });
    const ids = multi.body.options.map((o: any) => o.id);
    expect(
      (
        await a.client.post(`/v1/live/${s.id}/polls/${multi.body.id}/vote`, {
          optionIds: [ids[0], ids[2]],
        })
      ).body.voters,
    ).toBe(1);
    await host.client.post(`/v1/live/${s.id}/end`, {});
    expect(
      (await sql('SELECT status FROM live_polls WHERE id = $1', [multi.body.id])).rows[0].status,
    ).toBe('closed');
    expect(await auditN('live.poll_created', poll.body.id)).toBe(1);
  });
});

describe('questions', () => {
  it('are asked, upvoted once per person, answered by the team and removed by their author or a higher rank', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const mod1 = await signup(t);
    const s = await mkLive(host, {}, true);
    await appoint(host, s.id, mod1, 'moderator');
    for (const u of [a, b, mod1]) await joined(u, s.id);
    const qa = await a.client.post(`/v1/live/${s.id}/questions`, { body: 'How did you start?' });
    expect(qa.status).toBe(201);
    const qb = (await b.client.post(`/v1/live/${s.id}/questions`, { body: 'Favourite tool?' }))
      .body;
    expect(
      (await a.client.post(`/v1/live/${s.id}/questions`, { body: 'I will kill you tomorrow' }))
        .status,
    ).toBe(422);
    await a.client.post(`/v1/live/${s.id}/questions`, { body: 'Two?' });
    await a.client.post(`/v1/live/${s.id}/questions`, { body: 'Three?' });
    const four = await a.client.post(`/v1/live/${s.id}/questions`, { body: 'Four?' });
    expect(four.status).toBe(429);
    expect(four.body.error.details.reason).toBe('too_many_questions');

    expect((await a.client.put(`/v1/live/${s.id}/questions/${qa.body.id}/upvote`)).status).toBe(
      403,
    ); // not your own
    const up1 = await b.client.put(`/v1/live/${s.id}/questions/${qa.body.id}/upvote`);
    expect(up1.body).toMatchObject({ upvotes: 1, viewerUpvoted: true });
    expect(
      (await b.client.put(`/v1/live/${s.id}/questions/${qa.body.id}/upvote`)).body.upvotes,
    ).toBe(1); // idempotent
    await mod1.client.put(`/v1/live/${s.id}/questions/${qa.body.id}/upvote`);
    await Promise.all([
      host.client.put(`/v1/live/${s.id}/questions/${qb.id}/upvote`),
      host.client.put(`/v1/live/${s.id}/questions/${qb.id}/upvote`),
    ]);
    expect(
      (await sql('SELECT upvotes FROM live_questions WHERE id = $1', [qb.id])).rows[0].upvotes,
    ).toBe(1);
    expect(
      (await b.client.del(`/v1/live/${s.id}/questions/${qa.body.id}/upvote`)).body.upvotes,
    ).toBe(1);
    const order = (await a.client.get(`/v1/live/${s.id}/questions`)).body.items.map(
      (q: any) => q.body,
    );
    expect(order[0]).toBe('How did you start?');

    expect(
      (await a.client.post(`/v1/live/${s.id}/questions/${qb.id}/answer`, { answer: 'x' })).status,
    ).toBe(403);
    const ans = await mod1.client.post(`/v1/live/${s.id}/questions/${qa.body.id}/answer`, {
      answer: 'By experimenting',
    });
    expect(ans.body).toMatchObject({ status: 'answered', answer: 'By experimenting' });
    expect(
      (
        await host.client.post(`/v1/live/${s.id}/questions/${qa.body.id}/answer`, {
          answer: 'again',
        })
      ).status,
    ).toBe(409);
    expect(
      (await a.client.get(`/v1/live/${s.id}/questions`, { status: 'answered' })).body.items,
    ).toHaveLength(1);
    expect((await b.client.put(`/v1/live/${s.id}/questions/${qa.body.id}/upvote`)).status).toBe(
      409,
    ); // closed
    // Removal: audience cannot remove others', the author and a higher rank can.
    expect((await b.client.del(`/v1/live/${s.id}/questions/${qb.id}`)).status).toBe(204);
    const q2 = (await b.client.post(`/v1/live/${s.id}/questions`, { body: 'Another?' })).body;
    expect((await a.client.del(`/v1/live/${s.id}/questions/${q2.id}`)).status).toBe(403);
    expect((await mod1.client.del(`/v1/live/${s.id}/questions/${q2.id}`)).status).toBe(204);
    expect(await auditN('live.question_hidden', q2.id)).toBe(1);
    expect(
      (await a.client.get(`/v1/live/${s.id}/questions`)).body.items.map((q: any) => q.id),
    ).not.toContain(q2.id);
  });
});

// ================================================================== team and moderation
describe('team and moderation', () => {
  it('only the host appoints; moderation goes down the ladder; bans remove people from the session entirely', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const mod1 = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const s = await mkLive(host, {}, true);
    expect(
      (await co.client.put(`/v1/live/${s.id}/team/${mod1.id}`, { role: 'moderator' })).status,
    ).toBe(403); // not appointed yet: an ordinary viewer
    await appoint(host, s.id, co, 'cohost');
    await appoint(host, s.id, mod1, 'moderator');
    expect(
      (await co.client.put(`/v1/live/${s.id}/team/${a.id}`, { role: 'moderator' })).status,
    ).toBe(403);
    expect(
      (await host.client.put(`/v1/live/${s.id}/team/${host.id}`, { role: 'cohost' })).status,
    ).toBe(400);
    expect(
      (await host.client.put(`/v1/live/${s.id}/team/${host.id}`, { role: 'admin' })).status,
    ).toBe(400);
    expect(
      (await a.client.get(`/v1/live/${s.id}/team`)).body.items.map((m: any) => m.role),
    ).toEqual(['host', 'cohost', 'moderator']);
    for (const u of [co, mod1, a, b]) await joined(u, s.id);
    expect((await viewers(s.id)).viewer_count).toBe(2); // team members are not viewers

    // Audience cannot moderate anyone.
    expect(
      (await a.client.put(`/v1/live/${s.id}/participants/${b.id}/mute`, { minutes: 5 })).status,
    ).toBe(403);
    expect(
      (await a.client.put(`/v1/live/${s.id}/participants/${b.id}/ban`, { reason: 'x' })).status,
    ).toBe(403);
    // The ladder: nobody touches the host or an equal; a moderator cannot touch a co-host.
    expect(
      (await co.client.put(`/v1/live/${s.id}/participants/${host.id}/mute`, { minutes: 5 })).status,
    ).toBe(403);
    expect(
      (await mod1.client.put(`/v1/live/${s.id}/participants/${co.id}/mute`, { minutes: 5 })).status,
    ).toBe(403);
    expect(
      (await co.client.put(`/v1/live/${s.id}/participants/${co.id}/mute`, { minutes: 5 })).status,
    ).toBe(400);
    expect(
      (await mod1.client.put(`/v1/live/${s.id}/participants/${mod1.id}/ban`, { reason: 'self' }))
        .status,
    ).toBe(400);
    expect(
      (await host.client.put(`/v1/live/${s.id}/participants/${host.id}/ban`, { reason: 'self' }))
        .status,
    ).toBe(400);
    expect(
      (await co.client.put(`/v1/live/${s.id}/participants/${mod1.id}/mute`, { minutes: 5 })).status,
    ).toBe(200);
    expect((await say(mod1, s.id, 'muted mod')).status).toBe(403);
    expect((await co.client.del(`/v1/live/${s.id}/participants/${mod1.id}/mute`)).status).toBe(204);
    expect(
      (await mod1.client.put(`/v1/live/${s.id}/participants/${a.id}/mute`, { minutes: 0 })).status,
    ).toBe(400);

    // Ban: hides their chat, removes them from the room and from view, blocks rejoining, and is reversible and audited.
    await say(a, s.id, 'noisy');
    expect(
      (await mod1.client.put(`/v1/live/${s.id}/participants/${a.id}/ban`, { reason: 'spamming' }))
        .status,
    ).toBe(204);
    expect((await a.client.get(`/v1/live/${s.id}`)).status).toBe(404);
    expect((await join(a, s.id)).status).toBe(404);
    expect((await say(a, s.id, 'let me in')).status).toBe(404);
    expect((await a.client.get('/v1/live', { hostId: host.id })).body.items).toHaveLength(1); // the list itself is fine; only that session's chat is closed
    expect(
      (await b.client.get(`/v1/live/${s.id}/messages`)).body.items.map((m: any) => m.body),
    ).not.toContain('noisy');
    expect((await viewers(s.id)).viewer_count).toBe(1);
    const moderated = (await co.client.get(`/v1/live/${s.id}/moderation`)).body.items;
    expect(moderated).toEqual([
      expect.objectContaining({ userId: a.id, banned: true, banReason: 'spamming' }),
    ]);
    expect((await b.client.get(`/v1/live/${s.id}/moderation`)).status).toBe(403);
    expect(await auditN('live.participant_banned', s.id)).toBe(1);
    expect(
      (await host.client.put(`/v1/live/${s.id}/team/${a.id}`, { role: 'moderator' })).status,
    ).toBe(409); // ban first has to be lifted
    expect((await mod1.client.del(`/v1/live/${s.id}/participants/${a.id}/ban`)).status).toBe(204);
    expect((await join(a, s.id)).status).toBe(200);
    expect(
      (
        await mod1.client.put(`/v1/live/${s.id}/participants/${b.id}/ban`, {
          reason: 'I will kill you tomorrow',
        })
      ).status,
    ).toBe(422);
    // Removing a team member returns them to the audience.
    expect((await co.client.del(`/v1/live/${s.id}/team/${mod1.id}`)).status).toBe(403);
    expect((await host.client.del(`/v1/live/${s.id}/team/${mod1.id}`)).status).toBe(204);
    expect(
      (await mod1.client.put(`/v1/live/${s.id}/participants/${b.id}/mute`, { minutes: 5 })).status,
    ).toBe(403);
    expect((await host.client.del(`/v1/live/${s.id}/team/${mod1.id}`)).status).toBe(404);
  });

  it('host, co-hosts and staff can end a session; nobody else can', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const mod1 = await signup(t);
    const a = await signup(t);
    const one = await mkLive(host, {}, true);
    await appoint(host, one.id, co, 'cohost');
    await appoint(host, one.id, mod1, 'moderator');
    await joined(a, one.id);
    expect((await a.client.post(`/v1/live/${one.id}/end`, {})).status).toBe(403);
    expect((await mod1.client.post(`/v1/live/${one.id}/end`, {})).status).toBe(403);
    expect((await co.client.post(`/v1/live/${one.id}/end`, { reason: 'wrapping up' })).status).toBe(
      200,
    );
    expect(
      (await sql('SELECT status, ended_by FROM live_sessions WHERE id = $1', [one.id])).rows[0],
    ).toMatchObject({ status: 'ended', ended_by: co.id });

    const two = await mkLive(host, {}, true);
    await joined(a, two.id);
    expect(
      (await a.client.post(`/v1/staff/live/${two.id}/end`, { reason: 'because' })).status,
    ).toBe(403);
    expect((await anon().post(`/v1/staff/live/${two.id}/end`, { reason: 'because' })).status).toBe(
      401,
    );
    expect((await mod.client.post(`/v1/staff/live/${two.id}/end`, {})).status).toBe(400); // a reason is mandatory
    const r = await mod.client.post(`/v1/staff/live/${two.id}/end`, {
      reason: 'violates guidelines',
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ended');
    expect(await auditN('live.ended_by_staff', two.id)).toBe(1);
    expect(
      (await mod.client.post(`/v1/staff/live/${two.id}/end`, { reason: 'again' })).status,
    ).toBe(409);
    expect((await admin.client.post('/v1/staff/live/maintenance')).status).toBe(200);
    expect((await mod.client.post('/v1/staff/live/maintenance')).status).toBe(403);
  });
});

// ================================================================== tickets, gifts, shopping
describe('tickets', () => {
  it('a ticketed session needs a ticket to join, read the room and gift; RSVP with the free ticket type unlocks it', async () => {
    const host = await signup(t);
    const fan = await signup(t);
    const other = await signup(t);
    const ev = (
      await host.client.post('/v1/events', {
        title: `Show ${uniq('e')}`,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 90_000_000).toISOString(),
        locationText: 'Online',
        publish: true,
        visibility: 'public',
      })
    ).body;
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Free pass',
        priceCents: 0,
        quantity: 5,
      })
    ).body;
    expect(
      (await other.client.post('/v1/live', { title: 'Not mine', ticketTypeId: tt.id })).status,
    ).toBe(400); // must be the host's own event
    const s = await mkLive(host, { ticketTypeId: tt.id }, true);
    expect(s.ticket).toMatchObject({
      required: true,
      ticketTypeId: tt.id,
      eventId: ev.id,
      held: false,
    });
    const no = await join(fan, s.id);
    expect(no.status).toBe(402);
    expect(no.body.error.details.reason).toBe('ticket_required');
    expect((await fan.client.get(`/v1/live/${s.id}/messages`)).status).toBe(402);
    expect((await fan.client.get(`/v1/live/${s.id}`)).body.ticket.held).toBe(false);
    expect((await host.client.post(`/v1/live/${s.id}/join`)).status).toBe(200);
    await expect(assertLiveGiftable(t.ctx, fan.id, s.id, host.id)).rejects.toMatchObject({
      status: 402,
    });
    expect(
      (await fan.client.put(`/v1/events/${ev.id}/rsvp`, { status: 'going', ticketTypeId: tt.id }))
        .status,
    ).toBe(200);
    expect((await fan.client.get(`/v1/live/${s.id}`)).body.ticket.held).toBe(true);
    expect((await join(fan, s.id)).status).toBe(200);
    expect((await say(fan, s.id, 'I have a ticket')).status).toBe(201);
    await expect(assertLiveGiftable(t.ctx, fan.id, s.id, host.id)).resolves.toBeUndefined();
    // Giving the ticket back (refund/release) closes the door again.
    await sql(
      `UPDATE event_ticket_grants SET status = 'released', released_at = now() WHERE user_id = $1 AND ticket_type_id = $2`,
      [fan.id, tt.id],
    );
    expect((await say(fan, s.id, 'still?')).status).toBe(402); // entitlement is checked on every action, not only on entry
    expect((await fan.client.get(`/v1/live/${s.id}/messages`)).status).toBe(402);
    expect((await join(other, s.id)).status).toBe(402);
    expect(
      (await sql('SELECT count(*)::int AS n FROM live_sessions WHERE ticket_type_id = $1', [tt.id]))
        .rows[0].n,
    ).toBe(1);
  });
});

describe('gifts and subscriptions during a session', () => {
  it('assertLiveGiftable enforces the room rules and the creator gift flow uses it (with a realtime event)', async () => {
    const host = await mkCreator();
    const co = await mkCreator();
    const fan = await signup(t);
    const stranger = await signup(t);
    const banned = await signup(t);
    const teen = await signup(t, { birthDate: teenBirth() });
    const code = `rose_${uniq('g').slice(0, 8)}`;
    expect(
      (
        await admin.client.post('/v1/staff/gifts', {
          code,
          name: 'Rose',
          priceCents: 300,
          currency: 'USD',
        })
      ).status,
    ).toBe(201);
    const s = await mkLive(host, {}, true);
    const scheduled = await mkLive(host);
    await appoint(host, s.id, co, 'cohost');
    for (const u of [fan, banned, teen]) await joined(u, s.id);
    await host.client.put(`/v1/live/${s.id}/participants/${banned.id}/ban`, { reason: 'rude' });

    await expect(assertLiveGiftable(t.ctx, fan.id, s.id, host.id)).resolves.toBeUndefined();
    await expect(assertLiveGiftable(t.ctx, fan.id, s.id, co.id)).resolves.toBeUndefined(); // a co-host may receive
    await expect(assertLiveGiftable(t.ctx, fan.id, s.id, stranger.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertLiveGiftable(t.ctx, fan.id, s.id, fan.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertLiveGiftable(t.ctx, fan.id, scheduled.id, host.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(assertLiveGiftable(t.ctx, banned.id, s.id, host.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      assertLiveGiftable(t.ctx, fan.id, '00000000-0000-4000-8000-000000000000', host.id),
    ).rejects.toMatchObject({ status: 404 });
    const priv = await mkLive(await mkCreator(), { visibility: 'private' });
    await expect(assertLiveGiftable(t.ctx, fan.id, priv.id, priv.hostId)).rejects.toMatchObject({
      status: 404,
    });

    const gift = (u: TestUser, to: TestUser, liveSessionId: string) =>
      u.client.request('POST', `/v1/creators/${to.id}/gifts`, {
        headers: idem(key()),
        body: { giftCode: code, paymentMethod: okToken(), liveSessionId },
      });
    const sock = await connect(stranger, s.id);
    const ok = await gift(fan, host, s.id);
    expect(ok.status).toBe(201);
    expect(ok.body.gift).toMatchObject({ status: 'completed', liveSessionId: s.id });
    const frame = await sock.expect((f) => f.type === 'gift');
    expect(frame).toMatchObject({
      liveId: s.id,
      fromUserId: fan.id,
      creatorId: host.id,
      amountCents: 300,
    });
    expect((await gift(fan, co, s.id)).status).toBe(201);
    expect((await gift(fan, stranger, s.id)).status).toBe(403);
    expect((await gift(banned, host, s.id)).status).toBe(404);
    expect((await gift(fan, host, scheduled.id)).status).toBe(409);
    expect((await gift(teen, host, s.id)).status).toBe(403); // no purchases under 18
    expect(await n('SELECT count(*)::int AS n FROM gifts WHERE live_session_id = $1', [s.id])).toBe(
      2,
    );
    // The session's commerce view points at the real flows.
    const cv = (await fan.client.get(`/v1/live/${s.id}/commerce`)).body;
    expect(cv.gifts).toMatchObject({
      enabled: true,
      sendTo: `/v1/creators/${host.id}/gifts`,
      liveSessionId: s.id,
    });
    expect(cv.subscriptions.subscribe).toBe(`/v1/creators/${host.id}/subscribe`);
    expect(cv.ticket).toBeNull();
    const plain = await signup(t);
    const plainLive = await mkLive(plain, {}, true);
    expect((await fan.client.get(`/v1/live/${plainLive.id}/commerce`)).body.gifts).toEqual({
      enabled: false,
    }); // not a creator: no gifts
  });
});

describe('live shopping', () => {
  it("shows only the host's own products, pins one at a time and follows the COMMERCE flag", async () => {
    const host = await signup(t);
    const other = await signup(t);
    const a = await signup(t);
    const co = await signup(t);
    const p1 = await mkProduct(host);
    const p2 = await mkProduct(host);
    const foreign = await mkProduct(other);
    const draft = await mkProduct(host, { status: 'draft' });
    const s = await mkLive(host, {}, true);
    await appoint(host, s.id, co, 'cohost');
    await joined(a, s.id);
    expect((await a.client.put(`/v1/live/${s.id}/products/${p1.id}`)).status).toBe(403);
    expect((await host.client.put(`/v1/live/${s.id}/products/${foreign.id}`)).status).toBe(404); // someone else's product
    expect((await host.client.put(`/v1/live/${s.id}/products/${draft.id}`)).status).toBe(404);
    expect((await host.client.put(`/v1/live/${s.id}/products/${p1.id}`)).status).toBe(200);
    expect((await co.client.put(`/v1/live/${s.id}/products/${p2.id}`)).status).toBe(200);
    expect((await a.client.get(`/v1/live/${s.id}/products`)).body.items).toHaveLength(2);
    expect((await a.client.put(`/v1/live/${s.id}/products/${p1.id}/pin`)).status).toBe(403);
    expect((await host.client.put(`/v1/live/${s.id}/products/${foreign.id}/pin`)).status).toBe(404);
    const sock = await connect(a, s.id);
    await host.client.put(`/v1/live/${s.id}/products/${p1.id}/pin`);
    const pinned = await sock.expect((f) => f.type === 'product.pinned');
    expect(pinned.product).toMatchObject({ productId: p1.id, pinned: true, available: true });
    const swap = await co.client.put(`/v1/live/${s.id}/products/${p2.id}/pin`);
    expect(swap.body.pinned.productId).toBe(p2.id);
    expect(
      await n('SELECT count(*)::int AS n FROM live_products WHERE live_id = $1 AND pinned', [s.id]),
    ).toBe(1);
    expect((await a.client.post(`/v1/live/${s.id}/join`)).body.pinnedProduct.productId).toBe(p2.id);
    expect(
      (await host.client.del(`/v1/live/${s.id}/products/${p2.id}/pin`)).body.pinned,
    ).toBeNull();
    expect((await host.client.del(`/v1/live/${s.id}/products/${p2.id}`)).status).toBe(204);
    expect((await host.client.del(`/v1/live/${s.id}/products/${p2.id}`)).status).toBe(404);
    await setFlag('COMMERCE', false);
    try {
      expect((await a.client.get(`/v1/live/${s.id}/products`)).body).toEqual({
        items: [],
        pinned: null,
      });
      expect((await host.client.put(`/v1/live/${s.id}/products/${p2.id}`)).status).toBe(404);
      expect((await a.client.get(`/v1/live/${s.id}`)).status).toBe(200); // the room itself keeps working
    } finally {
      await setFlag('COMMERCE', true);
    }
    await host.client.post(`/v1/live/${s.id}/end`, {});
    expect((await host.client.put(`/v1/live/${s.id}/products/${p2.id}/pin`)).status).toBe(409);
  });
});

// ================================================================== markers, clips, recordings, translation
describe('markers, clips and recordings', () => {
  it('marks moments, validates clip ranges, and only turns a clip into a Studio project once a recording exists', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const s = await mkLive(host, {}, true);
    await sql(`UPDATE live_sessions SET started_at = now() - interval '10 minutes' WHERE id = $1`, [
      s.id,
    ]);
    await joined(a, s.id);
    expect((await a.client.post(`/v1/live/${s.id}/markers`, { label: 'x' })).status).toBe(403);
    const m = await host.client.post(`/v1/live/${s.id}/markers`, { label: 'big moment' });
    expect(m.status).toBe(201);
    expect(m.body.atMs).toBeGreaterThan(590_000);
    expect(
      (await host.client.post(`/v1/live/${s.id}/markers`, { label: 'manual', atMs: 1000 })).body
        .atMs,
    ).toBe(1000);
    expect(
      (await host.client.get(`/v1/live/${s.id}/markers`)).body.items.map((x: any) => x.atMs)[0],
    ).toBe(1000);
    expect((await a.client.get(`/v1/live/${s.id}/markers`)).status).toBe(403);

    expect(
      (await host.client.post(`/v1/live/${s.id}/clips`, { startMs: 0, endMs: 500 })).status,
    ).toBe(400);
    expect(
      (await host.client.post(`/v1/live/${s.id}/clips`, { startMs: 0, endMs: 700_000 })).status,
    ).toBe(400);
    expect(
      (await host.client.post(`/v1/live/${s.id}/clips`, { startMs: 500_000, endMs: 650_000 }))
        .status,
    ).toBe(400); // past the end of what happened
    expect(
      (await a.client.post(`/v1/live/${s.id}/clips`, { startMs: 0, endMs: 5000 })).status,
    ).toBe(403);
    const clip = await host.client.post(`/v1/live/${s.id}/clips`, {
      startMs: 60_000,
      endMs: 90_000,
      label: 'Best bit',
    });
    expect(clip.status).toBe(201);
    expect(clip.body).toMatchObject({ status: 'draft', studioProjectId: null });
    const noRec = await host.client.post(`/v1/live/${s.id}/clips/${clip.body.id}/studio`);
    expect(noRec.status).toBe(409);
    expect(noRec.body.error.details.reason).toBe('no_recording');

    const media = await fakeVideo(host);
    expect((await host.client.post(`/v1/live/${s.id}/recording`, { mediaId: media })).status).toBe(
      409,
    ); // after it ended
    await host.client.post(`/v1/live/${s.id}/end`, {});
    expect((await a.client.post(`/v1/live/${s.id}/recording`, { mediaId: media })).status).toBe(
      403,
    );
    expect(
      (await host.client.post(`/v1/live/${s.id}/recording`, { mediaId: await fakeVideo(a) }))
        .status,
    ).toBe(404); // someone else's media
    expect((await host.client.post(`/v1/live/${s.id}/recording`, { mediaId: media })).status).toBe(
      200,
    );
    expect((await host.client.get(`/v1/live/${s.id}/clips`)).body.hasRecording).toBe(true);
    const proj = await host.client.post(`/v1/live/${s.id}/clips/${clip.body.id}/studio`);
    expect(proj.status).toBe(201);
    const p = (await host.client.get(`/v1/studio/projects/${proj.body.studioProjectId}`)).body;
    expect(p).toMatchObject({ title: 'Best bit', mediaId: media, status: 'draft' });
    expect(p.edl.segments).toEqual([{ startMs: 60_000, endMs: 90_000 }]);
    expect((await host.client.post(`/v1/live/${s.id}/clips/${clip.body.id}/studio`)).status).toBe(
      409,
    ); // once
    expect(await n(`SELECT count(*)::int AS n FROM posts WHERE author_id = $1`, [host.id])).toBe(0); // nothing is published
  });
});

describe('translation hook', () => {
  it('is 501 without a provider and never invents a translation; with one it translates visible messages only', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const outsider = await signup(t);
    const s = await mkLive(host, {}, true);
    await joined(a, s.id);
    const msg = (await say(a, s.id, 'bonjour tout le monde')).body;
    const none = await a.client.post(`/v1/live/${s.id}/translate`, {
      messageId: msg.id,
      target: 'en',
    });
    expect(none.status).toBe(501);
    expect(none.body.error.details.reason).toBe('translation_unavailable');
    expect((await a.client.post(`/v1/live/${s.id}/translate`, { target: 'en' })).status).toBe(400);
    overrideLiveRuntime(t.ctx, {
      translation: { name: 'fake', translate: async (text, target) => `[${target}] ${text}` },
    });
    try {
      expect(
        (await a.client.post(`/v1/live/${s.id}/translate`, { messageId: msg.id, target: 'en' }))
          .body,
      ).toEqual({ text: '[en] bonjour tout le monde', target: 'en', provider: 'fake' });
      expect(
        (await a.client.post(`/v1/live/${s.id}/translate`, { text: 'hola', target: 'en' })).body
          .text,
      ).toBe('[en] hola');
      await host.client.del(`/v1/live/${s.id}/messages/${msg.id}`);
      expect(
        (await a.client.post(`/v1/live/${s.id}/translate`, { messageId: msg.id, target: 'en' }))
          .status,
      ).toBe(404);
      const priv = await mkLive(host, { visibility: 'private' });
      expect(
        (await outsider.client.post(`/v1/live/${priv.id}/translate`, { text: 'x', target: 'en' }))
          .status,
      ).toBe(404);
    } finally {
      overrideLiveRuntime(t.ctx, { translation: null });
    }
  });
});

// ================================================================== realtime
describe('WebSocket /v1/live/:id/ws', () => {
  it('uses single-use tickets, checks access before the upgrade, and joins/leaves with the socket', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const stranger = await signup(t);
    const s = await mkLive(host, {}, true);
    const priv = await mkLive(host, { visibility: 'private' });
    const ticket = await ticketFor(a);
    expect(await upgradeStatus(wsUrl(s.id, 'nope-nope-nope-nope-nope-nope'))).toBe(401);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/v1/live/${s.id}/ws`)).toBe(401);
    expect(await upgradeStatus(wsUrl(s.id, ticket), { origin: 'http://evil.example' })).toBe(403);
    // A rejected origin did not burn the ticket check order: the ticket is still redeemable once, and only once.
    const first = new WebSocket(wsUrl(s.id, ticket), { headers: { origin: ORIGIN } });
    const sock = new Sock(first);
    open.push(sock);
    await sock.expect((f) => f.type === 'ready');
    expect(await upgradeStatus(wsUrl(s.id, ticket))).toBe(401);
    expect((await viewers(s.id)).viewer_count).toBe(1);
    expect((await a.client.get(`/v1/live/${s.id}`)).body.viewerCount).toBe(1);
    sock.close();
    await sock.closed;
    for (let i = 0; i < 50 && (await viewers(s.id)).viewer_count !== 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await viewers(s.id)).viewer_count).toBe(0);
    // Hidden, scheduled and over sessions are refused before the upgrade.
    expect(await upgradeStatus(wsUrl(priv.id, await ticketFor(stranger)))).toBe(404);
    expect(await upgradeStatus(wsUrl(priv.id, await ticketFor(host)))).toBe(409); // visible to the host but not on air
    expect(
      await upgradeStatus(wsUrl('00000000-0000-4000-8000-000000000000', await ticketFor(a))),
    ).toBe(404);
    expect(await upgradeStatus(wsUrl('not-a-uuid', await ticketFor(a)))).toBe(404);
    await host.client.post(`/v1/live/${s.id}/end`, {});
    expect(await upgradeStatus(wsUrl(s.id, await ticketFor(a)))).toBe(409);
  });

  it('delivers chat, reactions and moderation events; filters blocked authors; applies the same rules as REST', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const s = await mkLive(host, {}, true);
    await block(c, a);
    const sa = await connect(a, s.id);
    const sb = await connect(b, s.id);
    const sc = await connect(c, s.id);
    const sh = await connect(host, s.id);
    await sb.expect((f) => f.type === 'viewers' && f.count === 3);
    // REST-posted and socket-posted messages both fan out; the server stamps the author.
    await say(a, s.id, 'from rest');
    expect((await sb.expect((f) => f.type === 'chat.message')).message).toMatchObject({
      body: 'from rest',
      userId: a.id,
    });
    sa.send({ type: 'chat', body: 'from socket' });
    const got = await sb.expect(
      (f) => f.type === 'chat.message' && f.message.body === 'from socket',
    );
    expect(got.message.userId).toBe(a.id);
    await sh.expect((f) => f.type === 'chat.message' && f.message.body === 'from socket');
    await sc.none((f) => f.type === 'chat.message' && f.message.userId === a.id); // c blocked a
    sb.send({ type: 'chat', body: 'I will kill you tomorrow' });
    expect((await sb.expect((f) => f.type === 'error')).code).toBe('unprocessable');
    sb.send({ type: 'react', kind: 'fire', count: 2 });
    expect(await sa.expect((f) => f.type === 'reaction')).toMatchObject({ kind: 'fire', count: 2 });
    sb.send('not json' as any);
    sb.ws.send('not json');
    expect((await sb.expect((f) => f.type === 'error' && f.code === 'invalid_frame')).code).toBe(
      'invalid_frame',
    );
    sb.send({ type: 'chat', body: '' });
    await sb.expect((f) => f.type === 'error' && f.code === 'invalid_frame');
    sb.send({ type: 'ping' });
    await sb.expect((f) => f.type === 'pong');

    // Mute: the muted person is told; others are not (except the team). Their next frame is refused by the same rules as REST.
    await host.client.put(`/v1/live/${s.id}/participants/${b.id}/mute`, { minutes: 5 });
    expect((await sb.expect((f) => f.type === 'muted')).until).toBeTruthy();
    await sa.none((f) => f.type === 'muted' || f.type === 'participant.muted');
    await sh.expect((f) => f.type === 'participant.muted' && f.userId === b.id);
    sb.send({ type: 'chat', body: 'muted talk' });
    expect(
      (await sb.expect((f) => f.type === 'error' && f.code === 'forbidden')).reason,
    ).toBeUndefined();

    // A removed message is announced; a ban closes that person's socket and hides the session from them.
    const msg = (await say(a, s.id, 'to be removed')).body;
    await host.client.del(`/v1/live/${s.id}/messages/${msg.id}`);
    expect((await sb.expect((f) => f.type === 'chat.hidden')).messageId).toBe(msg.id);
    await host.client.put(`/v1/live/${s.id}/participants/${a.id}/ban`, { reason: 'spam' });
    expect((await sa.expect((f) => f.type === 'removed')).reason).toBe('banned');
    expect((await sa.closed).code).toBe(4403);
    expect((await a.client.get(`/v1/live/${s.id}`)).status).toBe(404);
    expect(await upgradeStatus(wsUrl(s.id, await ticketFor(a)))).toBe(404);

    // Ending closes every socket with a final event.
    await host.client.post(`/v1/live/${s.id}/end`, {});
    expect((await sb.expect((f) => f.type === 'live.ended')).liveId).toBe(s.id);
    expect((await sb.closed).code).toBe(1000);
    expect((await sh.closed).code).toBe(1000);
  });

  it('drops a socket whose session ends, whose access vanishes, or that floods it', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const f = await signup(t);
    const s = await mkLive(host, {}, true);
    const sa = await connect(a, s.id);
    for (let i = 0; i < liveSocketSettings.frameBudget + 5; i++)
      sa.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await sa.closed).code).toBe(1008);
    // Heartbeat re-checks access: a block appearing without any event still ends the connection.
    liveSocketSettings.heartbeatMs = 60;
    const sf = await connect(f, s.id);
    await sql('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)', [host.id, f.id]);
    expect((await sf.closed).code).toBe(4404);
  });
});

// ================================================================== privacy
describe('privacy', () => {
  it('exports hosted sessions and my own chat, and account deletion ends what I host and removes my lines', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const s = await mkLive(host, {}, true);
    await joined(a, s.id);
    await say(a, s.id, 'remember me');
    await a.client.post(`/v1/live/${s.id}/questions`, { body: 'question?' });
    const { getExportSections } = await import('../src/modules/privacy/registry.js');
    const section = getExportSections().find((x) => x.key === 'live')!;
    const mine = (await section.collect(t.ctx, t.ctx.db as never, a.id)) as any;
    expect(mine.messages.map((m: any) => m.body)).toEqual(['remember me']);
    expect(mine.questions).toHaveLength(1);
    expect(
      ((await section.collect(t.ctx, t.ctx.db as never, host.id)) as any).hosted.map(
        (h: any) => h.id,
      ),
    ).toContain(s.id);
    const { getDeletionHooks } = await import('../src/lib/hooks.js');
    const run = async (id: string) => {
      const client = await t.ctx.db.connect();
      try {
        for (const h of getDeletionHooks()) await h(t.ctx, client, id);
      } finally {
        client.release();
      }
    };
    await run(a.id);
    expect(await n('SELECT count(*)::int AS n FROM live_messages WHERE user_id = $1', [a.id])).toBe(
      0,
    );
    expect((await viewers(s.id)).viewer_count).toBe(1); // the deleted viewer's presence is over (recounted on the next change)
    await run(host.id);
    expect(
      (await sql('SELECT status, end_reason FROM live_sessions WHERE id = $1', [s.id])).rows[0],
    ).toMatchObject({ status: 'ended', end_reason: 'host_deleted' });
  });
});
