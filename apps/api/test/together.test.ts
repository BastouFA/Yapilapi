import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickBestOf, togetherClosesAt } from '@yapilapi/shared';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { sweepTogethers } from '../src/lib/together.ts';

const TEEN = `${new Date().getUTCFullYear() - 15}-01-01`;

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('REAL_TOGETHER', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
});
afterAll(async () => {
  await db().query(`DELETE FROM feature_flags WHERE key = 'REAL_TOGETHER'`);
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const teen = () => signUp(t.app, { birthDate: TEEN });
const sweep = () => sweepTogethers({ db: db(), realtime: t.ctx.realtime });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** An uploaded photo (or video) of `owner`'s; `ready` gives it a stored file, as recaps need. */
async function media(owner: TestUser, kind: 'image' | 'video' = 'image', ready = false) {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, moderation) VALUES ($1,$2,'http://localhost:4000/media/x.jpg',$3,'ready',$4,'ok') RETURNING id`,
    [owner.id, kind, kind === 'video' ? 'video/mp4' : 'image/jpeg', ready ? `t/${Math.random().toString(36).slice(2)}.jpg` : null],
  );
  return rows[0].id as string;
}

async function album(host: TestUser, body: Record<string, unknown> = {}) {
  const r = await as(t.app, host).post('/v1/together', { title: 'Lagos weekend', closesAt: null, ...body });
  expect(r.status).toBe(201);
  return r.body.together as { id: string; [k: string]: any };
}

async function add(u: TestUser, id: string, n = 1, extra: Record<string, unknown> = {}) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ mediaId: await media(u), ...extra });
  const r = await as(t.app, u).post(`/v1/together/${id}/items`, { items });
  expect(r.status).toBe(201);
  return r.body.items as { id: string; [k: string]: any }[];
}

const notices = (u: TestUser, type: string) =>
  db()
    .query(`SELECT actor_id, data, entity_id FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [u.id, type])
    .then((r) => r.rows);

describe('Together: who can do what', () => {
  it('keeps albums to their members, with hosts, co-hosts and members', async () => {
    const [host, friend, cohost, stranger] = [await adult(), await adult(), await adult(), await adult()];
    await befriend(host, friend);
    await befriend(host, cohost);
    expect((await as(t.app, host).post('/v1/together', { title: 'Trip', memberIds: [stranger.id] })).status).toBe(403);
    const a = await album(host, { memberIds: [friend.id, cohost.id], cohostIds: [cohost.id], description: 'Three days by the sea' });
    expect(a.myRole).toBe('host');
    expect(a.closesAt).toBeNull();
    expect(a.members.map((m: any) => m.role)).toEqual(['host', 'cohost', 'member']);
    expect((await notices(friend, 'together_invite'))[0]).toMatchObject({ actor_id: host.id, data: { title: 'Lagos weekend' } });
    expect((await as(t.app, stranger).get(`/v1/together/${a.id}`)).status).toBe(404);

    // Several at once, with the time from the file; nothing about where.
    const taken = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const items = await add(friend, a.id, 2, { takenAt: taken, caption: 'From the boat' });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ takenAt: taken, takenFromFile: true, caption: 'From the boat', mine: true });
    // Not your media, a date in the future (used as "now"), and too many at once.
    expect((await as(t.app, friend).post(`/v1/together/${a.id}/items`, { items: [{ mediaId: await media(host) }] })).status).toBe(404);
    const future = await as(t.app, friend).post(`/v1/together/${a.id}/items`, {
      items: [{ mediaId: await media(friend), takenAt: new Date(Date.now() + 86_400_000).toISOString() }],
    });
    expect(future.body.items[0].takenFromFile).toBe(false);
    const many = await Promise.all(Array.from({ length: 21 }, () => media(friend)));
    expect((await as(t.app, friend).post(`/v1/together/${a.id}/items`, { items: many.map((mediaId) => ({ mediaId })) })).status).toBe(400);

    // Members can't change the album; co-hosts can.
    expect((await as(t.app, friend).patch(`/v1/together/${a.id}`, { title: 'Mine now' })).status).toBe(403);
    expect((await as(t.app, friend).post(`/v1/together/${a.id}/close`)).status).toBe(403);
    const renamed = await as(t.app, cohost).patch(`/v1/together/${a.id}`, { title: 'Lagos, three days', coverItemId: items[1]!.id });
    expect(renamed.status).toBe(200);
    expect(renamed.body.together.title).toBe('Lagos, three days');
    expect(renamed.body.together.cover).not.toBeNull();
    expect((await as(t.app, cohost).patch(`/v1/together/${a.id}`, { coverItemId: await media(cohost) })).status).toBe(400);

    // Your own items, or anyone's if you host.
    const hosts = await add(host, a.id);
    expect((await as(t.app, friend).del(`/v1/together/${a.id}/items/${hosts[0]!.id}`)).status).toBe(404);
    expect((await as(t.app, friend).del(`/v1/together/${a.id}/items/${items[0]!.id}`)).status).toBe(200);
    expect((await as(t.app, cohost).del(`/v1/together/${a.id}/items/${hosts[0]!.id}`)).status).toBe(200);

    // Only the person who started it deletes it; co-hosts are chosen by them too.
    expect((await as(t.app, cohost).put(`/v1/together/${a.id}/members/${friend.id}/role`, { role: 'cohost' })).status).toBe(403);
    expect((await as(t.app, cohost).del(`/v1/together/${a.id}`)).status).toBe(403);
    expect((await as(t.app, cohost).del(`/v1/together/${a.id}/members/${host.id}`)).status).toBe(403);
    expect((await as(t.app, host).post(`/v1/together/${a.id}/leave`)).status).toBe(400);
    expect((await as(t.app, host).del(`/v1/together/${a.id}`)).status).toBe(200);
    expect((await as(t.app, friend).get(`/v1/together/${a.id}`)).status).toBe(404);
    expect((await as(t.app, friend).get('/v1/together')).body.items.map((x: any) => x.id)).not.toContain(a.id);
  });

  it('is off with its flag', async () => {
    const u = await adult();
    await db().query(`UPDATE feature_flags SET enabled = false WHERE key = 'REAL_TOGETHER'`);
    const r = await as(t.app, u).get('/v1/together');
    await db().query(`UPDATE feature_flags SET enabled = true WHERE key = 'REAL_TOGETHER'`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('feature_disabled');
  });
});

describe('Together: invite link and approval', () => {
  it('lets guests ask to join, and a host decides', async () => {
    const [host, cohost, guest, other, blocked] = [await adult(), await adult(), await adult(), await adult(), await adult()];
    await befriend(host, cohost);
    const a = await album(host, { memberIds: [cohost.id], cohostIds: [cohost.id] });
    await add(host, a.id, 2);
    expect(a.invite).toEqual({ code: null, enabled: false });
    expect((await as(t.app, cohost).post(`/v1/together/${a.id}/invite`, { enabled: true })).status).toBe(200);
    const code = (await as(t.app, host).get(`/v1/together/${a.id}`)).body.together.invite.code as string;
    expect(code).toMatch(/^[\w-]{8,}$/);

    // What the link shows: the album, never its photos.
    const preview = await as(t.app, guest).get(`/v1/together/invite/${code}`);
    expect(preview.body.invite).toMatchObject({ id: a.id, title: 'Lagos weekend', itemCount: 2, state: 'none' });
    expect(JSON.stringify(preview.body)).not.toContain('x.jpg');
    const asked = await as(t.app, guest).post(`/v1/together/invite/${code}/request`);
    expect(asked.body.invite.state).toBe('requested');
    expect((await notices(host, 'together_request'))[0]).toMatchObject({ actor_id: guest.id });
    expect(await notices(cohost, 'together_request')).toHaveLength(1);
    expect((await as(t.app, guest).get(`/v1/together/${a.id}`)).status).toBe(404);
    expect((await as(t.app, host).get(`/v1/together`)).body.items.find((x: any) => x.id === a.id).requestCount).toBe(1);

    // Only hosts see and decide requests.
    expect((await as(t.app, guest).get(`/v1/together/${a.id}/requests`)).status).toBe(404);
    const list = await as(t.app, cohost).get(`/v1/together/${a.id}/requests`);
    expect(list.body.items.map((r: any) => r.user.id)).toEqual([guest.id]);
    expect((await as(t.app, cohost).post(`/v1/together/${a.id}/requests/${guest.id}`, { approve: true })).status).toBe(200);
    expect(await notices(guest, 'together_approved')).toHaveLength(1);
    expect((await as(t.app, guest).get(`/v1/together/${a.id}`)).body.together.myRole).toBe('member');

    // Declined stays declined.
    await as(t.app, other).post(`/v1/together/invite/${code}/request`);
    await as(t.app, host).post(`/v1/together/${a.id}/requests/${other.id}`, { approve: false });
    expect((await as(t.app, other).post(`/v1/together/invite/${code}/request`)).body.invite.state).toBe('declined');
    expect((await as(t.app, other).get(`/v1/together/${a.id}`)).status).toBe(404);

    // Nobody the host blocked finds it, and a new link retires the old one.
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [host.id, blocked.id]);
    expect((await as(t.app, blocked).get(`/v1/together/invite/${code}`)).status).toBe(404);
    const fresh = await as(t.app, host).post(`/v1/together/${a.id}/invite`, { enabled: true, reset: true });
    expect(fresh.body.invite.code).not.toBe(code);
    expect((await as(t.app, other).get(`/v1/together/invite/${code}`)).status).toBe(404);
    await as(t.app, host).post(`/v1/together/${a.id}/invite`, { enabled: false });
    expect((await as(t.app, other).get(`/v1/together/invite/${fresh.body.invite.code}`)).status).toBe(404);
  });
});

describe('Together: when it closes', () => {
  it('closes at its time, tells members an hour before and when it closes, and can reopen', async () => {
    const [host, friend] = [await adult(), await adult()];
    await befriend(host, friend);
    expect((await as(t.app, host).post('/v1/together', { title: 'Too soon', closesAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(400);
    const a = await album(host, { memberIds: [friend.id], closesAt: new Date(Date.now() + 5 * 3_600_000).toISOString() });
    expect(a.closesAt).not.toBeNull();

    // Within the hour: one notice, however often the sweep runs.
    await db().query(`UPDATE togethers SET closes_at = now() + interval '40 minutes', opened_at = now() - interval '5 hours' WHERE id = $1`, [a.id]);
    await sweep();
    await sweep();
    expect(await notices(friend, 'together_closing')).toHaveLength(1);
    expect(await notices(host, 'together_closing')).toHaveLength(1);

    // Its time comes: nothing more can be added, and everyone hears once.
    await db().query(`UPDATE togethers SET closes_at = now() - interval '1 minute' WHERE id = $1`, [a.id]);
    expect((await as(t.app, friend).post(`/v1/together/${a.id}/items`, { items: [{ mediaId: await media(friend) }] })).status).toBe(400);
    await sweep();
    await sweep();
    expect(await notices(friend, 'together_closed')).toHaveLength(1);
    expect(await notices(host, 'together_closed')).toHaveLength(1);
    expect((await as(t.app, friend).get(`/v1/together/${a.id}`)).body.together).toMatchObject({ status: 'closed', canAdd: false });

    // Reopened until a host closes it; closed early by the host, only the others hear.
    const re = await as(t.app, host).post(`/v1/together/${a.id}/reopen`, { closesAt: null });
    expect(re.body.together).toMatchObject({ status: 'open', closesAt: null });
    await add(friend, a.id);
    await as(t.app, host).post(`/v1/together/${a.id}/close`);
    expect(await notices(friend, 'together_closed')).toHaveLength(2);
    expect(await notices(host, 'together_closed')).toHaveLength(1);

    // An album open for about an hour anyway gets no "closing soon".
    const short = await album(host, { memberIds: [friend.id], closesAt: new Date(Date.now() + 50 * 60_000).toISOString() });
    await sweep();
    expect((await notices(friend, 'together_closing')).filter((n) => n.entity_id === short.id)).toHaveLength(0);
  });

  it('works out the windows from the device clock', () => {
    const sat = new Date(2026, 9, 10, 18, 30); // Saturday evening
    expect(togetherClosesAt('tonight', sat)!.getTime()).toBe(new Date(2026, 9, 11, 4, 0).getTime());
    expect(togetherClosesAt('weekend', sat)!.getTime()).toBe(new Date(2026, 9, 12, 4, 0).getTime());
    expect(togetherClosesAt('day', sat)!.getTime() - sat.getTime()).toBe(24 * 3_600_000);
    expect(togetherClosesAt('open', sat)).toBeNull();
    // Just after 3 in the morning, "tonight" is the coming night.
    expect(togetherClosesAt('tonight', new Date(2026, 9, 11, 3, 10))!.getTime()).toBe(new Date(2026, 9, 12, 4, 0).getTime());
  });
});

describe('Together: notifications', () => {
  it('coalesces "added photos" to one per album, person and half hour, and respects settings', async () => {
    const [host, friend, other, quiet] = [await adult(), await adult(), await adult(), await adult()];
    for (const u of [friend, other, quiet]) await befriend(host, u);
    const a = await album(host, { memberIds: [friend.id, other.id, quiet.id] });
    await db().query(
      `INSERT INTO user_preferences (user_id, notification_categories) VALUES ($1, '{"friends": false}')
       ON CONFLICT (user_id) DO UPDATE SET notification_categories = EXCLUDED.notification_categories`,
      [quiet.id],
    );

    await add(host, a.id, 2);
    const video = await media(host, 'video');
    await as(t.app, host).post(`/v1/together/${a.id}/items`, { items: [{ mediaId: video }, { mediaId: await media(host) }, { mediaId: await media(host) }] });
    let n = await notices(friend, 'together_added');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ actor_id: host.id, data: { count: 5, videos: 1, title: 'Lagos weekend' } });
    expect(await notices(quiet, 'together_added')).toHaveLength(0);
    expect(await notices(host, 'together_added')).toHaveLength(0);

    // Someone else adding is their own notice; after half an hour, a new one.
    await add(other, a.id, 1);
    expect(await notices(friend, 'together_added')).toHaveLength(2);
    await db().query(`UPDATE notifications SET created_at = now() - interval '31 minutes' WHERE user_id = $1 AND type = 'together_added'`, [friend.id]);
    await add(host, a.id, 1);
    n = await notices(friend, 'together_added');
    expect(n).toHaveLength(3);
    expect(n[2].data.count).toBe(1);
  });

  it('batches stars on your photos', async () => {
    const [host, a1, a2] = [await adult(), await adult(), await adult()];
    await befriend(host, a1);
    await befriend(host, a2);
    const a = await album(host, { memberIds: [a1.id, a2.id] });
    const [item] = await add(host, a.id);
    expect((await as(t.app, a1).put(`/v1/together/${a.id}/items/${item!.id}/star`)).body.item).toMatchObject({ stars: 1, starred: true });
    await as(t.app, a1).put(`/v1/together/${a.id}/items/${item!.id}/star`);
    await as(t.app, a2).put(`/v1/together/${a.id}/items/${item!.id}/star`);
    const n = await notices(host, 'together_starred');
    expect(n).toHaveLength(1);
    expect(n[0].data.count).toBe(2);
    const off = await as(t.app, a2).del(`/v1/together/${a.id}/items/${item!.id}/star`);
    expect(off.body.item).toMatchObject({ stars: 1, starred: false });
  });
});

describe('Together: blocks and minors', () => {
  it("won't add blocked people or minors who aren't friends, and blocks later hide each other's items", async () => {
    const [host, b, c, d] = [await adult(), await adult(), await adult(), await adult()];
    const kid = await teen();
    const kidFriend = await teen();
    for (const u of [b, c, d, kidFriend]) await befriend(host, u);
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [d.id, host.id]);
    expect((await as(t.app, host).post('/v1/together', { title: 'Party', memberIds: [d.id] })).status).toBe(403);

    // A group chat: everyone who can be added is; the rest are skipped.
    const conv = (await db().query(`INSERT INTO conversations (kind, title, created_by) VALUES ('group', 'Party people', $1) RETURNING id`, [host.id])).rows[0]
      .id as string;
    for (const u of [host, b, c, d, kid, kidFriend])
      await db().query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)`, [conv, u.id]);
    const r = await as(t.app, host).post('/v1/together', { title: 'Party', closesAt: null, conversationId: conv });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ added: 3, skipped: 2 });
    const ids = r.body.together.members.map((m: any) => m.user.id);
    expect(ids).toEqual(expect.arrayContaining([host.id, b.id, c.id, kidFriend.id]));
    expect(ids).not.toContain(kid.id);
    expect(ids).not.toContain(d.id);
    // A card in the chat.
    const card = await db().query(`SELECT meta FROM messages WHERE conversation_id = $1 AND kind = 'system'`, [conv]);
    expect(card.rows[0].meta).toMatchObject({ type: 'together', togetherId: r.body.together.id, title: 'Party' });
    // Picked by name, a minor who isn't a friend is refused.
    const minor = await as(t.app, host).post(`/v1/together/${r.body.together.id}/members`, { userIds: [kid.id] });
    expect(minor.status).toBe(403);
    expect(minor.body.error.code).toBe('minor_protection');

    // B and C block each other after both are in: neither sees the other's items or comments.
    const id = r.body.together.id;
    const [cItem] = await add(c, id);
    const [bItem] = await add(b, id);
    await as(t.app, b).post(`/v1/together/${id}/items/${bItem!.id}/comments`, { body: 'What a night' });
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [b.id, c.id]);
    const seenByB = (await as(t.app, b).get(`/v1/together/${id}`)).body.together;
    expect(seenByB.items.map((i: any) => i.id)).toEqual([bItem!.id]);
    expect(seenByB.members.map((m: any) => m.user.id)).not.toContain(c.id);
    const seenByC = (await as(t.app, c).get(`/v1/together/${id}`)).body.together;
    expect(seenByC.items.map((i: any) => i.id)).toEqual([cItem!.id]);
    expect((await as(t.app, c).get(`/v1/together/${id}/items/${bItem!.id}/comments`)).status).toBe(404);
    expect((await as(t.app, host).get(`/v1/together/${id}/items/${bItem!.id}/comments`)).body.items).toHaveLength(1);
  });

  it('follows the same rule for everyone going to an event', async () => {
    const host = await adult();
    const guest = await adult();
    const kid = await teen();
    const ev = await db().query(
      `INSERT INTO events (host_id, title, starts_at, visibility) VALUES ($1, 'Wedding', now() + interval '1 day', 'public') RETURNING id`,
      [host.id],
    );
    for (const u of [guest, kid]) await db().query(`INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'going')`, [ev.rows[0].id, u.id]);
    const r = await as(t.app, host).post('/v1/together', { title: 'Wedding', eventId: ev.rows[0].id, closesAt: null });
    expect(r.body).toMatchObject({ added: 1, skipped: 1 });
    expect(r.body.together.event).toMatchObject({ id: ev.rows[0].id, title: 'Wedding' });
    // Someone who isn't going can't make an album for it.
    expect((await as(t.app, await adult()).post('/v1/together', { title: 'Me too', eventId: ev.rows[0].id })).status).toBe(403);
    // A minor asking with the link to an adult host who isn't a friend is refused.
    await as(t.app, host).post(`/v1/together/${r.body.together.id}/invite`, { enabled: true });
    const code = (await as(t.app, host).get(`/v1/together/${r.body.together.id}`)).body.together.invite.code;
    const asked = await as(t.app, kid).post(`/v1/together/invite/${code}/request`);
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe('minor_protection');
  });
});

describe('Together: the best of, reactions, comments and reports', () => {
  it('picks the best of from stars and reactions, with nobody taking over', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, authorId: 'ada', stars: 5, reactions: 0, takenAt: at(i) })),
      { id: 'b1', authorId: 'bola', stars: 1, reactions: 0, takenAt: at(20) },
      { id: 'c1', authorId: 'chi', stars: 0, reactions: 2, takenAt: at(21) },
      { id: 'none', authorId: 'chi', stars: 0, reactions: 0, takenAt: at(22) },
    ];
    const best = pickBestOf(items, 6);
    expect(best).toHaveLength(6);
    expect(best.filter((id) => id.startsWith('a'))).toHaveLength(4);
    expect(best).toEqual(expect.arrayContaining(['b1', 'c1']));
    expect(best).not.toContain('none');
    // Oldest first.
    expect(best.at(-1)).toBe('c1');
    // With only one person's photos, they fill the places left over.
    expect(pickBestOf(items.slice(0, 8), 6)).toHaveLength(6);
  });

  it('reacts with the reaction set, comments, and marks the best of', async () => {
    const [host, friend, stranger] = [await adult(), await adult(), await adult()];
    await befriend(host, friend);
    const a = await album(host, { memberIds: [friend.id] });
    const [one, two] = await add(host, a.id, 2);
    expect((await as(t.app, friend).put(`/v1/together/${a.id}/items/${one!.id}/reaction`, { kind: '❤️' })).status).toBe(400);
    const r = await as(t.app, friend).put(`/v1/together/${a.id}/items/${one!.id}/reaction`, { kind: 'heart' });
    expect(r.body.item.reactions).toEqual([{ kind: 'heart', count: 1, mine: true }]);
    await as(t.app, friend).put(`/v1/together/${a.id}/items/${one!.id}/reaction`, { kind: 'sparkle' });
    await as(t.app, host).put(`/v1/together/${a.id}/items/${one!.id}/reaction`, { kind: 'sparkle' });
    const d = (await as(t.app, host).get(`/v1/together/${a.id}`)).body.together;
    expect(d.bestOf).toEqual([one!.id]);
    expect(d.items.find((i: any) => i.id === one!.id)).toMatchObject({ best: true, reactions: [{ kind: 'sparkle', count: 2, mine: true }] });
    expect(d.items.find((i: any) => i.id === two!.id).best).toBe(false);

    const c = await as(t.app, friend).post(`/v1/together/${a.id}/items/${two!.id}/comments`, { body: 'The light here' });
    expect(c.status).toBe(201);
    expect(c.body.items[0]).toMatchObject({ body: 'The light here', mine: true });
    expect((await as(t.app, stranger).post(`/v1/together/${a.id}/items/${two!.id}/comments`, { body: 'Hi' })).status).toBe(404);
    const gone = await as(t.app, host).del(`/v1/together/${a.id}/items/${two!.id}/comments/${c.body.items[0].id}`);
    expect(gone.body.items).toHaveLength(0);

    // Members can report what's in it; nobody else can.
    expect((await as(t.app, stranger).post('/v1/reports', { targetType: 'together_item', targetId: one!.id, reason: 'spam' })).status).toBe(404);
    expect((await as(t.app, friend).post('/v1/reports', { targetType: 'together_item', targetId: one!.id, reason: 'spam' })).status).toBe(201);
  });
});

describe('Together: afterwards', () => {
  it('makes a recap from the best of and a chapter from your own photos', async () => {
    const [host, friend] = [await adult(), await adult()];
    await befriend(host, friend);
    const a = await album(host, { memberIds: [friend.id] });
    const mine = [await media(host, 'image', true), await media(host, 'image', true)];
    const theirs = await media(friend, 'image', true);
    await as(t.app, host).post(`/v1/together/${a.id}/items`, { items: mine.map((mediaId) => ({ mediaId })) });
    await as(t.app, friend).post(`/v1/together/${a.id}/items`, { items: [{ mediaId: theirs }] });

    const recap = await as(t.app, friend).post(`/v1/together/${a.id}/recap`);
    expect(recap.status).toBe(202);
    const row = await db().query(`SELECT source_type, source_id, items, title FROM recaps WHERE id = $1`, [recap.body.recap.id]);
    expect(row.rows[0]).toMatchObject({ source_type: 'together', source_id: a.id, title: 'Lagos weekend' });
    expect(row.rows[0].items.map((i: any) => i.mediaId)).toEqual(expect.arrayContaining([...mine, theirs]));
    // Its recaps show under Recaps even with Memory off.
    expect((await as(t.app, friend).get('/v1/recaps')).status).toBe(200);
    expect((await as(t.app, await adult()).post(`/v1/together/${a.id}/recap`)).status).toBe(404);

    const ch = await as(t.app, host).post(`/v1/together/${a.id}/chapter`, { audience: 'only_me' });
    expect(ch.status).toBe(201);
    expect(ch.body.chapter.stories).toBe(2);
    const chapter = await as(t.app, host).get(`/v1/chapters/${ch.body.chapter.id}`);
    expect(chapter.body.stories).toHaveLength(2);
    expect(chapter.body.chapter.title).toBe('Lagos weekend');
  });
});

describe('Together: your data', () => {
  it('exports what you did in albums, and deleting your account hands albums on', async () => {
    const [host, cohost, member] = [await adult(), await adult(), await adult()];
    await befriend(host, cohost);
    await befriend(host, member);
    const a = await album(host, { memberIds: [cohost.id, member.id], cohostIds: [cohost.id] });
    const [item] = await add(host, a.id);
    await add(member, a.id);
    await as(t.app, member).put(`/v1/together/${a.id}/items/${item!.id}/star`);
    await as(t.app, member).put(`/v1/together/${a.id}/items/${item!.id}/reaction`, { kind: 'heart' });
    await as(t.app, member).post(`/v1/together/${a.id}/items/${item!.id}/comments`, { body: 'Lovely' });

    const out = (await as(t.app, member).get('/v1/me/export')).body;
    expect(out.togetherAlbums.map((x: any) => x.id)).toContain(a.id);
    expect(out.togetherItems).toHaveLength(1);
    expect(out.togetherStars).toHaveLength(1);
    expect(out.togetherReactions[0].kind).toBe('heart');
    expect(out.togetherComments[0].body).toBe('Lovely');

    // The member goes: their stars, reactions, comments, place and items go with them.
    expect((await as(t.app, member).del('/v1/me', { password: member.password })).status).toBe(200);
    const after = (await as(t.app, host).get(`/v1/together/${a.id}`)).body.together;
    expect(after.items.map((i: any) => i.id)).toEqual([item!.id]);
    expect(after.items[0]).toMatchObject({ stars: 0, reactions: [], comments: 0 });
    for (const table of ['together_stars', 'together_reactions', 'together_members', 'together_requests'])
      expect((await db().query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [member.id])).rowCount).toBe(0);
    expect((await db().query(`SELECT 1 FROM together_comments WHERE author_id = $1`, [member.id])).rowCount).toBe(0);

    // The host goes: the co-host hosts it now.
    expect((await as(t.app, host).del('/v1/me', { password: host.password })).status).toBe(200);
    const now = (await as(t.app, cohost).get(`/v1/together/${a.id}`)).body.together;
    expect(now.myRole).toBe('host');
    expect(now.items).toHaveLength(0);
  });
});
