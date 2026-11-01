import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
let ada: TestUser;
let bo: TestUser;
let chat: string;
beforeAll(async () => {
  t = await testApp();
  ada = await signUp(t.app, { birthDate: '1990-04-02' });
  bo = await signUp(t.app, { birthDate: '1990-04-02' });
  await as(t.app, ada).post(`/v1/users/${bo.id}/follow`);
  await as(t.app, bo).post(`/v1/users/${ada.id}/follow`);
  chat = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bo.id] })).body.conversation.id;
});
afterAll(() => t.close());

const connect = (u: TestUser) => {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) } as never);
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
};
const deliveredTo = async () =>
  (await as(t.app, ada).get(`/v1/conversations/${chat}`)).body.conversation.deliveredTo as { userId: string; lastDeliveredAt: string }[];
const send = (body: string) => as(t.app, ada).post(`/v1/conversations/${chat}/messages`, { body, clientId: `d-${body}-${Date.now()}` });

describe('delivered', () => {
  it('is nothing until their device gets it, then told to the sender when they come online', async () => {
    const sent = await send('while away');
    expect(sent.status).toBe(201);
    expect(await deliveredTo()).toEqual([]);
    const sender = connect(ada);
    // Their browser got the notification (or the app opened): delivered.
    expect((await as(t.app, bo).post('/v1/me/delivered')).status).toBe(200);
    const [mark] = await deliveredTo();
    expect(mark!.userId).toBe(bo.id);
    expect(new Date(mark!.lastDeliveredAt).getTime()).toBeGreaterThanOrEqual(new Date(sent.body.message.createdAt).getTime());
    expect(sender.of('conversation.delivered').map((e) => e.data)).toEqual([{ conversationId: chat, userId: bo.id, lastDeliveredAt: mark!.lastDeliveredAt }]);
    // Nothing new: nothing said.
    await as(t.app, bo).post('/v1/me/delivered');
    expect(sender.of('conversation.delivered')).toHaveLength(1);
    sender.remove();
  });

  it('is at once when they have the app connected', async () => {
    const sender = connect(ada);
    const them = connect(bo);
    const sent = await send('while online');
    const [mark] = await deliveredTo();
    expect(new Date(mark!.lastDeliveredAt).getTime()).toBeGreaterThanOrEqual(new Date(sent.body.message.createdAt).getTime());
    expect(sender.of('conversation.delivered')).toHaveLength(1);
    // Your own delivery isn't a thing: the sender's connection doesn't mark anything for themselves.
    expect((await as(t.app, bo).get(`/v1/conversations/${chat}`)).body.conversation.deliveredTo).toEqual([]);
    sender.remove();
    them.remove();
  });
});
