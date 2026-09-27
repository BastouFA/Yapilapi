import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOM_MAX_LISTENERS, ROOM_MAX_SPEAKERS } from '@yapilapi/shared';
import type { BuiltApp } from '../src/app.ts';
import { sweepRooms } from '../src/lib/rooms.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const ADULT = '1990-04-02';
const TEEN = `${new Date().getUTCFullYear() - 15}-03-01`;
const adult = () => signUp(t.app, { birthDate: ADULT });
const teen = () => signUp(t.app, { birthDate: TEEN });
const deps = () => ({ db: db(), realtime: t.ctx.realtime, media: t.ctx.roomMedia });

let n = 0;
/** A public community owned by `owner`, with `members` joined. */
async function community(owner: TestUser, members: TestUser[] = []): Promise<string> {
  const slug = `rooms-${Date.now().toString(36)}${++n}`;
  const r = await as(t.app, owner).post('/v1/communities', { name: `Rooms ${n}`, slug, topics: ['music'] });
  expect(r.status).toBe(201);
  for (const m of members) expect((await as(t.app, m).post(`/v1/communities/${slug}/join`)).status).toBe(200);
  return slug;
}

async function startRoom(host: TestUser, slug: string, title = 'Friday listening session'): Promise<string> {
  const r = await as(t.app, host).post(`/v1/communities/${slug}/rooms`, { title });
  expect(r.status).toBe(201);
  expect(r.body.room.status).toBe('live');
  return r.body.room.id;
}

const join = (u: TestUser, room: string) => as(t.app, u).post(`/v1/rooms/${room}/join`);

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** Many members at once, joined to the community directly in the database. */
async function members(slug: string, count: number): Promise<TestUser[]> {
  const out: TestUser[] = [];
  for (let i = 0; i < count; i += 10) out.push(...(await Promise.all(Array.from({ length: Math.min(10, count - i) }, adult))));
  await db().query(`INSERT INTO community_members (community_id, user_id) SELECT c.id, unnest($2::uuid[]) FROM communities c WHERE c.slug = $1`, [
    slug,
    out.map((u) => u.id),
  ]);
  return out;
}

describe('starting rooms', () => {
  it('only moderators, admins and owners start rooms', async () => {
    const owner = await adult();
    const mod = await adult();
    const organizer = await adult();
    const member = await adult();
    const outsider = await adult();
    const slug = await community(owner, [mod, organizer, member]);
    expect((await as(t.app, owner).put(`/v1/communities/${slug}/members/${mod.id}/role`, { role: 'moderator' })).status).toBe(200);
    expect((await as(t.app, owner).put(`/v1/communities/${slug}/members/${organizer.id}/role`, { role: 'organizer' })).status).toBe(200);

    for (const u of [member, organizer, outsider]) expect((await as(t.app, u).post(`/v1/communities/${slug}/rooms`, { title: 'Mine' })).status).toBe(403);
    expect((await as(t.app, member).get(`/v1/communities/${slug}/rooms`)).body.canStart).toBe(false);
    expect((await as(t.app, mod).get(`/v1/communities/${slug}/rooms`)).body.canStart).toBe(true);

    const room = await startRoom(mod, slug);
    // One live room per community.
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/rooms`, { title: 'Another' })).status).toBe(409);
    const list = await as(t.app, member).get(`/v1/communities/${slug}/rooms`);
    expect(list.body.items.map((r: { id: string }) => r.id)).toContain(room);
    expect(list.body.limits).toEqual({ speakers: ROOM_MAX_SPEAKERS, listeners: ROOM_MAX_LISTENERS });
  });

  it('schedules a room, notifies members who asked when it starts, and only hosts start or end it', async () => {
    const owner = await adult();
    const fan = await adult();
    const quiet = await adult();
    const slug = await community(owner, [fan, quiet]);
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const made = await as(t.app, owner).post(`/v1/communities/${slug}/rooms`, { title: 'Album night', scheduledFor: at });
    expect(made.status).toBe(201);
    const room = made.body.room.id;
    expect(made.body.room).toMatchObject({ status: 'scheduled', scheduledFor: at });
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/rooms`, { title: 'Past', scheduledFor: '2020-01-01T00:00:00Z' })).status).toBe(400);

    expect((await join(fan, room)).body.error.code).toBe('room_not_started');
    expect((await as(t.app, fan).post(`/v1/rooms/${room}/remind`, { on: true })).body.remindMe).toBe(true);
    const listed = (await as(t.app, fan).get(`/v1/communities/${slug}/rooms`)).body.items.find((r: { id: string }) => r.id === room);
    expect(listed.remindMe).toBe(true);

    expect((await as(t.app, fan).post(`/v1/rooms/${room}/start`)).status).toBe(403);
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/start`)).body.room.status).toBe('live');
    const notes = await db().query(`SELECT user_id FROM notifications WHERE type = 'room_live' AND entity_id = $1`, [room]);
    expect(notes.rows.map((r) => r.user_id)).toEqual([fan.id]);

    expect((await as(t.app, fan).post(`/v1/rooms/${room}/end`)).status).toBe(403);
  });
});

describe('joining', () => {
  it('keeps out people who are not members, banned people and people removed from the room', async () => {
    const owner = await adult();
    const member = await adult();
    const outsider = await adult();
    const troll = await adult();
    const slug = await community(owner, [member, troll]);
    const room = await startRoom(owner, slug);

    expect((await join(owner, room)).body.room.speakers.map((p: { user: { id: string } }) => p.user.id)).toEqual([owner.id]);
    expect((await join(outsider, room)).status).toBe(403);
    expect((await as(t.app, outsider).get(`/v1/rooms/${room}`)).status).toBe(403);

    // Banned while in the room: out at once, and can't come back.
    const trollDevice = connect(troll);
    expect((await join(troll, room)).status).toBe(200);
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/members/${troll.id}/ban`)).status).toBe(200);
    expect(trollDevice.of('room.removed')).toHaveLength(1);
    expect((await join(troll, room)).status).toBe(403);
    expect((await as(t.app, troll).post(`/v1/rooms/${room}/reactions`, { kind: 'heart' })).status).toBe(403);
    trollDevice.remove();

    // Removed by a host: can't rejoin this room.
    const memberDevice = connect(member);
    const joined = await join(member, room);
    expect(joined.status).toBe(200);
    expect(joined.body.room.listeners.map((p: { user: { id: string } }) => p.user.id)).toContain(member.id);
    expect(joined.body.media).toMatchObject({ mode: 'mesh', iceTransportPolicy: 'all' });
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/participants/${member.id}/remove`)).status).toBe(200);
    expect(memberDevice.of('room.removed')).toHaveLength(1);
    const again = await join(member, room);
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('removed_from_room');
    expect((await as(t.app, member).get(`/v1/rooms/${room}`)).body.removed).toBe(true);
    memberDevice.remove();
  });

  it('caps listeners and speakers for the mesh', async () => {
    const owner = await adult();
    const slug = await community(owner);
    const crowd = await members(slug, ROOM_MAX_LISTENERS + 1);
    const room = await startRoom(owner, slug);
    await join(owner, room);
    for (const u of crowd.slice(0, ROOM_MAX_LISTENERS)) expect((await join(u, room)).status).toBe(200);
    const full = await join(crowd[ROOM_MAX_LISTENERS]!, room);
    expect(full.status).toBe(409);
    expect(full.body.error).toMatchObject({ code: 'room_full', message: 'Room is full.' });
    const summary = (await as(t.app, owner).get(`/v1/rooms/${room}`)).body.room;
    expect(summary.listenerCount).toBe(ROOM_MAX_LISTENERS + 1);
    expect(summary.peakListeners).toBe(ROOM_MAX_LISTENERS + 1);

    // Five more speakers fill the stage (the host is the first).
    for (const u of crowd.slice(0, ROOM_MAX_SPEAKERS - 1)) {
      expect((await as(t.app, owner).post(`/v1/rooms/${room}/participants/${u.id}/invite`)).status).toBe(200);
      expect((await as(t.app, u).post(`/v1/rooms/${room}/speak`, { accept: true })).body.role).toBe('speaker');
    }
    const next = crowd[ROOM_MAX_SPEAKERS]!;
    const invite = await as(t.app, owner).post(`/v1/rooms/${room}/participants/${next.id}/invite`);
    expect(invite.status).toBe(409);
    expect(invite.body.error.code).toBe('room_full');
    // Someone steps down, which frees a spot.
    expect((await as(t.app, crowd[0]!).post(`/v1/rooms/${room}/participants/${crowd[0]!.id}/listener`)).status).toBe(200);
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/participants/${next.id}/invite`)).status).toBe(200);
    // The spot is taken again before they accept: the stage is full when they answer.
    await db().query(`UPDATE room_participants SET role = 'speaker' WHERE room_id = $1 AND user_id = $2`, [room, crowd[0]!.id]);
    expect((await as(t.app, next).post(`/v1/rooms/${room}/speak`, { accept: true })).status).toBe(409);
  });
});

describe('managing speakers', () => {
  it('lets listeners raise a hand, hosts invite, and only hosts manage speakers', async () => {
    const owner = await adult();
    const mod = await adult();
    const ada = await adult();
    const bola = await adult();
    const slug = await community(owner, [mod, ada, bola]);
    await as(t.app, owner).put(`/v1/communities/${slug}/members/${mod.id}/role`, { role: 'moderator' });
    const room = await startRoom(owner, slug);
    for (const u of [owner, mod, ada, bola]) await join(u, room);

    // Hand up, then an invite, then accept.
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/speak`, { accept: true })).status).toBe(403);
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/hand`, { raised: true })).status).toBe(200);
    const adaDevice = connect(ada);
    expect((await as(t.app, bola).post(`/v1/rooms/${room}/participants/${ada.id}/invite`)).status).toBe(403);
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/participants/${ada.id}/invite`)).status).toBe(200);
    expect(adaDevice.of('room.invited')).toHaveLength(1);
    expect(
      adaDevice
        .of('room.state')
        .at(-1)!
        .data.listeners.find((p: any) => p.user.id === ada.id),
    ).toMatchObject({ invited: true, handRaised: true });
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/speak`, { accept: true })).body.role).toBe('speaker');
    const state = adaDevice.of('room.state').at(-1)!.data;
    expect(state.speakers.find((p: any) => p.user.id === ada.id)).toMatchObject({ role: 'speaker', muted: true, handRaised: false, host: false });
    adaDevice.remove();

    // Speakers mute themselves; only hosts mute, move back or remove others.
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/mute`, { muted: false })).body.muted).toBe(false);
    expect((await as(t.app, bola).post(`/v1/rooms/${room}/mute`, { muted: false })).status).toBe(400);
    for (const action of ['mute', 'listener', 'remove']) {
      expect((await as(t.app, bola).post(`/v1/rooms/${room}/participants/${ada.id}/${action}`)).status).toBe(403);
      // A speaker who isn't a host can't either.
      expect((await as(t.app, ada).post(`/v1/rooms/${room}/participants/${bola.id}/${action}`)).status).toBe(403);
      // Hosts don't manage each other.
      expect((await as(t.app, mod).post(`/v1/rooms/${room}/participants/${owner.id}/${action}`)).status).toBe(403);
    }
    expect((await as(t.app, mod).post(`/v1/rooms/${room}/participants/${ada.id}/mute`)).status).toBe(200);
    let detail = (await as(t.app, ada).get(`/v1/rooms/${room}`)).body.room;
    expect(detail.speakers.find((p: any) => p.user.id === ada.id).muted).toBe(true);
    expect((await as(t.app, mod).post(`/v1/rooms/${room}/participants/${ada.id}/listener`)).status).toBe(200);
    detail = (await as(t.app, ada).get(`/v1/rooms/${room}`)).body.room;
    expect(detail.listeners.map((p: any) => p.user.id)).toContain(ada.id);
    // Moderators are hosts: they can step on stage without an invite.
    expect((await as(t.app, mod).post(`/v1/rooms/${room}/speak`, { accept: true })).body.role).toBe('speaker');
  });
});

describe('signaling', () => {
  it('relays only between people in the same live room, where one of them speaks', async () => {
    const owner = await adult();
    const ada = await adult();
    const bola = await adult();
    const gone = await adult();
    const outsider = await adult();
    const slug = await community(owner, [ada, bola, gone]);
    const room = await startRoom(owner, slug);
    for (const u of [owner, ada, bola, gone]) await join(u, room);
    await as(t.app, gone).post(`/v1/rooms/${room}/leave`);

    // Another community's room, with its own people.
    const otherOwner = await adult();
    const otherSlug = await community(otherOwner, [outsider]);
    const otherRoom = await startRoom(otherOwner, otherSlug);
    await join(otherOwner, otherRoom);
    await join(outsider, otherRoom);

    const adaDevice = connect(ada);
    const offer = { type: 'offer', sdp: 'v=0' };
    const send = (from: TestUser, roomId: string, to: TestUser) =>
      as(t.app, from).post(`/v1/rooms/${roomId}/signal`, { toUserId: to.id, type: 'offer', data: offer });

    // Speaker to listener, and back.
    expect((await send(owner, room, ada)).status).toBe(200);
    expect(adaDevice.of('room.signal')).toEqual([{ type: 'room.signal', data: { roomId: room, from: owner.id, type: 'offer', data: offer } }]);
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/signal`, { toUserId: owner.id, type: 'answer', data: { sdp: 'x' } })).status).toBe(200);
    // Two listeners never connect.
    expect((await send(ada, room, bola)).status).toBe(403);
    // Not to someone who left, someone in another room, or from outside the room.
    expect((await send(owner, room, gone)).status).toBe(404);
    expect((await send(owner, room, outsider)).status).toBe(404);
    expect((await send(outsider, room, owner)).status).toBe(404);
    expect((await send(otherOwner, room, ada)).status).toBe(404);
    expect((await send(otherOwner, otherRoom, ada)).status).toBe(404);
    // Oversized payloads are refused.
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/signal`, { toUserId: ada.id, type: 'candidate', data: { blob: 'x'.repeat(70_000) } })).status).toBe(
      400,
    );
    // Blocks apply.
    await as(t.app, ada).post(`/v1/users/${owner.id}/block`);
    expect((await send(owner, room, ada)).status).toBe(404);
    // Nothing once the room has ended.
    await as(t.app, owner).post(`/v1/rooms/${room}/end`);
    expect((await send(owner, room, bola)).status).toBe(404);
    expect(adaDevice.of('room.signal')).toHaveLength(1);
    adaDevice.remove();
  });

  it('sends reactions to everyone in the room, from the fixed set only', async () => {
    const owner = await adult();
    const ada = await adult();
    const slug = await community(owner, [ada]);
    const room = await startRoom(owner, slug);
    await join(owner, room);
    await join(ada, room);
    const device = connect(owner);
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/reactions`, { kind: 'sparkle' })).status).toBe(200);
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/reactions`, { kind: 'fire' })).status).toBe(400);
    expect(device.of('room.reaction')).toEqual([{ type: 'room.reaction', data: { roomId: room, userId: ada.id, kind: 'sparkle' } }]);
    device.remove();
  });
});

describe('minor safety', () => {
  it('keeps teens to their own communities and stops adults who are not connected from bringing them up to speak', async () => {
    const owner = await adult();
    const kid = await teen();
    const other = await teen();
    const slug = await community(owner, [kid]);
    const room = await startRoom(owner, slug);
    await join(owner, room);

    // Not a member: no room.
    expect((await join(other, room)).status).toBe(403);

    expect((await join(kid, room)).status).toBe(200);
    await as(t.app, kid).post(`/v1/rooms/${room}/hand`, { raised: true });
    const refused = await as(t.app, owner).post(`/v1/rooms/${room}/participants/${kid.id}/invite`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('minor_protection');

    await befriend(owner, kid);
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/participants/${kid.id}/invite`)).status).toBe(200);
    // The friendship ends before they accept: the invite no longer works.
    await db().query(`DELETE FROM friendships WHERE user_a = ANY($1::uuid[]) AND user_b = ANY($1::uuid[])`, [[owner.id, kid.id]]);
    expect((await as(t.app, kid).post(`/v1/rooms/${room}/speak`, { accept: true })).status).toBe(403);
    await befriend(owner, kid);
    expect((await as(t.app, kid).post(`/v1/rooms/${room}/speak`, { accept: true })).body.role).toBe('speaker');
  });

  it('relays audio for people under 18 through TURN when it is set up', async () => {
    const turn = await testApp({ TURN_URLS: 'turn:turn.example.test:3478', TURN_SECRET: 'test-only-secret' });
    try {
      const owner = await signUp(turn.app, { birthDate: ADULT });
      const kid = await signUp(turn.app, { birthDate: TEEN });
      const slug = `rooms-turn-${Date.now().toString(36)}`;
      await as(turn.app, owner).post('/v1/communities', { name: 'Turn room', slug, topics: ['music'] });
      await as(turn.app, kid).post(`/v1/communities/${slug}/join`);
      const room = (await as(turn.app, owner).post(`/v1/communities/${slug}/rooms`, { title: 'Hi' })).body.room.id;
      const adultJoin = await as(turn.app, owner).post(`/v1/rooms/${room}/join`);
      expect(adultJoin.body.media.iceTransportPolicy).toBe('all');
      const kidJoin = await as(turn.app, kid).post(`/v1/rooms/${room}/join`);
      expect(kidJoin.body.media.iceTransportPolicy).toBe('relay');
      expect(kidJoin.body.media.iceServers.some((s: { username?: string }) => s.username?.endsWith(`:${kid.id}`))).toBe(true);
    } finally {
      await turn.close();
    }
  });
});

describe('ending', () => {
  it('shows ended rooms with duration and peak listeners, and nobody joins them', async () => {
    const owner = await adult();
    const ada = await adult();
    const bola = await adult();
    const slug = await community(owner, [ada, bola]);
    const room = await startRoom(owner, slug);
    for (const u of [owner, ada, bola]) await join(u, room);
    await as(t.app, bola).post(`/v1/rooms/${room}/leave`);
    await db().query(`UPDATE rooms SET started_at = now() - interval '25 minutes' WHERE id = $1`, [room]);
    const adaDevice = connect(ada);
    const ended = await as(t.app, owner).post(`/v1/rooms/${room}/end`);
    expect(ended.body.room).toMatchObject({ status: 'ended', peakListeners: 3, listenerCount: 0 });
    expect(ended.body.room.durationSeconds).toBeGreaterThanOrEqual(25 * 60);
    expect(adaDevice.of('room.state').at(-1)!.data.status).toBe('ended');
    adaDevice.remove();
    expect((await join(ada, room)).body.error.code).toBe('room_ended');
    expect((await as(t.app, owner).post(`/v1/rooms/${room}/end`)).status).toBe(409);
    const listed = (await as(t.app, ada).get(`/v1/communities/${slug}/rooms`)).body.items.find((r: { id: string }) => r.id === room);
    expect(listed).toMatchObject({ status: 'ended', peakListeners: 3 });
  });

  it('drops people whose app went quiet and ends rooms left without a host', async () => {
    const owner = await adult();
    const ada = await adult();
    const slug = await community(owner, [ada]);
    const room = await startRoom(owner, slug);
    await join(owner, room);
    await join(ada, room);
    await db().query(`UPDATE room_participants SET last_seen_at = now() - interval '2 minutes' WHERE room_id = $1 AND user_id = $2`, [room, ada.id]);
    await sweepRooms(deps());
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/heartbeat`)).body.error.code).toBe('not_in_room');
    expect((await join(ada, room)).status).toBe(200);
    expect((await as(t.app, ada).post(`/v1/rooms/${room}/heartbeat`)).status).toBe(200);

    // The host goes quiet; five minutes later the room ends at the time they were last there.
    await db().query(`UPDATE room_participants SET last_seen_at = now() - interval '10 minutes' WHERE room_id = $1 AND user_id = $2`, [room, owner.id]);
    await db().query(`UPDATE rooms SET started_at = now() - interval '20 minutes', host_seen_at = now() - interval '10 minutes' WHERE id = $1`, [room]);
    await sweepRooms(deps());
    const detail = (await as(t.app, ada).get(`/v1/rooms/${room}`)).body.room;
    expect(detail.status).toBe('ended');
    expect(detail.durationSeconds).toBeGreaterThanOrEqual(9 * 60);
    expect(detail.durationSeconds).toBeLessThan(11 * 60);
  });
});
