import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { recordVerdict } from '../src/lib/media-moderation.ts';
import { notifyReleasedPosts } from '../src/lib/collabs.ts';

let t: BuiltApp;
let mod: TestUser;
let photo: Buffer;

beforeAll(async () => {
  t = await testApp();
  mod = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
  photo = await sharp({ create: { width: 1200, height: 500, channels: 3, background: '#2d6a4f' } })
    .jpeg()
    .toBuffer();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const follow = (a: TestUser, b: TestUser) => as(t.app, a).post(`/v1/users/${b.id}/follow`);

async function upload(owner: TestUser, name: string, o: { viewOnce?: boolean } = {}) {
  const boundary = `----ypl${Date.now()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="altText"\r\n\r\nA green hillside at dusk\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`),
    photo,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/media${o.viewOnce ? '?viewOnce=true' : ''}`,
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${owner.token}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().media as { id: string; url: string };
}

async function processMedia(mediaId: string) {
  const job = (await db().query(`SELECT id, payload FROM jobs WHERE kind = 'media.process' AND payload->>'mediaId' = $1`, [mediaId])).rows[0];
  const handlers = mediaJobHandlers({ db: db(), storage: t.ctx.storage, moderator: t.ctx.mediaModerator, realtime: t.ctx.realtime });
  await handlers['media.process'](job.payload);
  await db().query(`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`, [job.id]);
}

async function storedMedia(owner: TestUser, o: { kind?: string; moderation?: string; variants?: Record<string, string> } = {}) {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, moderation, variants) VALUES ($1,$2,'http://localhost:4000/media/x.jpg','image/jpeg','ready',$3,$4) RETURNING id`,
    [owner.id, o.kind ?? 'image', o.moderation ?? 'ok', o.variants ?? { large: 'http://localhost:4000/media/x_large.webp' }],
  );
  return rows[0].id as string;
}

describe('profile cover photo', () => {
  it('uses only your own processed photos, shows a processed size with alt text, and can be removed', async () => {
    const ada = await adult();
    const bola = await adult();
    const m = await upload(ada, 'hills.jpg');

    // Not processed yet: the app is asked to try again.
    const early = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('media_processing');

    await processMedia(m.id);
    // Someone else's photo can't be your cover.
    expect((await as(t.app, bola).put('/v1/me/cover', { mediaId: m.id })).status).toBe(404);

    const set = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id });
    expect(set.status).toBe(200);
    const variants = (await db().query(`SELECT variants FROM media WHERE id = $1`, [m.id])).rows[0].variants;
    expect(set.body.profile.coverUrl).toBe(variants.large ?? variants.medium);
    expect(set.body.profile.coverUrl).not.toBe(m.url);
    expect(set.body.profile.coverAlt).toBe('A green hillside at dusk');

    // Everyone sees it, signed in or not.
    expect((await as(t.app, bola).get(`/v1/users/${ada.username}`)).body.profile.coverUrl).toBe(set.body.profile.coverUrl);
    expect((await as(t.app, null).get(`/v1/users/${ada.username}`)).body.profile.coverAlt).toBe('A green hillside at dusk');

    // A description given when setting it wins.
    const described = await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id, altText: 'Hills near home' });
    expect(described.body.profile.coverAlt).toBe('Hills near home');
    // …and it can be changed on its own.
    expect((await as(t.app, ada).patch('/v1/me/profile', { coverAlt: 'The hills behind our house' })).body.profile.coverAlt).toBe('The hills behind our house');

    // An address from anywhere else is refused; null removes the cover.
    expect((await as(t.app, ada).patch('/v1/me/profile', { coverUrl: 'https://elsewhere.example/cover.jpg' })).status).toBe(400);
    const cleared = await as(t.app, ada).patch('/v1/me/profile', { coverUrl: null });
    expect(cleared.body.profile).toMatchObject({ coverUrl: null, coverAlt: null });

    await as(t.app, ada).put('/v1/me/cover', { mediaId: m.id });
    const removed = await as(t.app, ada).del('/v1/me/cover');
    expect(removed.status).toBe(200);
    expect(removed.body.profile.coverUrl).toBeNull();
    expect((await db().query(`SELECT cover_media_id FROM profiles WHERE user_id = $1`, [ada.id])).rows[0].cover_media_id).toBeNull();

    expect((await as(t.app, null).put('/v1/me/cover', { mediaId: m.id })).status).toBe(401);
  });

  it('refuses videos, view-once files, and photos marked sensitive or blocked', async () => {
    const ada = await adult();
    const video = await storedMedia(ada, { kind: 'video', variants: { mp4: 'http://localhost:4000/media/x.mp4' } });
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: video })).status).toBe(400);
    const sensitive = await storedMedia(ada, { moderation: 'sensitive' });
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: sensitive })).body.error.code).toBe('media_sensitive');
    const blocked = await storedMedia(ada, { moderation: 'blocked' });
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: blocked })).body.error.code).toBe('media_blocked');
    const private_ = await upload(ada, 'secret.jpg', { viewOnce: true });
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: private_.id })).status).toBe(404);
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: 'not-a-uuid' })).status).toBe(400);
  });

  it('comes down when the automated check later blocks the photo, and hides from people without an account on private profiles', async () => {
    const ada = await adult();
    const cover = await storedMedia(ada);
    expect((await as(t.app, ada).put('/v1/me/cover', { mediaId: cover })).status).toBe(200);
    await as(t.app, ada).patch('/v1/me/profile', { isPrivate: true });
    expect((await as(t.app, null).get(`/v1/users/${ada.username}`)).body.profile.coverUrl).toBeNull();

    await recordVerdict(db(), t.ctx.realtime, { id: cover, ownerId: ada.id, kind: 'image' }, 'dev', { verdict: 'blocked', labels: [] });
    expect((await as(t.app, ada).get(`/v1/users/${ada.username}`)).body.profile.coverUrl).toBeNull();
  });
});

describe('circles', () => {
  it('lets only the owner see and change a circle, and never tells members which circles they are in', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const dayo = await adult();
    const blocker = await adult();
    await as(t.app, blocker).post(`/v1/users/${ada.id}/block`);

    const created = await as(t.app, ada).post('/v1/me/circles', { name: 'Family', kind: 'family' });
    expect(created.status).toBe(201);
    const circle = created.body.circle;
    expect(circle).toMatchObject({ name: 'Family', kind: 'family', memberCount: 0 });
    expect((await as(t.app, ada).post('/v1/me/circles', { name: 'family' })).status).toBe(409);

    // Add people: blocked ones are skipped quietly, nobody is notified.
    const before = Number((await db().query(`SELECT count(*) FROM notifications WHERE user_id = ANY($1)`, [[bola.id, cleo.id]])).rows[0].count);
    const added = await as(t.app, ada).post(`/v1/me/circles/${circle.id}/members`, { userIds: [bola.id, cleo.id, blocker.id, ada.id] });
    expect(added.status).toBe(200);
    expect(added.body.added).toBe(2);
    expect(added.body.circle.memberCount).toBe(2);
    const after = Number((await db().query(`SELECT count(*) FROM notifications WHERE user_id = ANY($1)`, [[bola.id, cleo.id]])).rows[0].count);
    expect(after).toBe(before);
    const members = await as(t.app, ada).get(`/v1/me/circles/${circle.id}/members`);
    expect(members.body.items.map((u: any) => u.id).sort()).toEqual([bola.id, cleo.id].sort());

    // Rename.
    const renamed = await as(t.app, ada).patch(`/v1/me/circles/${circle.id}`, { name: 'Home' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.circle).toMatchObject({ id: circle.id, name: 'Home', memberCount: 2 });
    expect((await as(t.app, ada).patch(`/v1/me/circles/${circle.id}`, {})).status).toBe(400);

    // Nobody else can read or change it, members included.
    for (const other of [bola, dayo]) {
      const them = as(t.app, other);
      expect((await them.get(`/v1/me/circles/${circle.id}`)).status).toBe(404);
      expect((await them.get(`/v1/me/circles/${circle.id}/members`)).status).toBe(404);
      expect((await them.patch(`/v1/me/circles/${circle.id}`, { name: 'Mine now' })).status).toBe(404);
      expect((await them.post(`/v1/me/circles/${circle.id}/members`, { userIds: [other.id] })).status).toBe(404);
      expect((await them.del(`/v1/me/circles/${circle.id}/members/${bola.id}`)).status).toBe(404);
      expect((await them.del(`/v1/me/circles/${circle.id}`)).status).toBe(404);
      expect((await them.get('/v1/me/circles')).body.items).toEqual([]);
    }
    expect((await as(t.app, null).get('/v1/me/circles')).status).toBe(401);

    // A post for the circle: members see it, but not the circle's name or id; the author sees which circle.
    expect((await as(t.app, bola).post('/v1/posts', { body: 'Not your circle', visibility: 'circle', circleId: circle.id })).status).toBe(404);
    const post = (await as(t.app, ada).post('/v1/posts', { body: 'Sunday lunch at ours', visibility: 'circle', circleId: circle.id })).body.post;
    expect(post.circle).toEqual({ id: circle.id, name: 'Home' });
    const seen = await as(t.app, bola).get(`/v1/posts/${post.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.post.visibility).toBe('circle');
    expect(seen.body.post.circle).toBeUndefined();
    expect(JSON.stringify(seen.body)).not.toContain('Home');
    expect(JSON.stringify(seen.body)).not.toContain(circle.id);
    const profileSeen = await as(t.app, bola).get(`/v1/users/${ada.username}`);
    expect(JSON.stringify(profileSeen.body)).not.toContain(circle.id);
    const feed = await as(t.app, bola).get(`/v1/users/${ada.username}/posts`);
    expect(JSON.stringify(feed.body)).not.toContain(circle.id);
    expect((await as(t.app, dayo).get(`/v1/posts/${post.id}`)).status).toBe(404);

    // Taking someone out of the circle takes the post away from them.
    const out = await as(t.app, ada).del(`/v1/me/circles/${circle.id}/members/${cleo.id}`);
    expect(out.body.circle.memberCount).toBe(1);
    expect((await as(t.app, cleo).get(`/v1/posts/${post.id}`)).status).toBe(404);

    // Deleting the circle leaves the post with its author only.
    expect((await as(t.app, ada).del(`/v1/me/circles/${circle.id}`)).status).toBe(200);
    expect((await as(t.app, bola).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, ada).get(`/v1/posts/${post.id}`)).body.post.circle).toBeNull();
    expect((await as(t.app, ada).get('/v1/me/circles')).body.items).toEqual([]);
  });
});

describe('"Now" status', () => {
  it('shows to the chosen audience, in profiles and chat headers, and ends after 24 hours or when cleared', async () => {
    const ada = await adult();
    const fan = await adult();
    const close = await adult();
    const stranger = await adult();
    await follow(fan, ada);
    await follow(close, ada);
    expect((await as(t.app, ada).put(`/v1/me/close-friends/${close.id}`)).status).toBe(200);
    const statusOf = async (viewer: TestUser | null) => (await as(t.app, viewer).get(`/v1/users/${ada.username}`)).body.profile.nowStatus;

    // Validation: up to 60 characters, icons from the fixed set only.
    expect((await as(t.app, ada).put('/v1/me/status', { text: 'x'.repeat(61) })).status).toBe(400);
    expect((await as(t.app, ada).put('/v1/me/status', { text: 'Hi', icon: 'smile' })).status).toBe(400);
    expect((await as(t.app, ada).put('/v1/me/status', { text: '   ' })).status).toBe(400);
    expect((await as(t.app, null).put('/v1/me/status', { text: 'Hi' })).status).toBe(401);

    const set = await as(t.app, ada).put('/v1/me/status', { text: 'Studying for exams', icon: 'sparkle' });
    expect(set.status).toBe(200);
    expect(set.body.status).toMatchObject({ text: 'Studying for exams', icon: 'sparkle', audience: 'everyone' });
    const hours = (new Date(set.body.status.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    // Everyone: signed in or not. Only the owner learns who it's for.
    expect(await statusOf(stranger)).toEqual({ text: 'Studying for exams', icon: 'sparkle', expiresAt: set.body.status.expiresAt });
    expect((await statusOf(null)).text).toBe('Studying for exams');
    expect((await statusOf(ada)).audience).toBe('everyone');

    // Followers only.
    await as(t.app, ada).put('/v1/me/status', { text: 'At the match', icon: null, audience: 'followers' });
    expect(await statusOf(stranger)).toBeNull();
    expect(await statusOf(null)).toBeNull();
    expect(await statusOf(fan)).toMatchObject({ text: 'At the match', icon: null });

    // Close friends only (and they must still follow).
    await as(t.app, ada).put('/v1/me/status', { text: 'Back home for a week', icon: 'map-pin', audience: 'close_friends' });
    expect(await statusOf(fan)).toBeNull();
    expect(await statusOf(stranger)).toBeNull();
    expect((await statusOf(close)).text).toBe('Back home for a week');

    // Chat header: the other person's status in a one-to-one chat, for people in its audience.
    const dm = (await as(t.app, close).post('/v1/conversations', { memberIds: [ada.id] })).body.conversation;
    expect((await as(t.app, close).get(`/v1/conversations/${dm.id}`)).body.conversation.nowStatus.text).toBe('Back home for a week');
    const fanDm = (await as(t.app, fan).post('/v1/conversations', { memberIds: [ada.id] })).body.conversation;
    expect((await as(t.app, fan).get(`/v1/conversations/${fanDm.id}`)).body.conversation.nowStatus).toBeNull();
    expect((await as(t.app, fan).get('/v1/conversations')).body.items.find((c: any) => c.id === fanDm.id).nowStatus).toBeNull();

    await as(t.app, close).del(`/v1/users/${ada.id}/follow`);
    expect(await statusOf(close)).toBeNull();
    await follow(close, ada);

    // Private account, everyone: only followers.
    await as(t.app, ada).put('/v1/me/status', { text: 'Quiet week' });
    await as(t.app, ada).patch('/v1/me/profile', { isPrivate: true });
    expect(await statusOf(fan)).toMatchObject({ text: 'Quiet week' });
    const strangerView = await as(t.app, stranger).get(`/v1/users/${ada.username}`);
    expect(strangerView.body.profile.nowStatus).toBeNull();

    // Blocking hides it.
    await as(t.app, ada).post(`/v1/users/${fan.id}/block`);
    expect((await as(t.app, fan).get(`/v1/users/${ada.username}`)).status).toBe(404);
    expect((await db().query(`SELECT 1 FROM profile_statuses ns WHERE ns.user_id = $1`, [ada.id])).rowCount).toBe(1);

    // After 24 hours it's gone everywhere.
    await db().query(`UPDATE profile_statuses SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [ada.id]);
    expect(await statusOf(close)).toBeNull();
    expect(await statusOf(ada)).toBeNull();
    expect((await as(t.app, ada).get('/v1/me/status')).body.status).toBeNull();
    expect((await as(t.app, close).get(`/v1/conversations/${dm.id}`)).body.conversation.nowStatus).toBeNull();

    // Setting it again starts a new 24 hours; clearing ends it now.
    await as(t.app, ada).put('/v1/me/status', { text: 'Travelling', icon: 'globe' });
    expect((await statusOf(close)).text).toBe('Travelling');
    expect((await as(t.app, ada).del('/v1/me/status')).body.status).toBeNull();
    expect(await statusOf(close)).toBeNull();
  });
});

describe('collab invites for posts that were waiting for review', () => {
  const notes = async (userId: string, type: string) =>
    (await db().query(`SELECT entity_id, actor_id FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rows;

  it('tells invitees and people tagged once the post clears review, and only once', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    await follow(ada, bola);
    await follow(bola, ada);

    const created = await as(t.app, ada).post('/v1/posts', {
      body: 'You idiot, we actually finished it',
      collaborators: [bola.id],
      media: [{ url: `https://cdn.example.test/r${Date.now()}.jpg`, kind: 'image', width: 800, height: 600, tags: [{ userId: cleo.id, x: 0.5, y: 0.5 }] }],
    });
    expect(created.status).toBe(201);
    const postId = created.body.post.id;
    expect((await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [postId])).rows[0].moderation_status).toBe('review');
    // Held back while it waits.
    expect(await notes(bola.id, 'collab_invite')).toEqual([]);
    expect(await notes(cleo.id, 'photo_tag')).toEqual([]);

    const kase = (await db().query(`SELECT id FROM moderation_cases WHERE target_type = 'post' AND target_id = $1 AND status = 'open'`, [postId])).rows[0];
    expect((await as(t.app, mod).post(`/v1/admin/moderation/cases/${kase.id}/decide`, { decision: 'no_action' })).status).toBe(200);

    expect(await notes(bola.id, 'collab_invite')).toEqual([{ entity_id: postId, actor_id: ada.id }]);
    expect(await notes(cleo.id, 'photo_tag')).toEqual([{ entity_id: postId, actor_id: ada.id }]);
    // The invite is there to answer.
    expect((await as(t.app, bola).get('/v1/me/collab-invites')).body.items.map((p: any) => p.id)).toContain(postId);

    // Released again (e.g. restored after a media decision): nobody is told twice.
    await notifyReleasedPosts(db(), t.ctx.realtime, [postId]);
    expect(await notes(bola.id, 'collab_invite')).toHaveLength(1);
    expect(await notes(cleo.id, 'photo_tag')).toHaveLength(1);
  });

  it('tells nobody when the post is removed, and skips invites already answered', async () => {
    const ada = await adult();
    const bola = await adult();
    await follow(ada, bola);
    await follow(bola, ada);
    const removed = (await as(t.app, ada).post('/v1/posts', { body: 'What a loser move', collaborators: [bola.id] })).body.post;
    const kase = (await db().query(`SELECT id FROM moderation_cases WHERE target_type = 'post' AND target_id = $1`, [removed.id])).rows[0];
    await as(t.app, mod).post(`/v1/admin/moderation/cases/${kase.id}/decide`, { decision: 'remove' });
    expect(await notes(bola.id, 'collab_invite')).toEqual([]);

    const answered = (await as(t.app, ada).post('/v1/posts', { body: 'Stupid good idea, this one', collaborators: [bola.id] })).body.post;
    expect((await as(t.app, bola).post(`/v1/posts/${answered.id}/collab/decline`)).status).toBe(200);
    const k2 = (await db().query(`SELECT id FROM moderation_cases WHERE target_type = 'post' AND target_id = $1`, [answered.id])).rows[0];
    await as(t.app, mod).post(`/v1/admin/moderation/cases/${k2.id}/decide`, { decision: 'no_action' });
    expect(await notes(bola.id, 'collab_invite')).toEqual([]);
  });
});
