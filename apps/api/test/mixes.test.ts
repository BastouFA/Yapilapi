import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MixDetail, MixSong, MusicLicence } from '@yapilapi/shared';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const minor = () => signUp(t.app, { birthDate: '2011-03-03' });

const licence = (over: Partial<MusicLicence> = {}): MusicLicence => ({
  name: '[Dev data] Test licence',
  url: null,
  commercialUse: true,
  regions: null,
  excludedRegions: [],
  maxClipSeconds: 30,
  attribution: null,
  expiresAt: null,
  cacheAllowed: true,
  ...over,
});

/**
 * A catalogue song, stored as the dev provider (on in tests) would store it. Its metadata counts as
 * fresh for a day, so the music refresh job (run by other test files on the same database) leaves it be.
 */
async function song(title: string, over: Partial<MusicLicence> = {}, extra: { status?: string; durationMs?: number } = {}): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO music_tracks (provider, external_id, title, artist, duration_ms, cover_url, preview_url, licence, status, fetched_at)
     VALUES ('dev', $1, $2, 'Dev tones', $3, $4, $5, $6, $7, now() + interval '1 day') RETURNING id`,
    [
      `test-${randomUUID()}`,
      `[Dev data] ${title}`,
      extra.durationMs ?? 120_000,
      `https://img.test/${encodeURIComponent(title)}.jpg`,
      `https://audio.test/${encodeURIComponent(title)}.mp3`,
      licence(over),
      extra.status ?? 'active',
    ],
  );
  return rows[0]!.id;
}

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}
const follow = (a: TestUser, b: TestUser) => db().query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.id, b.id]);
const setCountry = (u: TestUser, country: string | null) => db().query(`UPDATE profiles SET country = $2 WHERE user_id = $1`, [u.id, country]);

async function makeMix(u: TestUser, input: Record<string, unknown> = {}): Promise<MixDetail> {
  const r = await as(t.app, u).post('/v1/mixes', { title: 'Road trip', ...input });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.mix;
}
const getMix = (u: TestUser | null, id: string) => as(t.app, u).get(`/v1/mixes/${id}`);
const addSongs = (u: TestUser, id: string, trackIds: string[]) =>
  as(t.app, u).post(`/v1/mixes/${id}/songs`, { songs: trackIds.map((trackId) => ({ trackId })) });

async function direct(a: TestUser, b: TestUser): Promise<string> {
  await befriend(a, b);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}
async function group(owner: TestUser, others: TestUser[]): Promise<string> {
  for (const o of others) await befriend(owner, o);
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), title: 'Mix club' });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}
const share = (u: TestUser, mixId: string, conversationId: string) => as(t.app, u).post(`/v1/mixes/${mixId}/share`, { conversationId });

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

describe('making mixes', () => {
  it('makes a mix with songs in order, a cover mosaic and nothing that plays by itself', async () => {
    const ada = await adult();
    const ids = [await song('One'), await song('Two'), await song('Three'), await song('Four'), await song('Five')];
    const mix = await makeMix(ada, { description: 'For the long drive', visibility: 'public', songs: ids.map((trackId) => ({ trackId })) });
    expect(mix.songCount).toBe(5);
    expect(mix.songs.map((s) => s.musicId)).toEqual(ids);
    expect(mix.covers).toHaveLength(4);
    expect(mix.role).toBe('owner');
    expect(mix.songs[0]!.addedBy?.id).toBe(ada.id);
    expect(mix.songs[0]!.play).toEqual({ audioUrl: expect.stringContaining('audio.test'), startMs: 0, durationMs: 30_000 });
    // Data saver: no covers.
    const lite = await as(t.app, ada).get(`/v1/mixes/${mix.id}?lite=1`);
    expect(lite.body.mix.covers).toEqual([]);
    // The same song twice is kept once.
    const again = await addSongs(ada, mix.id, [ids[0]!]);
    expect(again.status).toBe(200);
    expect(again.body.added).toBe(0);
  });

  it('refuses a mix over 100 songs, names that are empty, and songs that do not exist', async () => {
    const ada = await adult();
    expect((await as(t.app, ada).post('/v1/mixes', { title: '  ' })).status).toBe(400);
    const mix = await makeMix(ada);
    expect((await addSongs(ada, mix.id, [randomUUID()])).status).toBe(404);
    const many = await Promise.all(Array.from({ length: 100 }, (_, i) => song(`Bulk ${i}`)));
    for (let i = 0; i < 100; i += 20) expect((await addSongs(ada, mix.id, many.slice(i, i + 20))).status).toBe(201);
    const over = await addSongs(ada, mix.id, [await song('One too many')]);
    expect(over.status).toBe(400);
  });

  it('puts Mixes on a profile that chose its tabs, and shows the tab only when there is a mix to see', async () => {
    const ada = await adult();
    const bola = await adult();
    expect((await as(t.app, ada).patch('/v1/me/profile', { tabs: ['posts', 'reels'] })).status).toBe(200);
    const profileOf = async (viewer: TestUser | null) => (await as(t.app, viewer).get(`/v1/users/${ada.username}`)).body.profile;
    await makeMix(ada, { visibility: 'private' });
    expect((await profileOf(ada)).tabs).toEqual(['posts', 'reels', 'mixes']);
    // Bola can't see a private mix: no tab for him.
    expect((await profileOf(bola)).tabs).toEqual(['posts', 'reels']);
    await makeMix(ada, { title: 'Open to all', visibility: 'public' });
    expect((await profileOf(bola)).tabs).toContain('mixes');
    const tab = await as(t.app, bola).get(`/v1/users/${ada.username}/mixes`);
    expect(tab.body.items.map((m: { title: string }) => m.title)).toEqual(['Open to all']);
  });
});

describe('who sees a mix', () => {
  it('follows the audience: only me, friends, followers, everyone', async () => {
    const ada = await adult();
    const friend = await adult();
    const follower = await adult();
    const stranger = await adult();
    await befriend(ada, friend);
    await follow(follower, ada);
    const mixes = {
      private: await makeMix(ada, { visibility: 'private' }),
      friends: await makeMix(ada, { visibility: 'friends' }),
      followers: await makeMix(ada, { visibility: 'followers' }),
      public: await makeMix(ada, { visibility: 'public' }),
    };
    const sees = async (u: TestUser | null) => {
      const out: string[] = [];
      for (const [k, m] of Object.entries(mixes)) if ((await getMix(u, m.id)).status === 200) out.push(k);
      return out;
    };
    expect(await sees(ada)).toEqual(['private', 'friends', 'followers', 'public']);
    expect(await sees(friend)).toEqual(['friends', 'public']);
    expect(await sees(follower)).toEqual(['followers', 'public']);
    expect(await sees(stranger)).toEqual(['public']);
    expect(await sees(null)).toEqual(['public']);
  });

  it('keeps a private account’s public mixes to its followers, and an under-18’s to theirs', async () => {
    const ada = await adult();
    const kid = await minor();
    const follower = await adult();
    const stranger = await adult();
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [ada.id]);
    await db().query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [kid.id]);
    await follow(follower, ada);
    await follow(follower, kid);
    const privateAccount = await makeMix(ada, { visibility: 'public' });
    const kids = await makeMix(kid, { visibility: 'public' });
    expect((await getMix(stranger, privateAccount.id)).status).toBe(404);
    expect((await getMix(follower, privateAccount.id)).status).toBe(200);
    expect((await getMix(stranger, kids.id)).status).toBe(404);
    expect((await getMix(null, kids.id)).status).toBe(404);
    expect((await getMix(follower, kids.id)).status).toBe(200);
  });

  it('hides mixes both ways when someone blocks', async () => {
    const ada = await adult();
    const bola = await adult();
    const mix = await makeMix(ada, { visibility: 'public' });
    const bolas = await makeMix(bola, { visibility: 'public' });
    expect((await getMix(bola, mix.id)).status).toBe(200);
    expect((await as(t.app, ada).post(`/v1/users/${bola.id}/block`)).status).toBe(200);
    expect((await getMix(bola, mix.id)).status).toBe(404);
    expect((await getMix(ada, bolas.id)).status).toBe(404);
    expect((await as(t.app, bola).get(`/v1/users/${ada.username}/mixes`)).status).toBe(404);
    expect((await as(t.app, bola).put(`/v1/mixes/${mix.id}/like`)).status).toBe(404);
    expect((await as(t.app, bola).post('/v1/reports', { targetType: 'mix', targetId: mix.id, reason: 'spam' })).status).toBe(404);
  });

  it('can be liked, saved, reported and removed by a moderator', async () => {
    const ada = await adult();
    const bola = await adult();
    const mix = await makeMix(ada, { visibility: 'public' });
    const liked = await as(t.app, bola).put(`/v1/mixes/${mix.id}/like`);
    expect(liked.body).toEqual({ liked: true, likeCount: 1 });
    expect((await as(t.app, bola).put(`/v1/mixes/${mix.id}/like`)).body.likeCount).toBe(1);
    expect((await as(t.app, bola).put(`/v1/mixes/${mix.id}/save`)).status).toBe(200);
    const saved = await as(t.app, bola).get('/v1/me/mixes?filter=saved');
    expect(saved.body.items.map((m: { id: string }) => m.id)).toEqual([mix.id]);
    expect(saved.body.items[0].liked).toBe(true);
    const report = await as(t.app, bola).post('/v1/reports', { targetType: 'mix', targetId: mix.id, reason: 'spam' });
    expect(report.status).toBe(201);
    expect((await as(t.app, ada).post('/v1/reports', { targetType: 'mix', targetId: mix.id, reason: 'spam' })).status).toBe(400);
    const c = (await db().query(`SELECT id FROM moderation_cases WHERE target_type = 'mix' AND target_id = $1`, [mix.id])).rows[0];
    expect(c).toBeTruthy();
    const mod = await adult();
    await db().query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
    const decided = await as(t.app, mod).post(`/v1/admin/moderation/cases/${c.id}/decide`, { decision: 'remove', reason: 'Spam' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect((await getMix(bola, mix.id)).status).toBe(404);
  });
});

describe('listening', () => {
  it('plays each song’s allowed part for the listener’s country and skips the rest with a reason', async () => {
    const ada = await adult();
    const bola = await adult();
    const everywhere = await song('Everywhere');
    const shortClip = await song('Short clips', { maxClipSeconds: 10 });
    const regional = await song('West Africa', { regions: ['NG', 'GH'] });
    const personal = await song('Personal use', { commercialUse: false });
    const gone = await song('Gone', {}, { status: 'withdrawn' });
    await setCountry(ada, 'NG');
    const mix = await makeMix(ada, { visibility: 'public', songs: [everywhere, shortClip, regional, personal].map((trackId) => ({ trackId })) });
    // A withdrawn song can't be added.
    expect((await addSongs(ada, mix.id, [gone])).status).toBe(422);
    await db().query(`INSERT INTO mix_songs (mix_id, track_id, added_by, position) VALUES ($1,$2,$3,10)`, [mix.id, gone, ada.id]);

    await setCountry(bola, 'FR');
    const heard = (await getMix(bola, mix.id)).body.mix as MixDetail;
    const by = (title: string) => heard.songs.find((s) => s.title === `[Dev data] ${title}`)!;
    expect(by('Everywhere').play?.durationMs).toBe(30_000);
    expect(by('Short clips').play?.durationMs).toBe(10_000);
    expect(by('West Africa')).toMatchObject({ play: null, unavailable: 'region' });
    expect(by('Personal use').play).not.toBeNull();
    expect(by('Gone')).toMatchObject({ play: null, unavailable: 'withdrawn' });
    // Someone in Nigeria hears the regional song.
    await setCountry(bola, 'NG');
    expect(((await getMix(bola, mix.id)).body.mix as MixDetail).songs.find((s) => s.musicId === regional)!.play).not.toBeNull();
    // Nobody gets audio for a song whose provider is off.
    await db().query(`UPDATE music_tracks SET status = 'paused' WHERE id = $1`, [everywhere]);
    expect(((await getMix(bola, mix.id)).body.mix as MixDetail).songs.find((s) => s.musicId === everywhere)).toMatchObject({
      play: null,
      unavailable: 'unavailable',
    });
  });

  it('refuses songs the adder can’t use, and a business account’s mix plays only songs cleared for business', async () => {
    const shop = await adult();
    const bola = await adult();
    await db().query(`UPDATE profiles SET mode = 'business' WHERE user_id = $1`, [shop.id]);
    const personal = await song('Personal only', { commercialUse: false });
    const regional = await song('Kenya only', { regions: ['KE'] });
    const mix = await makeMix(shop, { visibility: 'public' });
    const r = await addSongs(shop, mix.id, [personal]);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('music_not_allowed');
    await setCountry(shop, 'FR');
    expect((await addSongs(shop, mix.id, [regional])).status).toBe(403);
    // Stored anyway (a licence changed later): listeners get nothing to play and a reason.
    await db().query(`INSERT INTO mix_songs (mix_id, track_id, added_by, position) VALUES ($1,$2,$3,0)`, [mix.id, personal, shop.id]);
    const heard = (await getMix(bola, mix.id)).body.mix as MixDetail;
    expect(heard.songs[0]).toMatchObject({ play: null, unavailable: 'commercial' });
  });

  it('shows a sound the listener can’t see as unavailable, without its name', async () => {
    const ada = await adult();
    const bola = await adult();
    const mix = await makeMix(ada, { visibility: 'public' });
    const sound = (await db().query<{ id: string }>(`INSERT INTO sounds (title, owner_id) VALUES ('Secret sound', $1) RETURNING id`, [bola.id])).rows[0]!.id;
    // Not visible to Ada: can't be added.
    expect((await as(t.app, ada).post(`/v1/mixes/${mix.id}/songs`, { songs: [{ soundId: sound }] })).status).toBe(404);
    await db().query(`INSERT INTO mix_songs (mix_id, sound_id, added_by, position) VALUES ($1,$2,$3,0)`, [mix.id, sound, ada.id]);
    const s = ((await getMix(ada, mix.id)).body.mix as MixDetail).songs[0]!;
    expect(s).toMatchObject({ title: '', play: null, unavailable: 'hidden' });
  });
});

describe('reordering', () => {
  it('puts songs in the new order, and refuses an order made from an old list', async () => {
    const ada = await adult();
    const ids = [await song('A'), await song('B'), await song('C')];
    const mix = await makeMix(ada, { songs: ids.map((trackId) => ({ trackId })) });
    const [a, b, c] = mix.songs.map((s) => s.id);
    const r = await as(t.app, ada).put(`/v1/mixes/${mix.id}/order`, { songIds: [c, a, b] });
    expect(r.status).toBe(200);
    expect((r.body.mix as MixDetail).songs.map((s) => s.id)).toEqual([c, a, b]);
    // Missing one, or listing one twice.
    expect((await as(t.app, ada).put(`/v1/mixes/${mix.id}/order`, { songIds: [a, b] })).status).toBe(409);
    expect((await as(t.app, ada).put(`/v1/mixes/${mix.id}/order`, { songIds: [a, a, b] })).status).toBe(400);
    // Someone who only sees it can't reorder.
    const bola = await adult();
    await db().query(`UPDATE mixes SET visibility = 'public' WHERE id = $1`, [mix.id]);
    expect((await as(t.app, bola).put(`/v1/mixes/${mix.id}/order`, { songIds: [a, b, c] })).status).toBe(403);
    // Added songs go at the end.
    const d = await song('D');
    const added = await addSongs(ada, mix.id, [d]);
    expect((added.body.mix as MixDetail).songs.map((s) => s.musicId)).toEqual([ids[2], ids[0], ids[1], d]);
  });
});

describe('collaborating in chats', () => {
  it('lets everyone in a group add and reorder songs, with who added each and one line per person', async () => {
    const ada = await adult();
    const bola = await adult();
    const chi = await adult();
    const outsider = await adult();
    const conv = await group(ada, [bola, chi]);
    const mix = await makeMix(ada, { visibility: 'friends', songs: [{ trackId: await song('Opener') }] });
    // Before it's shared, Bola can see it (friends) but not add.
    expect((await addSongs(bola, mix.id, [await song('Too early')])).status).toBe(403);
    const shared = await share(ada, mix.id, conv);
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    expect(shared.body.message.mix).toMatchObject({ available: true, id: mix.id, role: 'owner' });
    // Sharing again gives the same card.
    expect((await share(ada, mix.id, conv)).body.message.id).toBe(shared.body.message.id);
    // Only the owner shares.
    expect((await share(bola, mix.id, conv)).status).toBe(403);

    const chiLive = connect(chi);
    const first = await addSongs(bola, mix.id, [await song('Bola one')]);
    expect(first.status).toBe(201);
    expect((first.body.mix as MixDetail).role).toBe('collaborator');
    await addSongs(bola, mix.id, [await song('Bola two'), await song('Bola three')]);
    await addSongs(chi, mix.id, [await song('Chi one')]);
    chiLive.remove();
    // Bola's three songs share one line; Chi has his own.
    const lines = (
      await db().query(`SELECT sender_id, meta FROM messages WHERE conversation_id = $1 AND kind = 'system' AND meta->>'type' = 'mix' ORDER BY created_at`, [
        conv,
      ])
    ).rows;
    expect(lines.map((l) => [l.sender_id, l.meta.count])).toEqual([
      [bola.id, 3],
      [chi.id, 1],
    ]);
    expect(chiLive.of('message.created').some((e) => e.data.system?.type === 'mix')).toBe(true);
    expect(chiLive.of('message.system')[0]?.data.system.count).toBe(3);
    expect(chiLive.of('mix.updated').length).toBeGreaterThan(0);
    // After ten minutes, a new line.
    await db().query(`UPDATE messages SET created_at = created_at - interval '11 minutes' WHERE conversation_id = $1 AND kind = 'system'`, [conv]);
    await addSongs(bola, mix.id, [await song('Bola later')]);
    expect(
      (await db().query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND kind = 'system'`, [conv, bola.id])).rows[0]
        .n,
    ).toBe(2);
    // The chat shows the lines and the card.
    const msgs = (await as(t.app, chi).get(`/v1/conversations/${conv}/messages`)).body.items as { system?: { type: string }; mix?: { id: string } }[];
    expect(msgs.some((m) => m.mix?.id === mix.id)).toBe(true);
    expect(msgs.filter((m) => m.system?.type === 'mix')).toHaveLength(3);

    const detail = (await getMix(chi, mix.id)).body.mix as MixDetail;
    const byTitle = (title: string) => detail.songs.find((s) => s.title === `[Dev data] ${title}`)!;
    expect(byTitle('Bola one').addedBy?.id).toBe(bola.id);
    expect(byTitle('Chi one').canRemove).toBe(true);
    expect(byTitle('Bola one').canRemove).toBe(false);
    // Chi reorders; he can take off his own song but not Bola's.
    const order = [...detail.songs].reverse().map((s) => s.id);
    expect((await as(t.app, chi).put(`/v1/mixes/${mix.id}/order`, { songIds: order })).status).toBe(200);
    expect((await as(t.app, chi).del(`/v1/mixes/${mix.id}/songs/${byTitle('Bola one').id}`)).status).toBe(403);
    expect((await as(t.app, chi).del(`/v1/mixes/${mix.id}/songs/${byTitle('Chi one').id}`)).status).toBe(200);
    // Only the owner renames it.
    expect((await as(t.app, chi).patch(`/v1/mixes/${mix.id}`, { title: 'Mine now' })).status).toBe(403);
    // Someone outside the chat can't add or see it (it's for friends).
    expect((await getMix(outsider, mix.id)).status).toBe(404);
    // Shared with you.
    const sharedWithChi = await as(t.app, chi).get('/v1/me/mixes?filter=shared');
    expect(sharedWithChi.body.items.map((m: { id: string }) => m.id)).toEqual([mix.id]);
  });

  it('ends collaboration when someone leaves, the card is unsent, or the mix is made private', async () => {
    const ada = await adult();
    const bola = await adult();
    const chi = await adult();
    const conv = await group(ada, [bola, chi]);
    const mix = await makeMix(ada, { visibility: 'private' });
    // Only-me mixes aren't shared.
    expect((await share(ada, mix.id, conv)).status).toBe(400);
    await as(t.app, ada).patch(`/v1/mixes/${mix.id}`, { visibility: 'followers' });
    const card = (await share(ada, mix.id, conv)).body.message;
    expect((await addSongs(bola, mix.id, [await song('In')])).status).toBe(201);
    // Chi leaves the group: no more adding (and no longer sees a mix he doesn't follow).
    expect((await as(t.app, chi).post(`/v1/conversations/${conv}/leave`)).status).toBe(200);
    expect((await addSongs(chi, mix.id, [await song('Out')])).status).toBe(404);
    // Private again: Bola is out.
    await as(t.app, ada).patch(`/v1/mixes/${mix.id}`, { visibility: 'private' });
    expect((await getMix(bola, mix.id)).status).toBe(404);
    await as(t.app, ada).patch(`/v1/mixes/${mix.id}`, { visibility: 'followers' });
    expect((await getMix(bola, mix.id)).status).toBe(200);
    // Unsending the card ends it too.
    expect((await as(t.app, ada).post(`/v1/messages/${card.id}/unsend`)).status).toBe(200);
    expect((await getMix(bola, mix.id)).status).toBe(404);
  });

  it('follows the messaging rules in one-to-one chats: no sharing or adding across a block', async () => {
    const ada = await adult();
    const bola = await adult();
    const conv = await direct(ada, bola);
    const mix = await makeMix(ada, { visibility: 'friends' });
    expect((await share(ada, mix.id, conv)).status).toBe(201);
    expect((await addSongs(bola, mix.id, [await song('Before')])).status).toBe(201);
    expect((await as(t.app, bola).post(`/v1/users/${ada.id}/block`)).status).toBe(200);
    expect((await addSongs(bola, mix.id, [await song('After')])).status).toBe(404);
    expect((await share(ada, mix.id, conv)).status).toBe(403);
    // Someone outside the chat can't share into it.
    const chi = await adult();
    const chis = await makeMix(chi, { visibility: 'public' });
    expect((await share(chi, chis.id, conv)).status).toBe(404);
  });

  it('keeps adults who aren’t friends with an under-18 from sharing a mix with them', async () => {
    const grown = await adult();
    const kid = await minor();
    // A chat between them can't exist without friendship: start one as friends, then end the friendship.
    const conv = await direct(grown, kid);
    const [x, y] = [grown.id, kid.id].sort();
    await db().query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
    const mix = await makeMix(grown, { visibility: 'public' });
    const r = await share(grown, mix.id, conv);
    expect(r.status).toBe(403);
  });
});

describe('posts', () => {
  it('shares a mix as a post whose card follows the mix’s audience', async () => {
    const ada = await adult();
    const follower = await adult();
    const stranger = await adult();
    await follow(follower, ada);
    const mix = await makeMix(ada, { visibility: 'followers', songs: [{ trackId: await song('Posted') }] });
    const r = await as(t.app, ada).post(`/v1/mixes/${mix.id}/post`, { body: 'New mix', visibility: 'public' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const postId = r.body.post.id;
    expect(r.body.post.mix).toMatchObject({ available: true, id: mix.id, songCount: 1 });
    const asFollower = (await as(t.app, follower).get(`/v1/posts/${postId}`)).body.post;
    expect(asFollower.mix).toMatchObject({ available: true, id: mix.id });
    const asStranger = (await as(t.app, stranger).get(`/v1/posts/${postId}`)).body.post;
    expect(asStranger.mix).toEqual({ id: mix.id, available: false });
    // Others can't share a mix that isn't public.
    expect((await as(t.app, follower).post(`/v1/mixes/${mix.id}/post`, {})).status).toBe(403);
  });
});

describe('your data', () => {
  it('lists your mixes in the export, and deleting the account removes them but keeps your songs on others’ mixes', async () => {
    const ada = await adult();
    const bola = await adult();
    const conv = await group(bola, [ada]);
    const own = await makeMix(ada, { title: 'Ada’s own', songs: [{ trackId: await song('Ada song') }] });
    const bolas = await makeMix(bola, { title: 'Bola’s', visibility: 'friends' });
    await share(bola, bolas.id, conv);
    expect((await addSongs(ada, bolas.id, [await song('From Ada')])).status).toBe(201);
    await as(t.app, ada).put(`/v1/mixes/${bolas.id}/like`);

    const exported = await as(t.app, ada).get('/v1/me/export');
    expect(exported.status).toBe(200);
    expect(exported.body.mixes.map((m: { title: string }) => m.title)).toEqual(['Ada’s own']);
    expect(exported.body.mixes[0].songs[0].title).toBe('[Dev data] Ada song');
    expect(exported.body.mixSongsAdded).toHaveLength(1);
    expect(exported.body.mixLikes).toHaveLength(1);

    expect((await as(t.app, ada).del('/v1/me', { password: ada.password })).status).toBe(200);
    expect((await db().query(`SELECT 1 FROM mixes WHERE id = $1`, [own.id])).rowCount).toBe(0);
    const after = (await getMix(bola, bolas.id)).body.mix as MixDetail;
    const kept = after.songs.find((s: MixSong) => s.title === '[Dev data] From Ada')!;
    expect(kept).toMatchObject({ addedBy: null, addedByFormer: true });
    expect(after.likeCount).toBe(0);
  });
});
