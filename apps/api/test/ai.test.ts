import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiGateway } from '../src/lib/ai/gateway.ts';
import type { AiProvider } from '../src/lib/ai/providers.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * AI evaluation suite. Runs against the gateway with scripted providers so it is
 * deterministic and offline. It checks the properties that must hold for any
 * model: permissions before context, privacy of other people's data, output
 * safety, faithful summaries and audit logging.
 */
describe('AI gateway', () => {
  let t: BuiltApp;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let convId: string;
  let privateCommunityId: string;

  beforeAll(async () => {
    t = await testApp();
    alice = await signUp(t.app);
    bob = await signUp(t.app);
    eve = await signUp(t.app);
    convId = (await as(t.app, alice).post('/v1/conversations', { memberIds: [bob.id] })).body.conversation.id;
    await as(t.app, alice).post(`/v1/conversations/${convId}/messages`, { body: 'Dinner at 8 on Friday?' });
    await as(t.app, bob).post(`/v1/conversations/${convId}/messages`, { body: 'Yes, I will book the table for four.' });
    privateCommunityId = (
      await as(t.app, alice).post('/v1/communities', { name: 'Secret Garden', slug: `secret-${Date.now().toString(36)}`, visibility: 'private' })
    ).body.community.id;
    await as(t.app, alice).post('/v1/posts', { body: 'Members-only update: the garden opens in May.', communityId: privateCommunityId });
  });
  afterAll(() => t.close());

  const spyProvider = (reply: string) => {
    const seen: string[] = [];
    const provider: AiProvider = {
      name: 'spy',
      model: 'spy-1',
      complete: async ({ prompt }) => (seen.push(prompt), { text: reply, provider: 'spy', model: 'spy-1' }),
    };
    return { provider, seen };
  };

  it('permissions: never loads a conversation for a non-member, and never calls the model', async () => {
    const { provider, seen } = spyProvider('summary');
    const gw = new AiGateway(t.ctx.db, provider);
    await expect(gw.run({ userId: eve.id, task: 'summarize_conversation', input: '', conversationId: convId })).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(0);
  });

  it('privacy: private community content stays out of reach for outsiders', async () => {
    const { provider, seen } = spyProvider('summary');
    const gw = new AiGateway(t.ctx.db, provider);
    await expect(gw.run({ userId: eve.id, task: 'summarize_community', input: '', communityId: privateCommunityId })).rejects.toMatchObject({ status: 404 });
    expect(seen.join(' ')).not.toContain('garden opens');
    const ok = await gw.run({ userId: alice.id, task: 'summarize_community', input: '', communityId: privateCommunityId });
    expect(ok.contextScopes).toEqual([`community:${privateCommunityId}`]);
    expect(seen.at(-1)).toContain('garden opens in May');
  });

  it('context: the model sees only the requested conversation', async () => {
    const { provider, seen } = spyProvider('They agreed on dinner Friday at 8.');
    const gw = new AiGateway(t.ctx.db, provider);
    const r = await gw.run({ userId: bob.id, task: 'summarize_conversation', input: '', conversationId: convId });
    expect(r.output).toBe('They agreed on dinner Friday at 8.');
    expect(seen[0]).toContain('Dinner at 8 on Friday?');
    expect(seen[0]).not.toContain('garden');
  });

  it('safety: unsafe model output is withheld', async () => {
    const { provider } = spyProvider('free crypto, click this link to claim');
    const gw = new AiGateway(t.ctx.db, provider);
    const r = await gw.run({ userId: alice.id, task: 'caption', input: 'my holiday' });
    expect(r.output).toBeNull();
    expect(r.notice).toMatch(/withheld/);
  });

  it('safety: high-risk input is refused before reaching the model', async () => {
    const { provider, seen } = spyProvider('ok');
    const gw = new AiGateway(t.ctx.db, provider);
    await expect(gw.run({ userId: alice.id, task: 'caption', input: 'you should kill yourself' })).rejects.toMatchObject({ status: 403 });
    expect(seen).toHaveLength(0);
  });

  it('translation keeps the original text available', async () => {
    const { provider } = spyProvider('Bonjour tout le monde');
    const gw = new AiGateway(t.ctx.db, provider);
    const r = await gw.run({ userId: alice.id, task: 'translate', input: 'Hello everyone', targetLanguage: 'fr' });
    expect(r.output).toEqual({ original: 'Hello everyone', translated: 'Bonjour tout le monde', targetLanguage: 'fr' });
  });

  it('plans: malformed model JSON falls back to a safe structure', async () => {
    const { provider } = spyProvider('not json at all');
    const gw = new AiGateway(t.ctx.db, provider);
    const r = await gw.run({ userId: alice.id, task: 'plan_from_message', input: "Let's go to Paris next month." });
    expect(r.output).toMatchObject({ destination: 'Paris', dates: 'next month' });
  });

  it('audit: every call is logged with scopes and status, without content', async () => {
    const { rows } = await t.ctx.db.query(`SELECT task, status, context_scopes FROM ai_tool_calls WHERE user_id = $1 ORDER BY id`, [eve.id]);
    expect(rows.map((r) => r.status)).toEqual(['denied', 'denied']);
    const cols = (await t.ctx.db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_tool_calls'`)).rows.map((r) => r.column_name);
    expect(cols).not.toContain('prompt');
    expect(cols).not.toContain('output');
  });
});
