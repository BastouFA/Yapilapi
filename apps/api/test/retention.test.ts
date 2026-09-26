import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });

async function video(owner: TestUser, durationMs: number | null = 12_000) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',$2) RETURNING id, url`,
    [owner.id, durationMs],
  );
  return rows[0] as { id: string; url: string };
}

async function reel(owner: TestUser, extra: Record<string, unknown> = {}) {
  const v = await video(owner);
  const r = await as(t.app, owner).post('/v1/posts', { format: 'reel', body: 'A reel', media: [{ id: v.id, url: v.url, kind: 'video' }], ...extra });
  return r;
}

async function makeFriends(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await t.ctx.db.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

async function notificationsOf(u: TestUser) {
  return (await as(t.app, u).get('/v1/notifications?limit=50')).body.items as any[];
}

describe('remix and duet reels', () => {
  it('lets people duet or remix a public reel, credits the original and tells its creator', async () => {
    const creator = await adult();
    const fan = await adult();
    const other = await adult();
    const original = (await reel(creator)).body.post;
    expect(original).toMatchObject({ allowRemix: true, remixOf: null, counts: { remixes: 0 } });
    expect(original.sound).toMatchObject({ original: true });

    const duet = await reel(fan, { remixOf: original.id, remixMode: 'duet', body: 'Singing along' });
    expect(duet.status).toBe(201);
    expect(duet.body.post.remixOf).toMatchObject({ mode: 'duet', post: { id: original.id, author: { id: creator.id } } });
    expect(duet.body.post.remixOf.post.media).toMatchObject({ kind: 'video' });
    // A duet uses the original's sound instead of registering a new one.
    expect(duet.body.post.sound).toMatchObject({ id: original.sound.id, original: false });

    const remix = await reel(other, { remixOf: original.id, remixMode: 'remix' });
    expect(remix.status).toBe(201);
    expect(remix.body.post.remixOf.mode).toBe('remix');
    expect(remix.body.post.sound.id).toBe(original.sound.id);

    // The creator hears about both.
    const notes = await notificationsOf(creator);
    expect(notes.find((n) => n.type === 'reel_duet')).toMatchObject({
      actor: { id: fan.id },
      entityType: 'post',
      entityId: duet.body.post.id,
      data: { originalId: original.id },
    });
    expect(notes.find((n) => n.type === 'reel_remix')).toMatchObject({ actor: { id: other.id }, entityId: remix.body.post.id });

    // The remixes list, with a mode filter, and the count on the original.
    const list = await as(t.app, creator).get(`/v1/posts/${original.id}/remixes`);
    expect(list.body.items.map((p: any) => p.id)).toEqual([remix.body.post.id, duet.body.post.id]);
    const duets = await as(t.app, creator).get(`/v1/posts/${original.id}/remixes?mode=duet`);
    expect(duets.body.items.map((p: any) => p.id)).toEqual([duet.body.post.id]);
    expect((await as(t.app, fan).get(`/v1/posts/${original.id}`)).body.post.counts.remixes).toBe(2);
    // Signed out, the public list still works.
    expect((await as(t.app, null).get(`/v1/posts/${original.id}/remixes`)).body.items).toHaveLength(2);
  });

  it('respects the creator turning remixes off, and only allows public reels', async () => {
    const creator = await adult();
    const fan = await adult();
    await as(t.app, fan).post(`/v1/users/${creator.id}/follow`);
    const original = (await reel(creator)).body.post;

    // Only the author can change the setting.
    expect((await as(t.app, fan).put(`/v1/posts/${original.id}/remix-settings`, { allowRemix: false })).status).toBe(404);
    expect((await as(t.app, creator).put(`/v1/posts/${original.id}/remix-settings`, { allowRemix: false })).body).toEqual({ allowRemix: false });
    expect((await as(t.app, fan).get(`/v1/posts/${original.id}`)).body.post.allowRemix).toBe(false);
    const refused = await reel(fan, { remixOf: original.id, remixMode: 'duet' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/turned off/);
    await as(t.app, creator).put(`/v1/posts/${original.id}/remix-settings`, { allowRemix: true });
    expect((await reel(fan, { remixOf: original.id, remixMode: 'duet' })).status).toBe(201);

    // Off from the start.
    const closed = (await reel(creator, { allowRemix: false })).body.post;
    expect(closed.allowRemix).toBe(false);
    expect((await reel(fan, { remixOf: closed.id, remixMode: 'remix' })).status).toBe(403);

    // Followers-only reels and plain posts can't be remixed.
    const followersOnly = (await reel(creator, { visibility: 'followers' })).body.post;
    const r1 = await reel(fan, { remixOf: followersOnly.id, remixMode: 'duet' });
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toMatch(/public reels/);
    const plain = (await as(t.app, creator).post('/v1/posts', { body: 'Words' })).body.post;
    expect((await reel(fan, { remixOf: plain.id, remixMode: 'duet' })).status).toBe(400);

    // Someone who can't see the reel gets "not found".
    const stranger = await adult();
    await as(t.app, creator).post(`/v1/users/${stranger.id}/block`);
    expect((await reel(stranger, { remixOf: original.id, remixMode: 'duet' })).status).toBe(404);

    // The mode goes with the original, and only reels remix.
    expect((await reel(fan, { remixOf: original.id })).status).toBe(400);
    expect((await reel(fan, { remixMode: 'duet' })).status).toBe(400);
    const v = await video(fan);
    expect(
      (await as(t.app, fan).post('/v1/posts', { body: 'x', media: [{ id: v.id, url: v.url, kind: 'video' }], remixOf: original.id, remixMode: 'duet' })).status,
    ).toBe(400);
  });

  it("doesn't notify the creator about a remix they can't see, and hides the original from people who can't see it", async () => {
    const creator = await adult();
    const fan = await adult();
    const watcher = await adult();
    const original = (await reel(creator)).body.post;
    const friendsOnly = await reel(fan, { remixOf: original.id, remixMode: 'duet', visibility: 'friends' });
    expect(friendsOnly.status).toBe(201);
    expect((await notificationsOf(creator)).some((n) => n.type === 'reel_duet')).toBe(false);

    const pub = (await reel(fan, { remixOf: original.id, remixMode: 'duet' })).body.post;
    // The watcher blocks the original's creator: the duet still shows, the original doesn't.
    await as(t.app, watcher).post(`/v1/users/${creator.id}/block`);
    const seen = (await as(t.app, watcher).get(`/v1/posts/${pub.id}`)).body.post;
    expect(seen.remixOf).toEqual({ mode: 'duet', post: null });
  });
});

describe('sounds', () => {
  it("registers each reel's sound, lets others use it and lists the reels that use it", async () => {
    const maker = await signUp(t.app, { birthDate: '1990-01-01', displayName: 'Ada Sound' });
    const user = await adult();
    const first = (await reel(maker)).body.post;
    expect(first.sound).toMatchObject({ title: 'Original sound - Ada Sound', durationMs: 12_000, original: true });
    expect(first.sound.audioUrl).toContain('/media/');
    const named = (await reel(maker, { soundTitle: 'Rain on the roof' })).body.post;
    expect(named.sound.title).toBe('Rain on the roof');
    expect(named.sound.id).not.toBe(first.sound.id);

    const sound = (await as(t.app, user).get(`/v1/sounds/${first.sound.id}`)).body.sound;
    expect(sound).toMatchObject({
      id: first.sound.id,
      owner: { id: maker.id },
      sourcePostId: first.id,
      durationMs: 12_000,
      reels: 1,
      canUse: true,
    });

    // Someone else makes a reel with it.
    const used = await reel(user, { soundId: first.sound.id, body: 'Using a sound' });
    expect(used.status).toBe(201);
    expect(used.body.post.sound).toMatchObject({ id: first.sound.id, original: false, title: 'Original sound - Ada Sound' });
    expect((await as(t.app, user).get(`/v1/sounds/${first.sound.id}`)).body.sound.reels).toBe(2);

    // Most recent first; top puts the liked one first.
    const recent = await as(t.app, user).get(`/v1/sounds/${first.sound.id}/reels?sort=recent`);
    expect(recent.body.items.map((p: any) => p.id)).toEqual([used.body.post.id, first.id]);
    await as(t.app, user).put(`/v1/posts/${first.id}/reaction`, { kind: 'like' });
    const top = await as(t.app, user).get(`/v1/sounds/${first.sound.id}/reels?sort=top`);
    expect(top.body.items.map((p: any) => p.id)).toEqual([first.id, used.body.post.id]);
    // Paging.
    const p1 = await as(t.app, user).get(`/v1/sounds/${first.sound.id}/reels?limit=1`);
    expect(p1.body.items).toHaveLength(1);
    const p2 = await as(t.app, user).get(`/v1/sounds/${first.sound.id}/reels?limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id).toBe(first.id);
    expect(p2.body.nextCursor).toBeNull();

    // The sound page works signed out too.
    expect((await as(t.app, null).get(`/v1/sounds/${first.sound.id}`)).body.sound.reels).toBe(2);

    // The picker finds it by name.
    const picked = await as(t.app, user).get(`/v1/sounds?q=rain`);
    expect(picked.body.items.map((s: any) => s.id)).toContain(named.sound.id);
    expect(picked.body.items.map((s: any) => s.id)).not.toContain(first.sound.id);

    // Only the owner can rename it.
    expect((await as(t.app, user).patch(`/v1/sounds/${first.sound.id}`, { title: 'Mine now' })).status).toBe(404);
    expect((await as(t.app, maker).patch(`/v1/sounds/${first.sound.id}`, { title: 'Morning birds' })).body.sound.title).toBe('Morning birds');
    expect((await as(t.app, user).get(`/v1/posts/${used.body.post.id}`)).body.post.sound.title).toBe('Morning birds');
  });

  it("keeps sounds of reels you can't use or see out of reach", async () => {
    const maker = await adult();
    const friend = await adult();
    const stranger = await adult();
    await makeFriends(maker, friend);
    const privateReel = (await reel(maker, { visibility: 'friends' })).body.post;

    // A friend sees the sound but can't use it (the reel isn't public); a stranger can't see it at all.
    const seen = await as(t.app, friend).get(`/v1/sounds/${privateReel.sound.id}`);
    expect(seen.body.sound).toMatchObject({ canUse: false, reels: 1 });
    expect((await reel(friend, { soundId: privateReel.sound.id })).status).toBe(403);
    expect((await as(t.app, stranger).get(`/v1/sounds/${privateReel.sound.id}`)).status).toBe(404);
    expect((await as(t.app, stranger).get(`/v1/sounds/${privateReel.sound.id}/reels`)).status).toBe(404);
    expect((await reel(stranger, { soundId: privateReel.sound.id })).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/sounds/${privateReel.sound.id}`)).status).toBe(404);

    // Turning remixes off also stops new reels using the sound.
    const open = (await reel(maker)).body.post;
    await as(t.app, maker).put(`/v1/posts/${open.id}/remix-settings`, { allowRemix: false });
    expect((await as(t.app, stranger).get(`/v1/sounds/${open.sound.id}`)).body.sound.canUse).toBe(false);
    expect((await reel(stranger, { soundId: open.sound.id })).status).toBe(403);

    // Sounds are for reels only.
    expect((await as(t.app, maker).post('/v1/posts', { body: 'Words', soundId: open.sound.id })).status).toBe(400);
  });

  it('registers a sound for older reels when someone remixes them', async () => {
    const maker = await adult();
    const fan = await adult();
    const old = (await reel(maker)).body.post;
    // Simulate a reel from before sounds existed.
    await t.ctx.db.query(`UPDATE posts SET sound_id = NULL WHERE id = $1`, [old.id]);
    await t.ctx.db.query(`DELETE FROM sounds WHERE id = $1`, [old.sound.id]);
    const remix = await reel(fan, { remixOf: old.id, remixMode: 'remix' });
    expect(remix.status).toBe(201);
    const refreshed = (await as(t.app, fan).get(`/v1/posts/${old.id}`)).body.post;
    expect(refreshed.sound.original).toBe(true);
    expect(remix.body.post.sound.id).toBe(refreshed.sound.id);
  });
});

describe('close friends stories', () => {
  it('shows close friends stories only to the people on the list who follow you', async () => {
    const author = await adult();
    const close = await adult();
    const follower = await adult();
    const stranger = await adult();
    await as(t.app, close).post(`/v1/users/${author.id}/follow`);
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);

    // Only followers can be added.
    const notFollowing = await as(t.app, author).put(`/v1/me/close-friends/${stranger.id}`);
    expect(notFollowing.status).toBe(400);
    expect((await as(t.app, author).put(`/v1/me/close-friends/${author.id}`)).status).toBe(400);
    expect((await as(t.app, author).put(`/v1/me/close-friends/${close.id}`)).body).toEqual({ closeFriend: true });
    const list = (await as(t.app, author).get('/v1/me/close-friends')).body.items;
    expect(list.map((x: any) => x.user.id)).toEqual([close.id]);
    expect(list[0].followsYou).toBe(true);

    const story = (await as(t.app, author).post('/v1/moments', { body: 'Just for you', visibility: 'close_friends' })).body.moment;
    const everyone = (await as(t.app, author).post('/v1/moments', { body: 'For all followers', visibility: 'followers' })).body.moment;

    // The close friend sees it, marked as close friends.
    const g = (await as(t.app, close).get('/v1/moments')).body.items.find((x: any) => x.author.id === author.id);
    expect(g.moments.map((m: any) => m.id)).toEqual([story.id, everyone.id]);
    expect(g.moments[0].closeFriends).toBe(true);
    expect(g.moments[1].closeFriends).toBe(false);
    // The author sees their own, marked too.
    const mine = (await as(t.app, author).get('/v1/moments')).body.items[0];
    expect(mine.moments.find((m: any) => m.id === story.id).closeFriends).toBe(true);

    // Other followers only see the followers story, and can't view, like or reply to the other.
    const fg = (await as(t.app, follower).get('/v1/moments')).body.items.find((x: any) => x.author.id === author.id);
    expect(fg.moments.map((m: any) => m.id)).toEqual([everyone.id]);
    expect((await as(t.app, follower).post(`/v1/moments/${story.id}/view`)).status).toBe(404);
    expect((await as(t.app, follower).put(`/v1/moments/${story.id}/like`, { liked: true })).status).toBe(404);
    expect((await as(t.app, follower).post(`/v1/moments/${story.id}/reply`, { body: 'Hi' })).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/moments/${story.id}/view`)).status).toBe(404);
    expect((await as(t.app, stranger).get('/v1/moments')).body.items.some((x: any) => x.author.id === author.id)).toBe(false);

    // The close friend can view, like and reply.
    expect((await as(t.app, close).post(`/v1/moments/${story.id}/view`)).status).toBe(200);
    expect((await as(t.app, close).put(`/v1/moments/${story.id}/like`, { liked: true })).body.liked).toBe(true);
    expect((await as(t.app, close).post(`/v1/moments/${story.id}/reply`, { body: 'Love this' })).status).toBe(201);
    const viewers = (await as(t.app, author).get(`/v1/moments/${story.id}/viewers`)).body.items;
    expect(viewers.map((v: any) => v.user.id)).toEqual([close.id]);

    // Unfollowing takes them out of the audience, even while still on the list.
    await as(t.app, close).del(`/v1/users/${author.id}/follow`);
    expect((await as(t.app, close).post(`/v1/moments/${story.id}/view`)).status).toBe(404);
    await as(t.app, close).post(`/v1/users/${author.id}/follow`);
    expect((await as(t.app, close).post(`/v1/moments/${story.id}/view`)).status).toBe(200);

    // Removing them from the list does the same.
    expect((await as(t.app, author).del(`/v1/me/close-friends/${close.id}`)).body).toEqual({ closeFriend: false });
    expect((await as(t.app, close).post(`/v1/moments/${story.id}/view`)).status).toBe(404);
    expect((await as(t.app, author).get('/v1/me/close-friends')).body.items).toEqual([]);
  });

  it('suggests only your followers when picking close friends', async () => {
    const me = await signUp(t.app, { birthDate: '1990-01-01' });
    const fan = await signUp(t.app, { birthDate: '1990-01-01', displayName: 'Zed Follower' });
    const idol = await signUp(t.app, { birthDate: '1990-01-01', displayName: 'Zed Idol' });
    await as(t.app, fan).post(`/v1/users/${me.id}/follow`);
    await as(t.app, me).post(`/v1/users/${idol.id}/follow`);

    const all = (await as(t.app, me).get('/v1/people/suggest?limit=20')).body.items.map((x: any) => x.user.id);
    expect(all).toContain(idol.id);
    const followers = (await as(t.app, me).get('/v1/people/suggest?scope=followers&limit=20')).body.items.map((x: any) => x.user.id);
    expect(followers).toEqual([fan.id]);
    const typed = (await as(t.app, me).get('/v1/people/suggest?scope=followers&q=Zed')).body.items.map((x: any) => x.user.id);
    expect(typed).toEqual([fan.id]);
  });
});

describe('voice messages', () => {
  it('accepts M4A voice messages recorded on phones', async () => {
    const a = await adult();
    // A minimal ISO base media header ("ftypM4A ").
    const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(64)]);
    const mediaIds: string[] = [];
    for (const mime of ['audio/mp4', 'audio/x-m4a']) {
      const boundary = '----yp' + Math.random().toString(16).slice(2);
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.m4a"\r\nContent-Type: ${mime}\r\n\r\n`),
        m4a,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().media).toMatchObject({ kind: 'audio' });
      expect(res.json().media.url).toMatch(/\.m4a$/);
      mediaIds.push(res.json().media.id);
    }
    // Sent the way the mobile app sends it: an empty body with the upload attached.
    const b = await adult();
    const convo = (await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] })).body.conversation.id;
    const sent = await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: '', clientId: 'voice-1', attachments: [{ mediaId: mediaIds[0] }] });
    expect(sent.status).toBe(201);
    expect(sent.body.message.attachments[0]).toMatchObject({ kind: 'audio', mediaId: mediaIds[0] });
    // A file whose bytes aren't M4A is refused.
    const boundary = '----ypbad';
    const bad = await t.app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`),
        Buffer.from('not really audio at all'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(bad.statusCode).toBe(415);
  });
});

describe('your data', () => {
  it('exports close friends and sounds, and removes them when the account is deleted', async () => {
    const owner = await adult();
    const fan = await adult();
    await as(t.app, fan).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, owner).put(`/v1/me/close-friends/${fan.id}`);
    const r = (await reel(owner, { soundTitle: 'Porch song' })).body.post;

    const data = (await as(t.app, owner).get('/v1/me/export')).body;
    expect(data.closeFriends.map((x: any) => x.friend_id)).toEqual([fan.id]);
    expect(data.sounds).toMatchObject([{ id: r.sound.id, title: 'Porch song', source_post_id: r.id }]);
    expect(data.posts.find((p: any) => p.id === r.id)).toMatchObject({ format: 'reel', allow_remix: true, sound_id: r.sound.id });

    expect((await as(t.app, owner).del('/v1/me', { password: owner.password })).status).toBe(200);
    const left = await t.ctx.db.query(
      `SELECT (SELECT count(*) FROM close_friends WHERE owner_id = $1)::int AS cf, (SELECT count(*) FROM sounds WHERE owner_id = $1)::int AS s`,
      [owner.id],
    );
    expect(left.rows[0]).toEqual({ cf: 0, s: 0 });
  });
});
