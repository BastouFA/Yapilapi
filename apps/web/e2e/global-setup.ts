import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { request, type APIRequestContext, type APIResponse, type FullConfig } from '@playwright/test';

export const AUTH_DIR = path.join(import.meta.dirname, '.auth');
export const STATE = path.join(AUTH_DIR, 'state.json');
/** The second user (Ben): hosts audio rooms that the tests open fresh. */
export const FRIEND_STATE = path.join(AUTH_DIR, 'friend.json');
export const DATA = path.join(AUTH_DIR, 'data.json');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

export interface SeedData {
  username: string;
  userId: string;
  friendId: string;
  communitySlug: string;
  eventId: string;
  placeId: string;
  conversationId: string;
  postId: string;
  businessSlug: string;
  boardId: string;
  draftId: string;
  friendUsername: string;
  circleId: string;
  chapterId: string;
  recapId: string;
  /** Whether the recap video finished rendering before the tests started. */
  recapReady: boolean;
  soundId: string;
  /** The message Ben sent that the keyboard test replies to. */
  replyTargetId: string;
}

async function must(p: Promise<APIResponse>) {
  const res = await p;
  if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`);
  return res.json();
}

/** Upload a fixture photo or video as this user (POST /v1/media), with a description. */
async function upload(ctx: APIRequestContext, file: string, mimeType: string, altText: string): Promise<{ id: string; url: string; kind: string }> {
  const buffer = await readFile(path.join(FIXTURES, file));
  // Fields before the file, so the server reads them with it.
  const r = await must(ctx.post('/api/v1/media', { multipart: { altText, file: { name: file, mimeType, buffer } } }));
  return r.media;
}

/**
 * A live audio room hosted by Ben in a new community of his, joined by the main
 * user, for tests that open a room. A community holds one live room at a time
 * and a room without its host ends after a few minutes, so each test gets its own.
 */
export async function liveRoom(baseURL: string, title = 'Sunday night radio'): Promise<string> {
  const host = await request.newContext({ baseURL, storageState: FRIEND_STATE });
  const guest = await request.newContext({ baseURL, storageState: STATE });
  try {
    const slug = `a11y-room-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    await must(
      host.post('/api/v1/communities', { data: { name: 'Night Owls', slug, description: 'Late-night talk about food and music.', topics: ['music'] } }),
    );
    await must(guest.post(`/api/v1/communities/${slug}/join`, { data: {} }));
    const { room } = await must(host.post(`/api/v1/communities/${slug}/rooms`, { data: { title } }));
    // The host is on stage, so the room has a speaker.
    await must(host.post(`/api/v1/rooms/${room.id}/join`, { data: {} }));
    return room.id;
  } finally {
    await host.dispose();
    await guest.dispose();
  }
}

/**
 * Signs up three fresh users through the web app's /api proxy (so the session
 * cookie belongs to the web origin) and gives the main one something on every
 * page: posts with photos, a draft and a scheduled post, a board, a circle, a
 * chapter and a recap video, a community, an event at a place, a conversation
 * with a reply and a pinned message, stories (one with music and stickers), a
 * status, a cover photo and grouped notifications. Every run uses new accounts
 * with random throwaway passwords.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!;
  const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

  async function signUp(name: string, displayName: string): Promise<{ ctx: APIRequestContext; id: string; username: string }> {
    const ctx = await request.newContext({ baseURL });
    const username = `a11y_${name}_${run}`.slice(0, 30);
    const res = await ctx.post('/api/v1/auth/register', {
      data: {
        email: `${username}@a11y.example.test`,
        password: randomBytes(18).toString('base64url'),
        username,
        displayName,
        birthDate: '1990-05-01',
      },
    });
    if (res.status() !== 201) throw new Error(`Sign-up failed (${res.status()}): ${await res.text()}. Is the API reachable through ${baseURL}/api?`);
    const { user } = await res.json();
    await must(ctx.put('/api/v1/me/interests', { data: { topics: ['music', 'food', 'design'] } }));
    await must(ctx.post('/api/v1/me/onboarding/complete', { data: {} }));
    return { ctx, id: user.id, username };
  }

  const flags = (await must((await request.newContext({ baseURL })).get('/api/v1/flags'))).flags as Record<string, boolean>;
  if (!flags.MEMORY)
    throw new Error(
      'The MEMORY feature flag is off, so memories, chapters and recaps would only show "turned off". Turn it on in the audit database first ' +
        `(see docs/accessibility.md): INSERT INTO feature_flags (key, enabled) VALUES ('MEMORY', true) ON CONFLICT (key) DO UPDATE SET enabled = true`,
    );

  const main = await signUp('main', 'Ada Access');
  const friend = await signUp('ben', 'Ben Keyboard');
  const third = await signUp('cleo', 'Cleo Contrast');

  const post = await must(main.ctx.post('/api/v1/posts', { data: { body: 'Sunday market run: peaches, bread and a new mug. #food', topics: ['food'] } }));
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

  // A shop run by the friend, so the main user can open checkout.
  const businessSlug = `a11y-shop-${run}`.slice(0, 40);
  const business = await must(friend.ctx.post('/api/v1/businesses', { data: { name: 'Corner Pantry', slug: businessSlug } }));
  await must(friend.ctx.post('/api/v1/products', { data: { title: 'Sourdough loaf', priceCents: 650, businessId: business.business.id } }));

  await must(friend.ctx.post(`/api/v1/users/${main.id}/follow`, { data: {} }));
  await must(third.ctx.post(`/api/v1/users/${main.id}/follow`, { data: {} }));
  await must(main.ctx.post(`/api/v1/users/${friend.id}/follow`, { data: {} }));
  await must(friend.ctx.post(`/api/v1/communities/${communitySlug}/join`, { data: {} }));

  // Photos: a post with two, a cover, and stories for a chapter and the archive.
  const market = await upload(main.ctx, 'market.jpg', 'image/jpeg', 'Peaches and plums piled on a market stall at sunset');
  const bread = await upload(main.ctx, 'bread.jpg', 'image/jpeg', 'A round sourdough loaf on a linen cloth');
  const cover = await upload(main.ctx, 'cover.jpg', 'image/jpeg', 'The river at dusk, pink and blue');
  const photoPost = await must(
    main.ctx.post('/api/v1/posts', {
      data: {
        body: 'Market haul, in pictures. #food',
        topics: ['food'],
        media: [
          { id: market.id, url: market.url, kind: 'image', altText: 'Peaches and plums piled on a market stall at sunset' },
          { id: bread.id, url: bread.url, kind: 'image', altText: 'A round sourdough loaf on a linen cloth' },
        ],
      },
    }),
  );
  const storyA = await must(main.ctx.post('/api/v1/moments', { data: { body: 'First stop: the market', mediaId: market.id, visibility: 'followers' } }));
  const storyB = await must(main.ctx.post('/api/v1/moments', { data: { body: 'Then bread', mediaId: bread.id, visibility: 'followers' } }));

  // Grouped notifications: two people like the same post, one comments.
  for (const u of [friend, third]) await must(u.ctx.put(`/api/v1/posts/${post.post.id}/reaction`, { data: { kind: 'like' } }));
  await must(friend.ctx.post(`/api/v1/posts/${post.post.id}/comments`, { data: { body: 'Those peaches look perfect.' } }));

  // Drafts: one saved for later, one scheduled for next week.
  const draft = await must(
    main.ctx.post('/api/v1/posts', { data: { body: 'Half-written: my favourite soup recipes, ranked.', draft: true, visibility: 'followers' } }),
  );
  await must(
    main.ctx.post('/api/v1/posts', {
      data: {
        body: 'Supper club is back next week. Who is bringing dessert?',
        visibility: 'followers',
        scheduledAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
    }),
  );

  // A board with the two posts, and a saved post from Ben.
  const friendPost = await must(
    friend.ctx.post('/api/v1/posts', { data: { body: 'Proofing schedule for a weekend loaf, step by step. #food', topics: ['food'] } }),
  );
  await must(main.ctx.put(`/api/v1/posts/${friendPost.post.id}/save`, { data: {} }));
  const board = await must(
    main.ctx.post('/api/v1/boards', {
      data: { name: 'Weekend cooking', description: 'Recipes and markets to try.', visibility: 'public', postIds: [photoPost.post.id, friendPost.post.id] },
    }),
  );

  // A circle with Ben in it.
  const circle = await must(main.ctx.post('/api/v1/me/circles', { data: { name: 'Supper club', kind: 'custom' } }));
  await must(main.ctx.post(`/api/v1/me/circles/${circle.circle.id}/members`, { data: { userIds: [friend.id] } }));

  // Status, cover photo (once its sizes are ready) and Ben's status for the chat header.
  await must(main.ctx.put('/api/v1/me/status', { data: { text: 'Testing with a keyboard', icon: 'sparkle', audience: 'everyone' } }));
  await must(friend.ctx.put('/api/v1/me/status', { data: { text: 'Baking all day', icon: 'heart', audience: 'everyone' } }));
  for (let i = 0; i < 30; i++) {
    const res = await main.ctx.put('/api/v1/me/cover', { data: { mediaId: cover.id } });
    if (res.ok()) break;
    if (res.status() !== 409) throw new Error(`cover → ${res.status()} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // A reel by Ben: its sound gets a page, and plays in his story.
  const clip = await upload(friend.ctx, 'clip.mp4', 'video/mp4', 'A yellow square on blue');
  const reel = await must(
    friend.ctx.post('/api/v1/posts', {
      data: { format: 'reel', body: 'Oven timer beats', soundTitle: 'Oven timer beats', media: [{ id: clip.id, url: clip.url, kind: 'video' }] },
    }),
  );
  const soundId = reel.post.sound.id as string;

  // Ben's story, with music and stickers, for the story viewer checks.
  await must(
    friend.ctx.post('/api/v1/moments', {
      data: {
        body: 'Proofing the dough since 6am',
        visibility: 'followers',
        music: { soundId, startMs: 0, durationMs: 5000, style: 'compact', x: 0.5, y: 0.8 },
        stickers: [
          { type: 'poll', x: 0.5, y: 0.35, question: 'Crust or crumb?', options: ['Crust', 'Crumb'] },
          { type: 'hashtag', x: 0.3, y: 0.6, tag: 'food' },
        ],
      },
    }),
  );

  // A chapter of two stories, and a recap video made from it.
  const chapter = await must(
    main.ctx.post('/api/v1/chapters', {
      data: { title: 'Lisbon weekend', description: 'Markets, bread and the river.', audience: 'followers', momentIds: [storyA.moment.id, storyB.moment.id] },
    }),
  );
  const recap = await must(
    main.ctx.post('/api/v1/recaps', {
      data: { source: 'chapter', sourceId: chapter.chapter.id, title: 'Lisbon weekend', mediaIds: [market.id, bread.id], style: 'calm', aspect: '9:16' },
    }),
  );
  let recapReady = false;
  for (let i = 0; i < 90 && !recapReady; i++) {
    const r = await must(main.ctx.get(`/api/v1/recaps/${recap.recap.id}`));
    if (r.recap.status === 'failed') throw new Error(`The recap failed to render: ${JSON.stringify(r.recap)}`);
    recapReady = r.recap.status === 'ready';
    if (!recapReady) await new Promise((res) => setTimeout(res, 1000));
  }
  if (!recapReady)
    console.warn('The recap is still rendering: is the API running its job worker (JOB_WORKER=true)? The recaps page is audited without a ready video.');

  // A conversation with a reply, a pinned message and disappearing messages on.
  const convo = await must(friend.ctx.post('/api/v1/conversations', { data: { memberIds: [main.id] } }));
  const conversationId = convo.conversation.id;
  const question = await must(
    friend.ctx.post(`/api/v1/conversations/${conversationId}/messages`, { data: { body: 'Are you coming to the supper on Thursday?' } }),
  );
  const answer = await must(
    main.ctx.post(`/api/v1/conversations/${conversationId}/messages`, { data: { body: 'Yes! I will bring soup.', replyToId: question.message.id } }),
  );
  const reminder = await must(
    friend.ctx.post(`/api/v1/conversations/${conversationId}/messages`, { data: { body: 'Great. It starts at 7, doors open at 6:30.' } }),
  );
  await must(friend.ctx.put(`/api/v1/messages/${reminder.message.id}/pin`, { data: {} }));
  await must(friend.ctx.put(`/api/v1/messages/${answer.message.id}/reactions/${encodeURIComponent('❤️')}`, { data: {} }));
  await must(friend.ctx.put(`/api/v1/conversations/${conversationId}/disappearing`, { data: { seconds: 604800 } }));

  await mkdir(AUTH_DIR, { recursive: true });
  await main.ctx.storageState({ path: STATE });
  await friend.ctx.storageState({ path: FRIEND_STATE });
  const data: SeedData = {
    username: main.username,
    userId: main.id,
    friendId: friend.id,
    communitySlug,
    eventId: event.event.id,
    placeId: place.place.id,
    conversationId,
    postId: post.post.id,
    businessSlug,
    boardId: board.board.id,
    draftId: draft.post.id,
    friendUsername: friend.username,
    circleId: circle.circle.id,
    chapterId: chapter.chapter.id,
    recapId: recap.recap.id,
    recapReady,
    soundId,
    replyTargetId: reminder.message.id,
  };
  await writeFile(DATA, JSON.stringify(data, null, 2));
  for (const u of [main, friend, third]) await u.ctx.dispose();
}
