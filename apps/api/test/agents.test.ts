import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgent } from '../src/lib/ai/agents.ts';
import type { AiProvider } from '../src/lib/ai/providers.ts';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const tag = () => Math.random().toString(36).slice(2, 8);

describe('AI agents', () => {
  it('Discover finds visible events and never private ones', async () => {
    const host = await signUp(t.app);
    const me = await signUp(t.app);
    const word = `zydeco${tag()}`;
    const pub = (await as(t.app, host).post('/v1/events', { title: `${word} night by the river`, startsAt: inDays(3) })).body.event;
    const priv = (await as(t.app, host).post('/v1/events', { title: `${word} secret party`, startsAt: inDays(3), visibility: 'private' })).body.event;
    const r = await as(t.app, me).post('/v1/ai/agents/discover', { prompt: word });
    expect(r.status).toBe(200);
    const ids = r.body.recommendations.map((x: any) => x.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);
    expect(r.body.recommendations[0]).toMatchObject({ type: 'event', href: `/events/${pub.id}` });
    expect(r.body.notice).toMatch(/development provider/);
    const logged = await t.ctx.db.query(`SELECT status FROM ai_tool_calls WHERE user_id = $1 AND task = 'agent:discover'`, [me.id]);
    expect(logged.rows[0].status).toBe('ok');
  });

  it('only accepts recommendations and actions for items a tool returned', async () => {
    const host = await signUp(t.app);
    const me = await signUp(t.app);
    const word = `kizomba${tag()}`;
    const ev = (await as(t.app, host).post('/v1/events', { title: `${word} social`, startsAt: inDays(2) })).body.event;
    const hidden = (await as(t.app, host).post('/v1/events', { title: 'Hidden', startsAt: inDays(2), visibility: 'private' })).body.event;
    const replies: string[] = [];
    // A scripted "model" that tries to cheat before doing it properly.
    const provider: AiProvider = {
      name: 'scripted',
      model: 'scripted-1',
      complete: async () => ({ text: '', provider: 'scripted', model: 'scripted-1' }),
      agent: async ({ tools }) => {
        const tool = (n: string) => tools.find((x) => x.name === n)!;
        replies.push(await tool('recommend').run({ type: 'event', id: hidden.id, reason: 'guess' }));
        replies.push(await tool('propose_action').run({ type: 'event', id: hidden.id }));
        await tool('search').run({ query: word, type: 'events' });
        replies.push(await tool('recommend').run({ type: 'event', id: ev.id, reason: 'It matches.' }));
        replies.push(await tool('propose_action').run({ type: 'event', id: ev.id }));
        return { text: 'One good option.', provider: 'scripted', model: 'scripted-1' };
      },
    };
    const res = await runAgent(t.ctx.db, provider, me.id, 'travel', `${word} this weekend`);
    expect(replies[0]).toMatch(/Not shown/);
    expect(replies[1]).toMatch(/Not proposed/);
    expect(res.recommendations.map((r) => r.id)).toEqual([ev.id]);
    expect(res.actions).toEqual([expect.objectContaining({ kind: 'rsvp', label: `RSVP: ${word} social` })]);
    expect(res.contextScopes).toContain('search');
  });

  it('withholds unsafe output', async () => {
    const me = await signUp(t.app);
    const provider: AiProvider = {
      name: 'scripted',
      model: 'scripted-1',
      complete: async () => ({ text: '', provider: 'scripted', model: 'scripted-1' }),
      agent: async () => ({ text: 'x', provider: 'scripted', model: 'scripted-1', refused: true }),
    };
    const res = await runAgent(t.ctx.db, provider, me.id, 'discover', 'anything fun');
    expect(res.text).toBe('');
    expect(res.notice).toMatch(/withheld/);
  });

  it('business assistant only works for the owner and reports real numbers', async () => {
    const owner = await signUp(t.app);
    const guest = await signUp(t.app);
    const biz = (await as(t.app, owner).post('/v1/businesses', { name: 'Agent Cafe', slug: `agent-cafe-${tag()}` })).body.business;
    const place = (await as(t.app, owner).post('/v1/places', { name: 'Agent Cafe', category: 'restaurant', businessId: biz.id })).body.place;
    expect((await as(t.app, guest).put(`/v1/places/${place.id}/reviews`, { rating: 4, body: 'Lovely pastries' })).status).toBe(200);
    expect((await as(t.app, guest).post('/v1/ai/agents/business', { prompt: 'How am I doing?', businessId: biz.id })).status).toBe(404);
    const r = await as(t.app, owner).post('/v1/ai/agents/business', { prompt: 'How am I doing?', businessId: biz.id });
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/1 new review averaging 4 out of 5/);
    expect(r.body.contextScopes).toContain(`business:${biz.id}`);
  });

  it('rejects unknown agents and empty prompts', async () => {
    const me = await signUp(t.app);
    expect((await as(t.app, me).post('/v1/ai/agents/stocks', { prompt: 'buy' })).status).toBe(400);
    expect((await as(t.app, me).post('/v1/ai/agents/discover', { prompt: '' })).status).toBe(400);
    expect((await as(t.app, null).post('/v1/ai/agents/discover', { prompt: 'jazz' })).status).toBe(401);
  });
});
