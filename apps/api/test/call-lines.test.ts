import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, of: (type: string) => events.filter((e) => e.type === type) };
}

async function chat(a: TestUser, others: TestUser[]) {
  for (const o of others) await befriend(a, o);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: others.map((o) => o.id), ...(others.length > 1 ? { title: 'Crew' } : {}) });
  return r.body.conversation.id as string;
}

const callLines = async (u: TestUser, c: string) =>
  ((await as(t.app, u).get(`/v1/conversations/${c}/messages`)).body.items as any[]).filter((m) => m.system?.type === 'call').map((m) => m.system);

describe('call history in the chat', () => {
  it('writes a line when a call ends, is declined or missed, and tells everyone it is over', async () => {
    const [ada, bo] = [await adult(), await adult()];
    const c = await chat(ada, [bo]);
    const boLive = connect(bo);

    let call = (await as(t.app, ada).post(`/v1/conversations/${c}/calls`, { kind: 'video' })).body.call;
    await as(t.app, bo).post(`/v1/calls/${call.id}/answer`);
    await db().query(`UPDATE calls SET answered_at = now() - interval '185 seconds' WHERE id = $1`, [call.id]);
    await as(t.app, bo).post(`/v1/calls/${call.id}/end`);
    expect(boLive.of('call.ended').at(-1)?.data).toEqual({ callId: call.id, status: 'ended' });

    call = (await as(t.app, ada).post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).body.call;
    await as(t.app, bo).post(`/v1/calls/${call.id}/decline`);

    call = (await as(t.app, ada).post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).body.call;
    await as(t.app, ada).post(`/v1/calls/${call.id}/end`);

    // Nobody answers and every app has gone: the ring runs out on the server.
    call = (await as(t.app, ada).post(`/v1/conversations/${c}/calls`, { kind: 'video' })).body.call;
    await db().query(`UPDATE jobs SET run_at = now() WHERE kind = 'calls.ring_timeout' AND payload->>'id' = $1`, [call.id]);
    await runJobs(t.ctx.jobs);
    expect((await as(t.app, ada).get(`/v1/calls/${call.id}`)).body.call.status).toBe('missed');

    const lines = await callLines(bo, c);
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'video', outcome: 'ended', seconds: expect.any(Number) }),
      expect.objectContaining({ kind: 'audio', outcome: 'declined', seconds: null }),
      expect.objectContaining({ kind: 'audio', outcome: 'missed' }),
      expect.objectContaining({ kind: 'video', outcome: 'missed' }),
    ]);
    expect(lines[0].seconds).toBeGreaterThanOrEqual(185);
    // A call's line is written once, however it ends.
    await as(t.app, ada).post(`/v1/calls/${call.id}/end`);
    expect(await callLines(bo, c)).toHaveLength(4);
  });

  it('tells the caller someone is busy, and ends a group call when nobody is left', async () => {
    const [ada, bo, cy] = [await adult(), await adult(), await adult()];
    const c = await chat(ada, [bo]);
    const adaLive = connect(ada);
    const call = (await as(t.app, ada).post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).body.call;
    await as(t.app, bo).post(`/v1/calls/${call.id}/decline`, { busy: true });
    expect(adaLive.of('call.declined').at(-1)?.data).toMatchObject({ callId: call.id, userId: bo.id, busy: true });

    const g = await chat(ada, [bo, cy]);
    const cyLive = connect(cy);
    const gc = (await as(t.app, ada).post(`/v1/conversations/${g}/calls`, { kind: 'audio' })).body.call;
    // One declines: the others still ring.
    await as(t.app, bo).post(`/v1/calls/${gc.id}/decline`);
    expect((await as(t.app, ada).get(`/v1/calls/${gc.id}`)).body.call.status).toBe('ringing');
    // The caller gives up: Cy stops ringing.
    await as(t.app, ada).post(`/v1/calls/${gc.id}/end`);
    expect(cyLive.of('call.ended').at(-1)?.data).toEqual({ callId: gc.id, status: 'missed' });
  });

  it('follows the rules for messaging in one-to-one chats, and never rings a community chat', async () => {
    const [ada, teen] = [await adult(), await signUp(t.app, { birthDate: '2011-02-02' })];
    const c = await chat(ada, [teen]);
    // They stop being friends: the chat stays, calls stop.
    await db().query(`DELETE FROM friendships WHERE user_a = ANY($1::uuid[]) AND user_b = ANY($1::uuid[])`, [[ada.id, teen.id]]);
    const r = await as(t.app, ada).post(`/v1/conversations/${c}/calls`, { kind: 'audio' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('minor_protection');

    const community = await db().query(`INSERT INTO conversations (kind, title, created_by) VALUES ('community', 'Club', $1) RETURNING id`, [ada.id]);
    const other = await adult();
    await db().query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)`, [community.rows[0].id, ada.id, other.id]);
    expect((await as(t.app, ada).post(`/v1/conversations/${community.rows[0].id}/calls`, { kind: 'audio' })).status).toBe(400);
  });
});
