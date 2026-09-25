import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { request, type APIRequestContext, type FullConfig } from '@playwright/test';

export const AUTH_DIR = path.join(import.meta.dirname, '.auth');
export const STATE = path.join(AUTH_DIR, 'state.json');
export const DATA = path.join(AUTH_DIR, 'data.json');

export interface SeedData {
  username: string;
  communitySlug: string;
  eventId: string;
  placeId: string;
  conversationId: string;
}

/**
 * Signs up two fresh users through the web app's /api proxy (so the session
 * cookie belongs to the web origin) and gives the main one something on every
 * page: a post, a community, an event at a place, a conversation and
 * notifications. Every run uses new accounts with random throwaway passwords.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!;
  const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

  async function signUp(name: string): Promise<{ ctx: APIRequestContext; id: string; username: string }> {
    const ctx = await request.newContext({ baseURL });
    const username = `a11y_${name}_${run}`.slice(0, 30);
    const res = await ctx.post('/api/v1/auth/register', {
      data: {
        email: `${username}@a11y.example.test`,
        password: randomBytes(18).toString('base64url'),
        username,
        displayName: name === 'main' ? 'Ada Access' : 'Ben Keyboard',
        birthDate: '1990-05-01',
      },
    });
    if (res.status() !== 201) throw new Error(`Sign-up failed (${res.status()}): ${await res.text()}. Is the API reachable through ${baseURL}/api?`);
    const { user } = await res.json();
    await must(ctx.put('/api/v1/me/interests', { data: { topics: ['music', 'food', 'design'] } }));
    await must(ctx.post('/api/v1/me/onboarding/complete', { data: {} }));
    return { ctx, id: user.id, username };
  }

  async function must(p: Promise<import('@playwright/test').APIResponse>) {
    const res = await p;
    if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`);
    return res.json();
  }

  const main = await signUp('main');
  const friend = await signUp('ben');

  await must(main.ctx.post('/api/v1/posts', { data: { body: 'Sunday market run: peaches, bread and a new mug. #food', topics: ['food'] } }));
  const communitySlug = `a11y-${run}`.slice(0, 40);
  const community = await must(
    main.ctx.post('/api/v1/communities', {
      data: { name: 'Keyboard Cooks', slug: communitySlug, description: 'Recipes you can make without a mouse.', topics: ['food'], rules: ['Be kind'] },
    }),
  );
  await must(main.ctx.post('/api/v1/posts', { data: { body: 'Welcome! Share your favourite one-pot recipe.', communityId: community.community.id } }));
  const place = await must(
    main.ctx.post('/api/v1/places', { data: { name: 'Corner Kitchen', category: 'restaurant', address: '1 Market St', city: 'Lisbon', country: 'PT' } }),
  );
  // Hosted by the friend, so the main user sees the RSVP controls.
  const event = await must(
    friend.ctx.post('/api/v1/events', {
      data: {
        title: 'Community supper',
        description: 'Bring a dish to share.',
        startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        placeId: place.place.id,
        capacity: 30,
      },
    }),
  );

  await must(friend.ctx.post(`/api/v1/users/${main.id}/follow`, { data: {} }));
  await must(friend.ctx.post(`/api/v1/communities/${communitySlug}/join`, { data: {} }));
  const convo = await must(friend.ctx.post('/api/v1/conversations', { data: { memberIds: [main.id] } }));
  const conversationId = convo.conversation.id;
  await must(friend.ctx.post(`/api/v1/conversations/${conversationId}/messages`, { data: { body: 'Are you coming to the supper on Thursday?' } }));
  await must(main.ctx.post(`/api/v1/conversations/${conversationId}/messages`, { data: { body: 'Yes! I will bring soup.' } }));

  await mkdir(AUTH_DIR, { recursive: true });
  await main.ctx.storageState({ path: STATE });
  const data: SeedData = { username: main.username, communitySlug, eventId: event.event.id, placeId: place.place.id, conversationId };
  await writeFile(DATA, JSON.stringify(data, null, 2));
  await main.ctx.dispose();
  await friend.ctx.dispose();
}
