import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { request, type APIRequestContext, type APIResponse, type FullConfig } from '@playwright/test';

export const AUTH_DIR = path.join(import.meta.dirname, '.auth');
export const STATE = path.join(AUTH_DIR, 'state.json');
/** The second user (Ben): hosts audio rooms that the tests open fresh. */
export const FRIEND_STATE = path.join(AUTH_DIR, 'friend.json');
/** The third user (Cleo): starts watch together sessions that the tests open fresh. */
export const THIRD_STATE = path.join(AUTH_DIR, 'third.json');
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
  /** Ben's reels: the first plain, the second with highlights and a moment comment. */
  reelId: string;
  reel2Id: string;
  /** The message Ben sent that the keyboard test replies to. */
  replyTargetId: string;
  /** A one-to-one chat with Cleo: a wallpaper, a scheduled message and three games (your turn in each). */
  gamesChatId: string;
  /** Ben's drop (scheduled, you asked to be told) and your own draft drop. */
  dropId: string;
  myDropId: string;
  /** This week's wrap (made through the development-only hook). */
  wrapId: string | null;
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
 * A watch together session in the chat with Cleo, started by her with Ben's reel queued. People
 * whose player goes quiet leave after 45 seconds and a session nobody watches ends, so each test
 * that opens one asks for it here (it joins the session still running, or starts a new one).
 */
export async function watchSession(baseURL: string): Promise<string> {
  const d: SeedData = JSON.parse(await readFile(DATA, 'utf8'));
  const cleo = await request.newContext({ baseURL, storageState: THIRD_STATE });
  try {
    const r = await must(cleo.post('/api/v1/watch', { data: { conversationId: d.gamesChatId, postIds: [d.reelId] } }));
    return r.session.id;
  } finally {
    await cleo.dispose();
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
  // A second shop of his for a drop (products in a drop wait for it to open; the first shop's Buy opens checkout).
  const dropShop = await must(friend.ctx.post('/api/v1/businesses', { data: { name: 'Corner Bakes', slug: `a11y-bakes-${run}`.slice(0, 40) } }));
  const bakery = await must(friend.ctx.post('/api/v1/products', { data: { title: 'Rye loaf', priceCents: 700, businessId: dropShop.business.id } }));

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
  // A second reel by Ben, with highlights and a moment comment from the main user, for the Reels viewer checks.
  const clip2 = await upload(friend.ctx, 'clip.mp4', 'video/mp4', 'The yellow square again, slower');
  const reel2 = await must(
    friend.ctx.post('/api/v1/posts', {
      data: {
        format: 'reel',
        body: 'Second batch: the crust at 1 minute, the crumb at 4. #baking',
        media: [{ id: clip2.id, url: clip2.url, kind: 'video' }],
        highlights: [
          { atMs: 1000, label: 'Crust' },
          { atMs: 4000, label: 'Crumb' },
        ],
      },
    }),
  );
  await must(main.ctx.post(`/api/v1/posts/${reel2.post.id}/comments`, { data: { body: 'That crumb looks perfect', atMs: 4200 } }));

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

  // Ask me: a question box on both profiles; a named question from Ben (answered, so the profile
  // has an Answers tab) and one from Cleo with her name hidden, waiting in the inbox.
  await must(main.ctx.put('/api/v1/me/ask-box', { data: { enabled: true, prompt: 'Ask me about cooking', allowHiddenNames: true } }));
  await must(friend.ctx.put('/api/v1/me/ask-box', { data: { enabled: true } }));
  const asked = await must(friend.ctx.post(`/api/v1/users/${main.id}/questions`, { data: { body: 'What is your go-to weeknight soup?', hideName: false } }));
  await must(third.ctx.post(`/api/v1/users/${main.id}/questions`, { data: { body: 'Which market has the best peaches?', hideName: true } }));
  await must(main.ctx.post(`/api/v1/questions/${asked.question.id}/answer`, { data: { answer: 'Lentil and lemon, done in thirty minutes.' } }));

  // Profile style: an accent (with the cover photo header), pronouns, a city, a link, a song and a
  // featured post; Ben has another accent and the gradient header.
  await must(
    friend.ctx.patch('/api/v1/me/profile', {
      data: { accent: 'violet', headerStyle: 'gradient', pronouns: 'he/him', links: [{ label: 'Bakery', url: 'https://example.com/bakery' }] },
    }),
  );
  await must(
    main.ctx.patch('/api/v1/me/profile', {
      data: {
        accent: 'saffron',
        headerStyle: 'cover',
        pronouns: 'she/her',
        city: 'Lisbon',
        links: [{ label: 'Recipes', url: 'https://example.com/recipes' }],
        song: { soundId, startMs: 0, durationMs: 5000 },
        featuredPostIds: [photoPost.post.id],
      },
    }),
  );

  // Drops: Ben's, scheduled for Friday (you asked to be told), and your own draft from your shop.
  const drop = await must(
    friend.ctx.post('/api/v1/drops', {
      data: {
        title: 'Friday bake',
        description: 'Twelve loaves, out of the oven at noon.',
        startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        items: [{ productId: bakery.product.id, quantity: 12, perBuyerLimit: 2 }],
      },
    }),
  );
  await must(friend.ctx.post(`/api/v1/drops/${drop.drop.id}/publish`, { data: {} }));
  await must(main.ctx.post(`/api/v1/drops/${drop.drop.id}/remind`, { data: {} }));
  const myShop = await must(main.ctx.post('/api/v1/businesses', { data: { name: 'Ada Jams', slug: `a11y-jams-${run}`.slice(0, 40) } }));
  const jam = await must(main.ctx.post('/api/v1/products', { data: { title: 'Peach jam', priceCents: 450, businessId: myShop.business.id } }));
  const myDrop = await must(
    main.ctx.post('/api/v1/drops', {
      data: {
        title: 'Summer jam',
        description: 'The last peaches of the year, in jars.',
        startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        items: [{ productId: jam.product.id, quantity: 20 }],
      },
    }),
  );

  // A chat with Cleo: a wallpaper and colour, a message to send later, and a game of each kind (you start, so it's your turn).
  const chat2 = await must(main.ctx.post('/api/v1/conversations', { data: { memberIds: [third.id] } }));
  const gamesChatId = chat2.conversation.id;
  await must(third.ctx.post(`/api/v1/conversations/${gamesChatId}/messages`, { data: { body: 'Rematch tonight?' } }));
  await must(main.ctx.put(`/api/v1/conversations/${gamesChatId}/theme`, { data: { wallpaper: 'dusk', accent: 'lagoon' } }));
  await must(
    main.ctx.post(`/api/v1/conversations/${gamesChatId}/scheduled`, {
      data: { body: 'Happy birthday, Cleo', sendAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    }),
  );
  for (const kind of ['four_up', 'noughts', 'word_ladder'])
    await must(main.ctx.post(`/api/v1/conversations/${gamesChatId}/games`, { data: { kind, clientId: randomUUID() } }));

  // This week's wrap, made now (development-only hook; normally it comes on Sunday evening).
  const wraps = await must(main.ctx.post('/api/dev/weekly-wrap', { data: {} }));
  const wrapId = (wraps.items[0]?.id as string | undefined) ?? null;
  if (!wrapId) console.warn('No weekly wrap was made: the wrap pages are audited empty.');

  await mkdir(AUTH_DIR, { recursive: true });
  await main.ctx.storageState({ path: STATE });
  await friend.ctx.storageState({ path: FRIEND_STATE });
  await third.ctx.storageState({ path: THIRD_STATE });
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
    reelId: reel.post.id,
    reel2Id: reel2.post.id,
    replyTargetId: reminder.message.id,
    gamesChatId,
    dropId: drop.drop.id,
    myDropId: myDrop.drop.id,
    wrapId,
  };
  await writeFile(DATA, JSON.stringify(data, null, 2));
  for (const u of [main, friend, third]) await u.ctx.dispose();
}
