import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { isStoredMediaUrl } from '../src/lib/storage.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * Regression tests for the security review of drafts and post editing, chat,
 * boards, profiles, stories, recaps and rooms, and of the features added on
 * 2026-09-27 and 28 (docs/security/review-2026-09-28.md): each one pins a hole
 * that was open, so it stays closed.
 */

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'REAL_TOGETHER'`);
  await t.close();
});

const db = () => t.ctx.db;
const ADULT = '1990-04-02';
const TEEN = `${new Date().getUTCFullYear() - 15}-03-01`;
const adult = () => signUp(t.app, { birthDate: ADULT });
const teen = () => signUp(t.app, { birthDate: TEEN });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** A photo stored like an upload, owned by `owner`. */
async function photo(owner: TestUser): Promise<{ id: string; url: string }> {
  const data = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#1d4ad2' } })
    .jpeg()
    .toBuffer();
  const stored = await t.ctx.storage.put(data, 'jpg', 'image/jpeg');
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, storage_key, status) VALUES ($1,'image',$2,'image/jpeg',$3,'ready') RETURNING id, url`,
    [owner.id, stored.url, stored.key],
  );
  return rows[0];
}

describe('links people open', () => {
  it('only takes http and https links on profiles and posts, and never shows other schemes saved earlier', async () => {
    const u = await adult();
    for (const url of ['javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', 'JaVaScRiPt:alert(1)'])
      expect((await as(t.app, u).patch('/v1/me/profile', { links: [{ label: 'Site', url }] })).status).toBe(400);
    expect((await as(t.app, u).post('/v1/posts', { body: 'look', linkUrl: 'javascript:alert(1)' })).status).toBe(400);
    const ok = await as(t.app, u).patch('/v1/me/profile', { links: [{ label: 'Site', url: 'https://example.test/me' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.links).toEqual([{ label: 'Site', url: 'https://example.test/me', iconUrl: null }]);

    // Rows saved before the rule are filtered on the way out.
    await db().query(`UPDATE profiles SET links = $2 WHERE user_id = $1`, [
      u.id,
      JSON.stringify([
        { label: 'Bad', url: 'javascript:alert(1)' },
        { label: 'Good', url: 'https://example.test' },
      ]),
    ]);
    const other = await adult();
    expect((await as(t.app, other).get(`/v1/users/${u.username}`)).body.profile.links).toEqual([{ label: 'Good', url: 'https://example.test', iconUrl: null }]);
    const post = (await as(t.app, u).post('/v1/posts', { body: 'a link', linkUrl: 'https://example.test/a' })).body.post;
    await db().query(`UPDATE posts SET link_url = 'javascript:alert(1)' WHERE id = $1`, [post.id]);
    expect((await as(t.app, other).get(`/v1/posts/${post.id}`)).body.post.linkUrl).toBeNull();
  });
});

describe('files stored here go by their id', () => {
  it('recognises addresses of stored files, whatever the host', () => {
    const key = `2026/09/${randomUUID()}`;
    expect(isStoredMediaUrl(`https://api.example.test/media/${key}.jpg`)).toBe(true);
    expect(isStoredMediaUrl(`http://10.0.0.1:4000/media/${key}_web.mp4?x=1`)).toBe(true);
    expect(isStoredMediaUrl(`https://cdn.example.test/other/../media/${key}_hls/index.m3u8`)).toBe(true);
    expect(isStoredMediaUrl('https://cdn.example.test/photos/harbour.jpg')).toBe(false);
  });

  it("refuses someone else's upload (a recap, a private photo) posted or put in a story by its address", async () => {
    const owner = await adult();
    const thief = await adult();
    const m = await photo(owner);
    const post = await as(t.app, thief).post('/v1/posts', { body: 'mine now', media: [{ url: m.url, kind: 'image' }] });
    expect(post.status).toBe(400);
    const draft = await as(t.app, thief).post('/v1/posts', { body: 'later', draft: true, media: [{ url: m.url, kind: 'image' }] });
    expect(draft.status).toBe(400);
    const story = await as(t.app, thief).post('/v1/moments', { mediaUrl: m.url, mediaKind: 'image' });
    expect(story.status).toBe(400);
    // Even the owner attaches their own upload by id.
    expect((await as(t.app, owner).post('/v1/posts', { body: 'by address', media: [{ url: m.url, kind: 'image' }] })).status).toBe(400);
    expect((await as(t.app, owner).post('/v1/posts', { body: 'by id', media: [{ id: m.id, url: m.url, kind: 'image' }] })).status).toBe(201);
    expect(
      await db()
        .query(`SELECT 1 FROM media WHERE url = $1 AND owner_id = $2`, [m.url, thief.id])
        .then((r) => r.rowCount),
    ).toBe(0);
  });

  it('keeps a recap with other people’s photos out of Real Together, and view-once uploads too', async () => {
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('REAL_TOGETHER', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const maker = await adult();
    const friend = await adult();
    await befriend(maker, friend);
    await as(t.app, maker).post(`/v1/users/${friend.id}/follow`);
    const theirs = await photo(friend);
    const friendsOnly = (
      await as(t.app, friend).post('/v1/posts', { body: 'just us', visibility: 'followers', media: [{ id: theirs.id, url: theirs.url, kind: 'image' }] })
    ).body.post;
    const video = (
      await db().query(`INSERT INTO media (owner_id, kind, url, status) VALUES ($1,'video','https://cdn.example.test/recap.mp4','ready') RETURNING id`, [
        maker.id,
      ])
    ).rows[0].id;
    await db().query(
      `INSERT INTO recaps (owner_id, source_type, title, style, aspect, items, status, media_id) VALUES ($1,'on_this_day','Us','calm','9:16',$2,'ready',$3)`,
      [maker.id, JSON.stringify([{ mediaId: theirs.id, from: 'post', fromId: friendsOnly.id }]), video],
    );
    const together = await as(t.app, maker).post('/v1/together', { title: 'Weekend', memberIds: [] });
    expect(together.status).toBe(201);
    const tid = together.body.together.id;
    const r = await as(t.app, maker).post(`/v1/together/${tid}/items`, { items: [{ mediaId: video }] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('recap_not_sendable');
    const once = (await db().query(`INSERT INTO media (owner_id, kind, url, status, private) VALUES ($1,'image','','ready',true) RETURNING id`, [maker.id]))
      .rows[0].id;
    expect((await as(t.app, maker).post(`/v1/together/${tid}/items`, { items: [{ mediaId: once }] })).status).toBe(404);
  });
});

describe('posts', () => {
  it("won't attach an event the author can't see (its title would show on the post)", async () => {
    const host = await adult();
    const other = await adult();
    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    const secret = (await as(t.app, host).post('/v1/events', { title: 'Secret party', startsAt: inDays(3), visibility: 'private' })).body.event;
    const r = await as(t.app, other).post('/v1/posts', { body: 'see you there', eventId: secret.id });
    expect(r.status).toBe(404);
    const open = (await as(t.app, host).post('/v1/events', { title: 'Open night', startsAt: inDays(3) })).body.event;
    expect((await as(t.app, other).post('/v1/posts', { body: 'see you there', eventId: open.id })).body.post.event.title).toBe('Open night');
  });

  it('checks photo tags and co-author invites again when a draft is published', async () => {
    const author = await adult();
    const tagged = await adult();
    const m = await photo(author);
    const draft = await as(t.app, author).post('/v1/posts', {
      body: 'with a friend',
      draft: true,
      media: [{ id: m.id, url: m.url, kind: 'image', tags: [{ userId: tagged.id, x: 0.5, y: 0.5 }] }],
    });
    expect(draft.status).toBe(201);
    // They stop allowing tags while it waits.
    expect((await as(t.app, tagged).put('/v1/me/tagging', { allowFrom: 'nobody' })).status).toBe(200);
    const r = await as(t.app, author).post(`/v1/drafts/${draft.body.post.id}/publish`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('tag_not_allowed');
    expect((await db().query(`SELECT status FROM posts WHERE id = $1`, [draft.body.post.id])).rows[0].status).toBe('draft');
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'photo_tag'`, [tagged.id])).rowCount).toBe(0);
  });

  it("doesn't let an adult reach someone under 18 they aren't friends with through @mentions (posts, edits, stories)", async () => {
    const stranger = await adult();
    const kid = await teen();
    const friend = await adult();
    const mentions = async () =>
      (
        await db().query(`SELECT type FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type IN ('post_mention', 'story_mention')`, [
          kid.id,
          stranger.id,
        ])
      ).rows;
    const post = (await as(t.app, stranger).post('/v1/posts', { body: `hey @${kid.username}` })).body.post;
    expect((await as(t.app, stranger).patch(`/v1/posts/${post.id}`, { body: `hey again @${kid.username} @${friend.username}` })).status).toBe(200);
    expect((await as(t.app, stranger).post('/v1/moments', { body: `look @${kid.username}`, visibility: 'public' })).status).toBe(201);
    expect(await mentions()).toEqual([]);
    // Adults still hear about mentions from adults, and friends across the line do too.
    expect(
      (await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'post_mention'`, [friend.id, stranger.id])).rowCount,
    ).toBe(1);
    await befriend(stranger, kid);
    await as(t.app, stranger).post('/v1/posts', { body: `now we're friends @${kid.username}` });
    expect((await mentions()).map((r) => r.type)).toEqual(['post_mention']);
  });

  it('holds a post from a limited account when it is opened up to everyone after posting', async () => {
    const author = await adult();
    const viewer = await adult();
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'for followers', visibility: 'followers' })).body.post;
    await db().query(`UPDATE users SET restricted_at = now() WHERE id = $1`, [author.id]);
    const r = await as(t.app, author).patch(`/v1/posts/${post.id}`, { visibility: 'public' });
    expect(r.status).toBe(200);
    expect(r.body.moderation?.status).toBe('restricted');
    expect((await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [post.id])).rows[0].moderation_status).toBe('restricted');
    expect((await as(t.app, null).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, viewer).get(`/v1/posts/${post.id}`)).status).toBe(404);
  });
});

describe('chats', () => {
  it("won't put an adult and someone under 18 who aren't friends in a group together", async () => {
    const host = await adult();
    const kid = await teen();
    const stranger = await adult();
    await befriend(host, kid);
    await befriend(host, stranger);
    const r = await as(t.app, host).post('/v1/conversations', { memberIds: [kid.id, stranger.id], title: 'Crew' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('minor_protection');

    // Nor by adding them later.
    const g = await as(t.app, host).post('/v1/conversations', { memberIds: [kid.id], title: 'Crew' });
    expect(g.status).toBe(201);
    const add = await as(t.app, host).post(`/v1/conversations/${g.body.conversation.id}/members`, { userIds: [stranger.id] });
    expect(add.status).toBe(403);
    expect(
      (await db().query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [g.body.conversation.id, stranger.id])).rowCount,
    ).toBe(0);

    // Once they're friends it's fine.
    await befriend(kid, stranger);
    expect((await as(t.app, host).post(`/v1/conversations/${g.body.conversation.id}/members`, { userIds: [stranger.id] })).status).toBe(200);
  });

  it('leaves messages from people you blocked out of the chat list preview', async () => {
    const a = await adult();
    const b = await adult();
    const c = await adult();
    await befriend(a, b);
    await befriend(a, c);
    const g = (await as(t.app, a).post('/v1/conversations', { memberIds: [b.id, c.id], title: 'Three' })).body.conversation.id;
    await as(t.app, c).post(`/v1/conversations/${g}/messages`, { body: 'from c', clientId: randomUUID() });
    await as(t.app, b).post(`/v1/conversations/${g}/messages`, { body: 'from b', clientId: randomUUID() });
    await as(t.app, a).post(`/v1/users/${b.id}/block`);
    const list = (await as(t.app, a).get('/v1/conversations')).body.items;
    expect(list.find((x: any) => x.id === g).lastMessage.body).toBe('from c');
  });

  it("doesn't send a group message, or its edits, live to someone who blocked the sender", async () => {
    const a = await adult();
    const b = await adult();
    const c = await adult();
    await befriend(a, b);
    await befriend(a, c);
    const g = (await as(t.app, a).post('/v1/conversations', { memberIds: [b.id, c.id], title: 'Three' })).body.conversation.id;
    await as(t.app, c).post(`/v1/users/${b.id}/block`);
    const seen = (u: TestUser) => {
      const events: { type: string; data: any }[] = [];
      t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
      return events;
    };
    const [forA, forC] = [seen(a), seen(c)];
    const m = (await as(t.app, b).post(`/v1/conversations/${g}/messages`, { body: 'hello all', clientId: randomUUID() })).body.message;
    expect((await as(t.app, b).patch(`/v1/messages/${m.id}`, { body: 'hello everyone' })).status).toBe(200);
    expect(forA.filter((e) => e.type === 'message.created' || e.type === 'message.edited')).toHaveLength(2);
    expect(forC.filter((e) => e.type === 'message.created' || e.type === 'message.edited')).toEqual([]);
  });

  it('shows a disappearing message that has run out as gone in replies and pins, before the job deletes it', async () => {
    const a = await adult();
    const b = await adult();
    await befriend(a, b);
    const convo = (await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] })).body.conversation.id;
    expect((await as(t.app, a).put(`/v1/conversations/${convo}/disappearing`, { seconds: 86400 })).status).toBe(200);
    const m = (await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: 'gone tomorrow', clientId: randomUUID() })).body.message;
    expect((await as(t.app, a).put(`/v1/messages/${m.id}/pin`)).status).toBe(200);
    expect((await as(t.app, a).put(`/v1/conversations/${convo}/disappearing`, { seconds: null })).status).toBe(200);
    const reply = (await as(t.app, b).post(`/v1/conversations/${convo}/messages`, { body: 'noted', replyToId: m.id, clientId: randomUUID() })).body.message;
    expect(reply.replyTo.body).toBe('gone tomorrow');
    await db().query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, [m.id]);
    const items = (await as(t.app, b).get(`/v1/conversations/${convo}/messages`)).body.items;
    const quoted = items.find((x: any) => x.id === reply.id).replyTo;
    expect(quoted.available).toBe(false);
    expect(quoted.body).toBe('');
    expect((await as(t.app, b).get(`/v1/conversations/${convo}/pins`)).body.items).toEqual([]);
  });
});

describe('chats with spam checks on', () => {
  let s: BuiltApp;
  let net = 0;
  beforeAll(async () => {
    s = await testApp({ SPAM_CHECKS: 'true' });
  });
  afterAll(async () => {
    await s.close();
  });
  /** A new account from its own network, so sign-up velocity rules don't flag it. */
  async function newUser(): Promise<TestUser> {
    net++;
    const x = randomUUID().slice(0, 8);
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'x-forwarded-for': `10.211.${net}.${1 + (net % 7)}` },
      payload: { email: `sr_${x}@example.test`, password: 'correct-horse-battery', username: `sr_${x}`, displayName: 'Review', birthDate: ADULT },
    });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    return { id: b.user.id, token: b.token, username: b.user.username, email: b.user.email, password: 'correct-horse-battery' };
  }

  it("won't let a harmless message to a stranger be edited into spam after it was delivered", async () => {
    const sender = await newUser();
    const stranger = await newUser();
    const convo = (await as(s.app, sender).post('/v1/conversations', { memberIds: [stranger.id] })).body.conversation.id;
    const m = await as(s.app, sender).post(`/v1/conversations/${convo}/messages`, { body: 'Hi, loved your post', clientId: randomUUID() });
    expect(m.status).toBe(201);
    expect(m.body.message.moderation).toBeUndefined();
    const r = await as(s.app, sender).patch(`/v1/messages/${m.body.message.id}`, { body: 'Deals https://a.example https://b.example https://c.example' });
    expect(r.status).toBe(422);
    const seen = (await as(s.app, stranger).get(`/v1/conversations/${convo}/messages`)).body.items;
    expect(seen.map((x: any) => x.body)).toEqual(['Hi, loved your post']);
    // Between friends, links are fine.
    const [x, y] = [sender.id, stranger.id].sort();
    await s.ctx.db.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
    expect(
      (await as(s.app, sender).patch(`/v1/messages/${m.body.message.id}`, { body: 'See https://a.example https://b.example https://c.example' })).status,
    ).toBe(200);
  });
});

describe('audio rooms', () => {
  it("doesn't show people under 18 on stage to people without an account, or people you blocked", async () => {
    const owner = await adult();
    const kid = await teen();
    const blocker = await adult();
    const slug = `sec-${Date.now().toString(36)}`;
    expect((await as(t.app, owner).post('/v1/communities', { name: 'Security rooms', slug, topics: ['music'] })).status).toBe(201);
    for (const m of [kid, blocker]) expect((await as(t.app, m).post(`/v1/communities/${slug}/join`)).status).toBe(200);
    const room = (await as(t.app, owner).post(`/v1/communities/${slug}/rooms`, { title: 'Open mic' })).body.room.id;
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/join`)).status).toBe(200);
    await db().query(`INSERT INTO room_participants (room_id, user_id, role, is_host, muted) VALUES ($1,$2,'speaker',false,true)`, [room, kid.id]);

    const preview = async (u: TestUser | null) =>
      ((await as(t.app, u).get(`/v1/communities/${slug}/rooms`)).body.items.find((r: any) => r.id === room).speakerPreview as any[]).map((p) => p.id);
    expect(await preview(null)).toEqual([owner.id]);
    expect((await preview(blocker)).sort()).toEqual([owner.id, kid.id].sort());
    await as(t.app, blocker).post(`/v1/users/${owner.id}/block`);
    expect(await preview(blocker)).toEqual([kid.id]);
  });
});

// ── Review of the features added on 2026-09-27 and 28 (docs/security/review-2026-09-28.md) ──

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** A fake connected device for `u`: every realtime event they get. */
function listen(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove };
}

describe('developer keys and app tokens', () => {
  it('refuses the export, sign-in sessions and account deletion however the path is spelled', async () => {
    const dev = await adult();
    const appId = (await as(t.app, dev).post('/v1/developer/apps', { name: 'Review app' })).body.app.id;
    const secret = (await as(t.app, dev).post(`/v1/developer/apps/${appId}/keys`, { name: 'writer', scopes: ['read', 'write'] })).body.secret;
    const key = { ...dev, token: secret };
    for (const path of ['/v1/me/%65xport', '/v1/%6De/export', '/v1/%61uth/sessions', '/v1/%64eveloper/apps'])
      expect((await as(t.app, key).get(path)).status, path).toBe(403);
    expect((await as(t.app, key).del('/v1/%6De', { password: dev.password })).status).toBe(403);
    expect((await db().query(`SELECT status FROM users WHERE id = $1`, [dev.id])).rows[0].status).toBe('active');
    // The key still works where keys may go.
    expect((await as(t.app, key).get('/v1/feed')).status).toBe(200);
  });
});

describe('Together albums with people under 18', () => {
  beforeAll(async () => {
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('REAL_TOGETHER', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
  });

  it('keeps an adult and someone under 18 who aren’t friends out of the same album, however they would get in', async () => {
    const host = await adult();
    const kid = await teen();
    const stranger = await adult();
    await befriend(host, kid);
    await befriend(host, stranger);
    // Both picked at once.
    const both = await as(t.app, host).post('/v1/together', { title: 'Trip', memberIds: [kid.id, stranger.id] });
    expect(both.status).toBe(403);
    expect(both.body.error.code).toBe('minor_protection');
    // One now, the other later.
    const album = await as(t.app, host).post('/v1/together', { title: 'Trip', memberIds: [kid.id], inviteLink: true });
    expect(album.status).toBe(201);
    const id = album.body.together.id;
    const add = await as(t.app, host).post(`/v1/together/${id}/members`, { userIds: [stranger.id] });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('minor_protection');
    // Nor by asking with the invite link and being let in.
    const code = album.body.together.invite.code;
    expect((await as(t.app, stranger).post(`/v1/together/invite/${code}/request`)).status).toBe(200);
    const approve = await as(t.app, host).post(`/v1/together/${id}/requests/${stranger.id}`, { approve: true });
    expect(approve.status).toBe(403);
    expect((await db().query(`SELECT 1 FROM together_members WHERE together_id = $1 AND user_id = $2`, [id, stranger.id])).rowCount).toBe(0);
    // Once they're friends it's fine.
    await befriend(kid, stranger);
    expect((await as(t.app, host).post(`/v1/together/${id}/members`, { userIds: [stranger.id] })).status).toBe(200);
  });

  it('skips people from an event who would be in an album with someone under 18 they don’t know', async () => {
    const host = await adult();
    const kid = await teen();
    const guest = await adult();
    await befriend(host, kid);
    const event = (await as(t.app, host).post('/v1/events', { title: 'Picnic', startsAt: inDays(2) })).body.event.id;
    for (const u of [kid, guest]) expect((await as(t.app, u).post(`/v1/events/${event}/rsvp`, { status: 'going' })).status).toBe(200);
    const r = await as(t.app, host).post('/v1/together', { title: 'Picnic photos', eventId: event });
    expect(r.status).toBe(201);
    const ids = (await db().query(`SELECT user_id FROM together_members WHERE together_id = $1`, [r.body.together.id])).rows.map((x) => x.user_id);
    expect(ids).toContain(host.id);
    expect(ids.includes(kid.id) && ids.includes(guest.id)).toBe(false);
    expect(r.body.skipped).toBeGreaterThanOrEqual(1);
  });

  it('doesn’t tell someone who blocked a member, live, that they added photos', async () => {
    const host = await adult();
    const friend = await adult();
    await befriend(host, friend);
    const id = (await as(t.app, host).post('/v1/together', { title: 'Weekend', memberIds: [friend.id] })).body.together.id;
    await as(t.app, friend).post(`/v1/users/${host.id}/block`);
    const device = listen(friend);
    const m = await photo(host);
    expect((await as(t.app, host).post(`/v1/together/${id}/items`, { items: [{ mediaId: m.id }] })).status).toBe(201);
    device.remove();
    expect(device.events.filter((e) => e.type === 'together.items')).toEqual([]);
  });
});

describe('sharing where you are with someone under 18', () => {
  it('stops a live share once the friendship it relied on ends', async () => {
    const kid = await teen();
    const grownUp = await adult();
    await befriend(kid, grownUp);
    const convo = (await as(t.app, kid).post('/v1/conversations', { memberIds: [grownUp.id] })).body.conversation.id;
    const here = { lat: 6.4541, lng: 3.3947 };
    const started = await as(t.app, kid).post(`/v1/conversations/${convo}/location`, { mode: 'live', minutes: 60, ...here });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const shareId = started.body.message.location.id;
    // While they're friends, a point sent too soon is only "too soon".
    expect((await as(t.app, kid).post(`/v1/location-shares/${shareId}/point`, here)).body.error.code).toBe('location_too_soon');
    const [a, b] = [kid.id, grownUp.id].sort();
    await db().query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [a, b]);
    const next = await as(t.app, kid).post(`/v1/location-shares/${shareId}/point`, here);
    expect(next.status).toBe(409);
    expect(next.body.error.code).toBe('share_ended');
    const row = (await db().query(`SELECT lat, lng, stopped_at FROM location_shares WHERE id = $1`, [shareId])).rows[0];
    expect(row.stopped_at).not.toBeNull();
    expect([row.lat, row.lng]).toEqual([null, null]);
    expect((await as(t.app, grownUp).get(`/v1/conversations/${convo}/location-shares`)).body.items).toEqual([]);
  });
});

describe('event tickets', () => {
  it('gives no free door ticket for answering "going" to an event that sells tickets', async () => {
    const host = await adult();
    const guest = await adult();
    const event = (await as(t.app, host).post('/v1/events', { title: 'Concert', startsAt: inDays(4) })).body.event.id;
    const product = await as(t.app, host).post('/v1/products', { kind: 'ticket', title: 'Standing', priceCents: 2500, eventId: event });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    expect((await as(t.app, guest).post(`/v1/events/${event}/rsvp`, { status: 'going' })).body.status).toBe('going');
    expect((await as(t.app, guest).get('/v1/tickets')).body.items).toEqual([]);
    expect((await db().query(`SELECT 1 FROM event_tickets WHERE event_id = $1 AND holder_id = $2`, [event, guest.id])).rowCount).toBe(0);
    // An event with nothing for sale still gives one.
    const free = (await as(t.app, host).post('/v1/events', { title: 'Picnic', startsAt: inDays(4) })).body.event.id;
    await as(t.app, guest).post(`/v1/events/${free}/rsvp`, { status: 'going' });
    expect((await as(t.app, guest).get('/v1/tickets')).body.items.map((x: any) => x.event.id)).toEqual([free]);
  });
});

describe('Market', () => {
  it('leaves people blocked either way out of the seller’s list of who wrote about a listing', async () => {
    const seller = await adult();
    const buyer = await adult();
    const m = await photo(seller);
    const listing = await as(t.app, seller).post('/v1/market/listings', {
      title: 'Blue bicycle',
      description: 'Rides well, new tyres',
      category: 'bikes',
      condition: 'good',
      priceCents: 5000,
      photos: [{ mediaId: m.id }],
      area: 'Yaba',
      delivery: ['pickup'],
    });
    expect(listing.status, JSON.stringify(listing.body)).toBe(201);
    const id = listing.body.listing.id;
    await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [buyer.id]);
    const wrote = await as(t.app, buyer).post(`/v1/market/listings/${id}/message`);
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(201);
    expect((await as(t.app, seller).get(`/v1/market/listings/${id}`)).body.listing.buyers.map((b: any) => b.id)).toEqual([buyer.id]);
    await as(t.app, buyer).post(`/v1/users/${seller.id}/block`);
    expect((await as(t.app, seller).get(`/v1/market/listings/${id}`)).body.listing.buyers).toEqual([]);
  });
});

describe('echoes', () => {
  it('only lets an echo video out as that echo, never as a plain post, a story or into an album', async () => {
    const maker = await adult();
    const creator = await adult();
    const video = (
      await db().query(
        `INSERT INTO media (owner_id, kind, url, mime, status, moderation, duration_ms, width, height)
         VALUES ($1,'video','https://cdn.example.test/echo.mp4','video/mp4','ready','ok',8000,720,1280) RETURNING id, url`,
        [maker.id],
      )
    ).rows[0];
    await db().query(
      `INSERT INTO echoes (owner_id, original_author_id, result_media_id, layout, their_audio, status) VALUES ($1,$2,$3,'side','mixed','ready')`,
      [maker.id, creator.id, video.id],
    );
    const media = [{ id: video.id, url: video.url, kind: 'video' }];
    const reel = await as(t.app, maker).post('/v1/posts', { body: 'all mine', format: 'reel', visibility: 'public', media });
    expect(reel.status).toBe(403);
    expect(reel.body.error.code).toBe('echo_not_reusable');
    expect((await as(t.app, maker).post('/v1/posts', { body: 'later', draft: true, media })).body.error?.code).toBe('echo_not_reusable');
    expect((await as(t.app, maker).post('/v1/moments', { mediaId: video.id, mediaKind: 'video' })).body.error?.code).toBe('echo_not_reusable');
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('REAL_TOGETHER', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const album = (await as(t.app, maker).post('/v1/together', { title: 'Reels', memberIds: [] })).body.together.id;
    expect((await as(t.app, maker).post(`/v1/together/${album}/items`, { items: [{ mediaId: video.id }] })).body.error?.code).toBe('echo_not_reusable');
    // An echo of your own reel holds nothing of anyone else's.
    await db().query(`UPDATE echoes SET original_author_id = $1 WHERE result_media_id = $2`, [maker.id, video.id]);
    expect((await as(t.app, maker).post(`/v1/together/${album}/items`, { items: [{ mediaId: video.id }] })).status).toBe(201);
  });
});

describe('mixes shared into several chats', () => {
  it('tells each person, live, only about the chats they are in', async () => {
    const owner = await adult();
    const [a, b] = [await adult(), await adult()];
    await befriend(owner, a);
    await befriend(owner, b);
    const chatA = (await as(t.app, owner).post('/v1/conversations', { memberIds: [a.id] })).body.conversation.id;
    const chatB = (await as(t.app, owner).post('/v1/conversations', { memberIds: [b.id] })).body.conversation.id;
    const mix = await as(t.app, owner).post('/v1/mixes', { title: 'Road trip', visibility: 'friends' });
    expect(mix.status, JSON.stringify(mix.body)).toBe(201);
    for (const c of [chatA, chatB]) expect((await as(t.app, owner).post(`/v1/mixes/${mix.body.mix.id}/share`, { conversationId: c })).status).toBe(201);
    const device = listen(a);
    expect((await as(t.app, owner).patch(`/v1/mixes/${mix.body.mix.id}`, { title: 'Road trip again' })).status).toBe(200);
    device.remove();
    const updates = device.events.filter((e) => e.type === 'mix.updated');
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u.data.conversationIds).toEqual([chatA]);
  });
});
