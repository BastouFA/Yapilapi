import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@yapilapi/database';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';
import {
  auditCount,
  befriend,
  block,
  follow,
  inDays,
  insertImage,
  notifCount,
  teenBirth,
} from './entity-helpers.js';
import { getDeletionHooks } from '../src/lib/hooks.js';
import {
  attendEventWithTicket,
  completeEndedEvents,
  listAttendedEventsForMemory,
  listEventAttendeesForMemory,
  releaseEventTicket,
  sendEventReminders,
} from '../src/modules/events/index.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const anon = () => new Client(t);
const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);

async function mk(host: TestUser, over: Record<string, unknown> = {}) {
  const r = await host.client.post('/v1/events', {
    title: `Event ${uniq('e')}`,
    startsAt: inDays(3),
    endsAt: inDays(3, 2),
    locationText: 'Town Hall',
    publish: true,
    visibility: 'public',
    ...over,
  });
  if (r.status !== 201)
    throw new Error(`create event failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as any;
}
const rsvp = (u: TestUser, id: string, status: string, extra: Record<string, unknown> = {}) =>
  u.client.put(`/v1/events/${id}/rsvp`, { status, ...extra });
const going = async (u: TestUser, id: string, extra: Record<string, unknown> = {}) => {
  const r = await rsvp(u, id, 'going', extra);
  if (r.status !== 200) throw new Error(`rsvp failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
async function addMemberToCommunity(
  owner: TestUser,
  communityId: string,
  u: TestUser,
  role?: string,
) {
  await owner.client.post(`/v1/communities/${communityId}/invitations`, { userId: u.id });
  await u.client.post(`/v1/communities/${communityId}/invitation/accept`);
  if (role)
    await owner.client.put(`/v1/communities/${communityId}/members/${u.id}/role`, {
      roleKey: role,
    });
}
const counts = async (id: string) =>
  (await sql('SELECT going_count, interested_count FROM events WHERE id = $1', [id])).rows[0] as {
    going_count: number;
    interested_count: number;
  };
const realGoing = async (id: string) =>
  Number(
    (
      await sql(
        `SELECT COALESCE(sum(spots),0)::int AS n FROM event_attendees WHERE event_id = $1 AND status IN ('going','attended')`,
        [id],
      )
    ).rows[0].n,
  );
const startNow = (id: string) =>
  sql(
    `UPDATE events SET starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' WHERE id = $1`,
    [id],
  );

describe('creating events', () => {
  it('creates drafts by default and published events on request, with audit', async () => {
    const h = await signup(t);
    const draft = await h.client.post('/v1/events', { title: 'Draft party', startsAt: inDays(5) });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      status: 'draft',
      visibility: 'public',
      timezone: 'UTC',
      host: { id: h.id },
      viewer: { isOrganiser: true, isManager: true },
    });
    const pub = await mk(h, {
      topics: ['technology'],
      capacity: 50,
      timezone: 'Europe/Paris',
      description: 'Bring friends',
    });
    expect(pub).toMatchObject({
      status: 'published',
      capacity: 50,
      timezone: 'Europe/Paris',
      topics: ['technology'],
      counts: { going: 0, interested: 0, waitlist: 0, spotsLeft: 50 },
    });
    expect(pub.publishedAt).toBeTruthy();
    expect(await auditCount(t, 'event.created', pub.id)).toBe(1);
  });

  it('validates input and requires authentication', async () => {
    const h = await signup(t);
    expect(
      (await anon().post('/v1/events', { title: 'Nope nope', startsAt: inDays(2) })).status,
    ).toBe(401);
    expect((await h.client.post('/v1/events', { title: 'x', startsAt: inDays(2) })).status).toBe(
      400,
    );
    expect(
      (await h.client.post('/v1/events', { title: 'Past event', startsAt: inDays(-1) })).status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Backwards',
          startsAt: inDays(3),
          endsAt: inDays(2),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Too long',
          startsAt: inDays(3),
          endsAt: inDays(30),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Bad zone',
          startsAt: inDays(3),
          timezone: 'Mars/Base',
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.client.post('/v1/events', { title: 'Half geo', startsAt: inDays(3), latitude: 10 }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Bad url',
          startsAt: inDays(3),
          onlineUrl: 'http://insecure.example.com',
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.client.post('/v1/events', { title: 'Zero cap', startsAt: inDays(3), capacity: 0 }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Bad topic',
          startsAt: inDays(3),
          topics: ['not-a-topic'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Community vis',
          startsAt: inDays(3),
          visibility: 'community',
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.client.post('/v1/events', { title: 'Nowhere', startsAt: inDays(3), publish: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Nowhere',
          startsAt: inDays(3),
          placeId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    // hostile text is rejected, not published
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Easy money',
          description: 'Guaranteed profit, risk-free returns! Send 1 btc and receive double',
          startsAt: inDays(3),
        })
      ).status,
    ).toBe(422);
  });

  it('checks cover image ownership and copies coordinates from a place', async () => {
    const h = await signup(t);
    const other = await signup(t);
    const mine = await insertImage(t, h.id);
    const theirs = await insertImage(t, other.id);
    const attachmentOnly = await insertImage(t, h.id, { purpose: 'attachment' });
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Cover steal',
          startsAt: inDays(3),
          coverMediaId: theirs,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.client.post('/v1/events', {
          title: 'Cover private',
          startsAt: inDays(3),
          coverMediaId: attachmentOnly,
        })
      ).status,
    ).toBe(400);
    const ok = await h.client.post('/v1/events', {
      title: 'With cover',
      startsAt: inDays(3),
      coverMediaId: mine,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.coverUrl).toContain('test/');
    const place = (
      await sql(
        `INSERT INTO places (name, kind, latitude, longitude) VALUES ('Hall', 'venue', 12.5, 45.5) RETURNING id`,
      )
    ).rows[0];
    const withPlace = await h.client.post('/v1/events', {
      title: 'At the hall',
      startsAt: inDays(3),
      placeId: place.id,
      publish: true,
    });
    expect(withPlace.status).toBe(201);
    expect(withPlace.body).toMatchObject({
      latitude: 12.5,
      longitude: 45.5,
      place: { id: place.id, name: 'Hall' },
    });
  });

  it('applies teen rules: no public events, no paid tickets', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    expect(
      (
        await teen.client.post('/v1/events', {
          title: 'Teen public',
          startsAt: inDays(3),
          visibility: 'public',
        })
      ).status,
    ).toBe(422);
    const e = await teen.client.post('/v1/events', {
      title: 'Teen meetup',
      startsAt: inDays(3),
      locationText: 'Park',
      publish: true,
    });
    expect(e.status).toBe(201);
    expect(e.body.visibility).toBe('friends');
    expect(
      (await teen.client.patch(`/v1/events/${e.body.id}`, { visibility: 'public' })).status,
    ).toBe(422);
    expect(
      (
        await teen.client.post(`/v1/events/${e.body.id}/ticket-types`, {
          name: 'Paid',
          priceCents: 500,
          currency: 'USD',
          quantity: 10,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await teen.client.post(`/v1/events/${e.body.id}/ticket-types`, {
          name: 'Free',
          priceCents: 0,
          quantity: 10,
        })
      ).status,
    ).toBe(201);
  });

  it('hosts community events only with manage_events and restricts private communities', async () => {
    const owner = await signup(t);
    const member = await signup(t);
    const c = (await owner.client.post('/v1/communities', { name: `Club ${uniq('c')}` })).body;
    await addMemberToCommunity(owner, c.id, member);
    expect(
      (
        await member.client.post('/v1/events', {
          title: 'Member event',
          startsAt: inDays(3),
          communityId: c.id,
        })
      ).status,
    ).toBe(403);
    const ev = await owner.client.post('/v1/events', {
      title: 'Club night',
      startsAt: inDays(3),
      communityId: c.id,
      locationText: 'Clubhouse',
      publish: true,
    });
    expect(ev.status).toBe(201);
    expect(ev.body).toMatchObject({
      visibility: 'community',
      community: { id: c.id, name: c.name },
    });
    const priv = (
      await owner.client.post('/v1/communities', {
        name: `Private ${uniq('c')}`,
        visibility: 'private',
        joinPolicy: 'request',
      })
    ).body;
    expect(
      (
        await owner.client.post('/v1/events', {
          title: 'Leaky',
          startsAt: inDays(3),
          communityId: priv.id,
          visibility: 'public',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.client.post('/v1/events', {
          title: 'Fine',
          startsAt: inDays(3),
          communityId: priv.id,
        })
      ).status,
    ).toBe(201);
  });
});

describe('visibility matrix', () => {
  it('draft: only organisers; published public: everyone; cancelled stays visible to those who may see it', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const stranger = await signup(t);
    const d = (
      await host.client.post('/v1/events', {
        title: 'Secret draft',
        startsAt: inDays(3),
        locationText: 'x',
      })
    ).body;
    expect((await host.client.post(`/v1/events/${d.id}/cohosts`, { userId: co.id })).status).toBe(
      201,
    );
    expect((await host.client.get(`/v1/events/${d.id}`)).status).toBe(200);
    expect((await co.client.get(`/v1/events/${d.id}`)).status).toBe(200);
    expect((await stranger.client.get(`/v1/events/${d.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/events/${d.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/events/${d.id}/calendar.ics`)).status).toBe(404);
    expect((await host.client.post(`/v1/events/${d.id}/publish`)).body.status).toBe('published');
    expect((await stranger.client.get(`/v1/events/${d.id}`)).status).toBe(200);
    expect((await anon().get(`/v1/events/${d.id}`)).status).toBe(200);
    expect((await anon().get('/v1/events/not-a-uuid')).status).toBe(400);
  });

  it('followers, friends, private and community events respect relationships', async () => {
    const host = await signup(t);
    const follower = await signup(t);
    const friend = await signup(t);
    const invitee = await signup(t);
    const stranger = await signup(t);
    await follow(follower, host);
    await befriend(host, friend);
    const fEv = await mk(host, { visibility: 'followers' });
    const frEv = await mk(host, { visibility: 'friends' });
    const pEv = await mk(host, { visibility: 'private' });
    for (const [ev, ok, no] of [
      [fEv, follower, [stranger, friend]],
      [frEv, friend, [stranger, follower]],
      [pEv, null, [stranger, follower, friend]],
    ] as const) {
      if (ok) expect((await ok.client.get(`/v1/events/${ev.id}`)).status).toBe(200);
      for (const n of no) expect((await n.client.get(`/v1/events/${ev.id}`)).status).toBe(404);
      expect((await anon().get(`/v1/events/${ev.id}`)).status).toBe(404);
      expect((await host.client.get(`/v1/events/${ev.id}`)).status).toBe(200);
    }
    expect(
      (await host.client.post(`/v1/events/${pEv.id}/invitations`, { userIds: [invitee.id] })).body
        .invited,
    ).toEqual([invitee.id]);
    const seen = await invitee.client.get(`/v1/events/${pEv.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.viewer.invited).toBe(true);
    expect(
      (await invitee.client.get('/v1/me/event-invitations')).body.items.map((e: any) => e.id),
    ).toContain(pEv.id);
    // discovery never leaks them
    const list = (await stranger.client.get('/v1/events', { hostId: host.id })).body.items.map(
      (e: any) => e.id,
    );
    expect(list).not.toContain(pEv.id);
    expect(list).not.toContain(frEv.id);
    expect(list).not.toContain(fEv.id);
  });

  it('community events are for active members; attendees keep access', async () => {
    const owner = await signup(t);
    const member = await signup(t);
    const outsider = await signup(t);
    const c = (await owner.client.post('/v1/communities', { name: `Vis ${uniq('c')}` })).body;
    await addMemberToCommunity(owner, c.id, member);
    const ev = (
      await owner.client.post('/v1/events', {
        title: 'Members only',
        startsAt: inDays(3),
        communityId: c.id,
        locationText: 'Hall',
        publish: true,
      })
    ).body;
    expect((await member.client.get(`/v1/events/${ev.id}`)).status).toBe(200);
    expect((await outsider.client.get(`/v1/events/${ev.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/events/${ev.id}`)).status).toBe(404);
    expect((await outsider.client.get('/v1/events', { communityId: c.id })).body.items).toEqual([]);
    expect(
      (await member.client.get('/v1/events', { communityId: c.id })).body.items.map(
        (e: any) => e.id,
      ),
    ).toEqual([ev.id]);
    // community managers are organisers of community events (manage_events)
    const admin = await signup(t);
    await addMemberToCommunity(owner, c.id, admin, 'admin');
    expect((await admin.client.get(`/v1/events/${ev.id}`)).body.viewer).toMatchObject({
      isOrganiser: true,
      isManager: true,
    });
    expect((await member.client.get(`/v1/events/${ev.id}`)).body.viewer).toMatchObject({
      isOrganiser: false,
    });
    expect(
      (await admin.client.patch(`/v1/events/${ev.id}`, { title: 'Renamed by admin' })).status,
    ).toBe(200);
    expect((await member.client.patch(`/v1/events/${ev.id}`, { title: 'Hijack' })).status).toBe(
      403,
    );
    // someone who bought in and later left the community still sees the event they attend
    await member.client.put(`/v1/events/${ev.id}/rsvp`, { status: 'going' });
    await member.client.post(`/v1/communities/${c.id}/leave`);
    expect((await member.client.get(`/v1/events/${ev.id}`)).status).toBe(200);
  });

  it("blocked users cannot see each other's events, in either direction, and are dropped from discovery", async () => {
    const host = await signup(t);
    const blocked = await signup(t);
    const blocker = await signup(t);
    const ev = await mk(host);
    expect((await blocked.client.get(`/v1/events/${ev.id}`)).status).toBe(200);
    await block(host, blocked);
    expect((await blocked.client.get(`/v1/events/${ev.id}`)).status).toBe(404);
    expect((await blocked.client.get('/v1/events', { hostId: host.id })).body.items).toEqual([]);
    expect((await rsvp(blocked, ev.id, 'going')).status).toBe(404);
    await block(blocker, host);
    expect((await blocker.client.get(`/v1/events/${ev.id}`)).status).toBe(404);
    expect((await host.client.get(`/v1/events/${ev.id}`)).status).toBe(200);
  });
});

describe('editing, publishing, cancelling', () => {
  it('lets hosts and co-hosts edit, refuses strangers/attendees, and notifies attendees of material changes', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const att = await signup(t);
    const stranger = await signup(t);
    const ev = await mk(host, { capacity: 10 });
    await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: co.id });
    await going(att, ev.id);
    expect(
      (await co.client.patch(`/v1/events/${ev.id}`, { description: 'New description' })).status,
    ).toBe(200);
    expect((await att.client.patch(`/v1/events/${ev.id}`, { title: 'Nope nope' })).status).toBe(
      403,
    );
    expect(
      (await stranger.client.patch(`/v1/events/${ev.id}`, { title: 'Nope nope' })).status,
    ).toBe(403);
    expect((await anon().patch(`/v1/events/${ev.id}`, { title: 'Nope nope' })).status).toBe(401);
    expect((await host.client.patch(`/v1/events/${ev.id}`, {})).status).toBe(400);
    expect(await notifCount(t, att.id, 'event_updated')).toBe(0); // description is not a material change
    const moved = await host.client.patch(`/v1/events/${ev.id}`, {
      startsAt: inDays(4),
      endsAt: inDays(4, 3),
      locationText: 'New venue',
      latitude: 1,
      longitude: 2,
      topics: ['technology'],
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      locationText: 'New venue',
      latitude: 1,
      longitude: 2,
      topics: ['technology'],
    });
    expect(await notifCount(t, att.id, 'event_updated')).toBe(1);
    expect(await notifCount(t, co.id, 'event_updated')).toBe(0);
    expect((await host.client.patch(`/v1/events/${ev.id}`, { startsAt: inDays(-1) })).status).toBe(
      400,
    );
    expect((await host.client.patch(`/v1/events/${ev.id}`, { endsAt: inDays(1) })).status).toBe(
      400,
    );
    expect(
      (await host.client.patch(`/v1/events/${ev.id}`, { visibility: 'community' })).status,
    ).toBe(400);
    expect(await auditCount(t, 'event.updated', ev.id)).toBeGreaterThanOrEqual(2);
    const cleared = await host.client.patch(`/v1/events/${ev.id}`, {
      latitude: null,
      longitude: null,
      capacity: null,
    });
    expect(cleared.body).toMatchObject({ latitude: null, capacity: null });
  });

  it('refuses to shrink capacity below the spots taken and promotes the waitlist when it grows', async () => {
    const host = await signup(t);
    const [a, b, c] = [await signup(t), await signup(t), await signup(t)];
    const ev = await mk(host, { capacity: 2 });
    await going(a, ev.id);
    await going(b, ev.id);
    expect((await going(c, ev.id)).status).toBe('waitlist');
    expect((await host.client.patch(`/v1/events/${ev.id}`, { capacity: 1 })).status).toBe(409);
    expect((await host.client.patch(`/v1/events/${ev.id}`, { capacity: 3 })).status).toBe(200);
    expect((await c.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going');
    expect(await notifCount(t, c.id, 'event_waitlist_promoted')).toBe(1);
    expect((await counts(ev.id)).going_count).toBe(3);
    // removing the limit entirely also promotes
    const d = await signup(t);
    await going(d, ev.id);
    expect((await going(await signup(t), ev.id)).status).toBe('waitlist');
    await host.client.patch(`/v1/events/${ev.id}`, { capacity: null });
    expect((await counts(ev.id)).going_count).toBe(5);
  });

  it('publishes drafts once and requires a location or link', async () => {
    const host = await signup(t);
    const d = (await host.client.post('/v1/events', { title: 'Draft only', startsAt: inDays(3) }))
      .body;
    expect((await host.client.post(`/v1/events/${d.id}/publish`)).status).toBe(400);
    await host.client.patch(`/v1/events/${d.id}`, { onlineUrl: 'https://meet.example.com/room' });
    expect((await host.client.post(`/v1/events/${d.id}/publish`)).body.status).toBe('published');
    expect((await host.client.post(`/v1/events/${d.id}/publish`)).body.status).toBe('published'); // idempotent
    expect(await auditCount(t, 'event.published', d.id)).toBe(1);
    expect((await (await signup(t)).client.post(`/v1/events/${d.id}/publish`)).status).toBe(403);
  });

  it('cancels: host only, notifies everyone with a stake, blocks new RSVPs, is idempotent', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const [going1, interested1, wait1] = [await signup(t), await signup(t), await signup(t)];
    const ev = await mk(host, { capacity: 1 });
    await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: co.id });
    await going(going1, ev.id);
    await rsvp(interested1, ev.id, 'interested');
    expect((await going(wait1, ev.id)).status).toBe('waitlist');
    expect((await co.client.post(`/v1/events/${ev.id}/cancel`, {})).status).toBe(403);
    expect((await going1.client.post(`/v1/events/${ev.id}/cancel`, {})).status).toBe(403);
    const c = await host.client.post(`/v1/events/${ev.id}/cancel`, { reason: 'Weather' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', cancelReason: 'Weather' });
    for (const u of [going1, interested1, wait1])
      expect(await notifCount(t, u.id, 'event_cancelled')).toBe(1);
    expect((await host.client.post(`/v1/events/${ev.id}/cancel`, {})).status).toBe(200);
    expect(await notifCount(t, going1.id, 'event_cancelled')).toBe(1);
    expect((await rsvp(await signup(t), ev.id, 'going')).status).toBe(409);
    expect((await host.client.patch(`/v1/events/${ev.id}`, { title: 'Too late' })).status).toBe(
      409,
    );
    expect((await anon().get(`/v1/events/${ev.id}`)).body.status).toBe('cancelled');
    expect(
      (await anon().get('/v1/events', { hostId: host.id })).body.items.map((e: any) => e.id),
    ).not.toContain(ev.id);
    expect(await auditCount(t, 'event.cancelled', ev.id)).toBe(1);
  });

  it('completes started events manually or by job, and deletes only attendee-free events', async () => {
    const host = await signup(t);
    const att = await signup(t);
    const ev = await mk(host);
    expect((await host.client.post(`/v1/events/${ev.id}/complete`)).status).toBe(409); // not started
    await going(att, ev.id);
    expect((await host.client.del(`/v1/events/${ev.id}`)).status).toBe(409);
    await startNow(ev.id);
    expect((await att.client.post(`/v1/events/${ev.id}/complete`)).status).toBe(403);
    expect((await host.client.post(`/v1/events/${ev.id}/complete`)).body.status).toBe('completed');
    expect((await rsvp(await signup(t), ev.id, 'going')).status).toBe(409);
    expect((await host.client.post(`/v1/events/${ev.id}/cancel`, {})).status).toBe(409);
    // job
    const j = await mk(host);
    await sql(
      `UPDATE events SET starts_at = now() - interval '5 hours', ends_at = now() - interval '2 hours' WHERE id = $1`,
      [j.id],
    );
    const done = await completeEndedEvents(t.ctx);
    expect(done).toContain(j.id);
    expect(await completeEndedEvents(t.ctx)).not.toContain(j.id);
    // delete
    const empty = await mk(host);
    expect((await host.client.del(`/v1/events/${empty.id}`)).status).toBe(204);
    expect((await host.client.get(`/v1/events/${empty.id}`)).status).toBe(404);
    expect((await att.client.del(`/v1/events/${ev.id}`)).status).toBe(403);
  });
});

describe('RSVP, capacity and waitlist', () => {
  it('tracks going / interested / not_going with exact counters and is idempotent', async () => {
    const host = await signup(t);
    const [a, b] = [await signup(t), await signup(t)];
    const ev = await mk(host);
    expect((await rsvp(a, ev.id, 'going')).body).toEqual({
      status: 'going',
      counts: { going: 1, interested: 0, waitlist: 0 },
    });
    expect((await rsvp(a, ev.id, 'going')).body.counts.going).toBe(1);
    expect((await rsvp(b, ev.id, 'interested')).body.counts).toEqual({
      going: 1,
      interested: 1,
      waitlist: 0,
    });
    expect((await rsvp(a, ev.id, 'interested')).body.counts).toEqual({
      going: 0,
      interested: 2,
      waitlist: 0,
    });
    expect((await rsvp(b, ev.id, 'going')).body.counts).toEqual({
      going: 1,
      interested: 1,
      waitlist: 0,
    });
    expect((await rsvp(b, ev.id, 'not_going')).body).toMatchObject({
      status: 'not_going',
      counts: { going: 0, interested: 1 },
    });
    expect((await rsvp(b, ev.id, 'not_going')).status).toBe(200);
    expect((await b.client.get(`/v1/events/${ev.id}`)).body.viewer.rsvp).toBe('not_going');
    expect((await a.client.get(`/v1/events/${ev.id}`)).body.viewer.rsvp).toBe('interested');
    expect((await a.client.del(`/v1/events/${ev.id}/rsvp`)).body.status).toBe('not_going');
    expect(await counts(ev.id)).toEqual({ going_count: 0, interested_count: 0 });
    expect((await rsvp(a, ev.id, 'maybe')).status).toBe(400);
    expect((await anon().put(`/v1/events/${ev.id}/rsvp`, { status: 'going' })).status).toBe(401);
    expect((await rsvp(a, '00000000-0000-4000-8000-000000000000', 'going')).status).toBe(404);
  });

  it('rejects RSVPs to drafts and ended events', async () => {
    const host = await signup(t);
    const u = await signup(t);
    const draft = (
      await host.client.post('/v1/events', {
        title: 'Draft one',
        startsAt: inDays(3),
        locationText: 'x',
      })
    ).body;
    expect((await rsvp(u, draft.id, 'going')).status).toBe(404); // invisible
    expect((await rsvp(host, draft.id, 'going')).status).toBe(409);
    const ev = await mk(host);
    await sql(
      `UPDATE events SET starts_at = now() - interval '5 hours', ends_at = now() - interval '2 hours' WHERE id = $1`,
      [ev.id],
    );
    expect((await rsvp(u, ev.id, 'going')).status).toBe(409);
    expect((await rsvp(u, ev.id, 'interested')).status).toBe(409);
  });

  it('fills capacity, waits FIFO and promotes on cancellation with notification', async () => {
    const host = await signup(t);
    const [a, b, w1, w2, w3] = [
      await signup(t),
      await signup(t),
      await signup(t),
      await signup(t),
      await signup(t),
    ];
    const ev = await mk(host, { capacity: 2 });
    expect((await going(a, ev.id)).status).toBe('going');
    expect((await going(b, ev.id)).status).toBe('going');
    for (const w of [w1, w2, w3]) expect((await going(w, ev.id)).status).toBe('waitlist');
    expect((await going(w2, ev.id)).status).toBe('waitlist'); // idempotent, keeps its place
    let view = (await anon().get(`/v1/events/${ev.id}`)).body;
    expect(view.counts).toMatchObject({ going: 2, waitlist: 3, spotsLeft: 0 });
    await rsvp(a, ev.id, 'not_going');
    expect((await w1.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going');
    expect((await w2.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('waitlist');
    expect(await notifCount(t, w1.id, 'event_waitlist_promoted')).toBe(1);
    expect(await notifCount(t, w2.id, 'event_waitlist_promoted')).toBe(0);
    // a going -> interested change frees the spot too
    await rsvp(b, ev.id, 'interested');
    expect((await w2.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going');
    // leaving the waitlist
    await rsvp(w3, ev.id, 'not_going');
    view = (await anon().get(`/v1/events/${ev.id}`)).body;
    expect(view.counts).toMatchObject({ going: 2, waitlist: 0 });
    expect(await realGoing(ev.id)).toBe(2);
  });

  it('answers 409 when the event is full and the waitlist is disabled', async () => {
    const host = await signup(t);
    const [a, b] = [await signup(t), await signup(t)];
    const ev = await mk(host, { capacity: 1, waitlistEnabled: false });
    await going(a, ev.id);
    const r = await rsvp(b, ev.id, 'going');
    expect(r.status).toBe(409);
    expect(r.body.error?.details ?? r.body.details).toMatchObject({ reason: 'event_full' });
    expect((await rsvp(b, ev.id, 'interested')).status).toBe(200);
  });

  it('CONCURRENCY: parallel RSVPs for the last spot yield exactly one winner', async () => {
    const host = await signup(t);
    const users = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const ev = await mk(host, { capacity: 1 });
    const res = await Promise.all(users.map((u) => rsvp(u, ev.id, 'going')));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const statuses = res.map((r) => r.body.status);
    expect(statuses.filter((s) => s === 'going')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'waitlist')).toHaveLength(7);
    expect(await realGoing(ev.id)).toBe(1);
    expect((await counts(ev.id)).going_count).toBe(1);
    // and the last-but-two spots of a larger event
    const ev2 = await mk(host, { capacity: 3 });
    const early = await Promise.all([signup(t), signup(t)]);
    for (const u of early) await going(u, ev2.id);
    const racers = await Promise.all(Array.from({ length: 5 }, () => signup(t)));
    const res2 = await Promise.all(racers.map((u) => rsvp(u, ev2.id, 'going')));
    expect(res2.filter((r) => r.body.status === 'going')).toHaveLength(1);
    expect(await realGoing(ev2.id)).toBe(3);
  });

  it('CONCURRENCY: with the waitlist off, exactly one of many parallel RSVPs succeeds', async () => {
    const host = await signup(t);
    const users = await Promise.all(Array.from({ length: 6 }, () => signup(t)));
    const ev = await mk(host, { capacity: 1, waitlistEnabled: false });
    const res = await Promise.all(users.map((u) => rsvp(u, ev.id, 'going')));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await realGoing(ev.id)).toBe(1);
  });

  it('CONCURRENCY: simultaneous cancel + new RSVP never oversells or strands the waitlist', async () => {
    const host = await signup(t);
    const [a, b] = [await signup(t), await signup(t)];
    const waiters = await Promise.all(Array.from({ length: 4 }, () => signup(t)));
    const ev = await mk(host, { capacity: 2 });
    await going(a, ev.id);
    await going(b, ev.id);
    for (const w of waiters) await going(w, ev.id);
    await Promise.all([
      rsvp(a, ev.id, 'not_going'),
      rsvp(b, ev.id, 'not_going'),
      ...waiters.map((w) => rsvp(w, ev.id, 'going')),
    ]);
    expect(await realGoing(ev.id)).toBe(2);
    expect((await counts(ev.id)).going_count).toBe(2);
    const waitlist = Number(
      (
        await sql(
          `SELECT count(*)::int AS n FROM event_attendees WHERE event_id = $1 AND status = 'waitlist'`,
          [ev.id],
        )
      ).rows[0].n,
    );
    expect(waitlist).toBe(2);
  });
});

describe('ticket types', () => {
  it('creates, edits, lists and archives ticket types with validation', async () => {
    const host = await signup(t);
    const other = await signup(t);
    const ev = await mk(host, { capacity: 100 });
    const url = `/v1/events/${ev.id}/ticket-types`;
    const free = await host.client.post(url, {
      name: 'Free entry',
      priceCents: 0,
      quantity: 50,
      maxPerUser: 1,
    });
    expect(free.status).toBe(201);
    expect(free.body).toMatchObject({
      free: true,
      quantity: 50,
      remaining: 50,
      onSale: true,
      currency: 'USD',
    });
    const paid = await host.client.post(url, {
      name: 'VIP',
      priceCents: 2500,
      currency: 'eur',
      quantity: 10,
      maxPerUser: 4,
      salesStart: inDays(0, 1),
      salesEnd: inDays(2),
    });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ free: false, currency: 'EUR', onSale: false, maxPerUser: 4 });
    expect((await host.client.post(url, { name: 'x', priceCents: -1, quantity: 5 })).status).toBe(
      400,
    );
    expect(
      (
        await host.client.post(url, {
          name: 'Bad window',
          priceCents: 0,
          quantity: 5,
          salesStart: inDays(2),
          salesEnd: inDays(1),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await host.client.post(url, {
          name: 'After event',
          priceCents: 0,
          quantity: 5,
          salesEnd: inDays(10),
        })
      ).status,
    ).toBe(400);
    expect(
      (await host.client.post(url, { name: 'Too many', priceCents: 0, quantity: 101 })).status,
    ).toBe(400);
    expect(
      (
        await host.client.post(url, {
          name: 'Bad cur',
          priceCents: 100,
          currency: 'DOLLARS',
          quantity: 5,
        })
      ).status,
    ).toBe(400);
    expect(
      (await other.client.post(url, { name: 'Steal', priceCents: 0, quantity: 5 })).status,
    ).toBe(403);
    expect((await anon().post(url, { name: 'Steal', priceCents: 0, quantity: 5 })).status).toBe(
      401,
    );
    const list = await anon().get(url);
    expect(list.body.items.map((x: any) => x.name)).toEqual(['Free entry', 'VIP']);
    expect((await anon().get(`/v1/events/${ev.id}`)).body.ticketTypes).toHaveLength(2);
    const upd = await host.client.patch(`${url}/${paid.body.id}`, {
      quantity: 20,
      name: 'VIP plus',
    });
    expect(upd.body).toMatchObject({ quantity: 20, name: 'VIP plus' });
    expect((await other.client.patch(`${url}/${paid.body.id}`, { quantity: 1 })).status).toBe(403);
    expect((await host.client.del(`${url}/${paid.body.id}`)).status).toBe(204);
    expect((await anon().get(url)).body.items).toHaveLength(1);
    expect((await host.client.get(url)).body.items).toHaveLength(2); // organisers still see archived
    expect((await host.client.patch(`${url}/${paid.body.id}`, { quantity: 1 })).status).toBe(404);
    expect((await host.client.patch(`${url}/${free.body.id}`, { quantity: 1000 })).status).toBe(
      400,
    );
  });

  it('free RSVP needs a free ticket type; paid-only events must be bought at checkout', async () => {
    const host = await signup(t);
    const u = await signup(t);
    const ev = await mk(host, { capacity: 20 });
    const paid = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Paid',
        priceCents: 1000,
        currency: 'USD',
        quantity: 5,
      })
    ).body;
    const r = await rsvp(u, ev.id, 'going');
    expect(r.status).toBe(402);
    expect((await rsvp(u, ev.id, 'going', { ticketTypeId: paid.id })).status).toBe(402);
    expect((await rsvp(u, ev.id, 'interested')).status).toBe(200);
    const free = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Free',
        priceCents: 0,
        quantity: 1,
      })
    ).body;
    expect((await rsvp(u, ev.id, 'going')).status).toBe(400); // must choose a ticket type
    expect(
      (await rsvp(u, ev.id, 'going', { ticketTypeId: '00000000-0000-4000-8000-000000000000' }))
        .status,
    ).toBe(400);
    expect((await rsvp(u, ev.id, 'going', { ticketTypeId: paid.id })).status).toBe(402);
    expect((await rsvp(u, ev.id, 'going', { ticketTypeId: free.id })).body.status).toBe('going');
    expect(
      (await sql('SELECT sold FROM event_ticket_types WHERE id = $1', [free.id])).rows[0].sold,
    ).toBe(1);
    // sold out for the next person, and leaving gives the ticket back
    const v = await signup(t);
    expect((await rsvp(v, ev.id, 'going', { ticketTypeId: free.id })).body.status).toBe('waitlist'); // sold out: waitlist
    await rsvp(u, ev.id, 'not_going'); // giving the ticket back promotes the waitlisted person into it
    expect(
      (await sql('SELECT sold FROM event_ticket_types WHERE id = $1', [free.id])).rows[0].sold,
    ).toBe(1);
    expect((await v.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going');
    expect(await notifCount(t, v.id, 'event_waitlist_promoted')).toBe(1);
    const closedEv = await mk(host, { waitlistEnabled: false });
    const one = (
      await host.client.post(`/v1/events/${closedEv.id}/ticket-types`, {
        name: 'One',
        priceCents: 0,
        quantity: 1,
      })
    ).body;
    await going(await signup(t), closedEv.id, { ticketTypeId: one.id });
    const soldOut = await rsvp(await signup(t), closedEv.id, 'going', { ticketTypeId: one.id });
    expect(soldOut.status).toBe(409);
    expect(soldOut.body.error.details).toMatchObject({ reason: 'ticket_sold_out' });
    // sales windows
    const late = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Later',
        priceCents: 0,
        quantity: 5,
        salesStart: inDays(1),
      })
    ).body;
    const w = await signup(t);
    expect((await rsvp(w, ev.id, 'going', { ticketTypeId: late.id })).status).toBe(409);
    // constraints after sales
    expect(
      (await host.client.patch(`/v1/events/${ev.id}/ticket-types/${free.id}`, { quantity: 0 }))
        .status,
    ).toBe(400);
    expect(
      (await host.client.patch(`/v1/events/${ev.id}/ticket-types/${free.id}`, { priceCents: 500 }))
        .status,
    ).toBe(409);
  });

  it('CONCURRENCY: parallel RSVPs for the last free ticket yield one winner and sold never exceeds quantity', async () => {
    const host = await signup(t);
    const users = await Promise.all(Array.from({ length: 6 }, () => signup(t)));
    const ev = await mk(host);
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Last ticket',
        priceCents: 0,
        quantity: 1,
      })
    ).body;
    const res = await Promise.all(
      users.map((u) => rsvp(u, ev.id, 'going', { ticketTypeId: tt.id })),
    );
    expect(res.map((r) => r.body.status).sort()).toEqual([
      'going',
      'waitlist',
      'waitlist',
      'waitlist',
      'waitlist',
      'waitlist',
    ]);
    expect(
      (await sql('SELECT sold, quantity FROM event_ticket_types WHERE id = $1', [tt.id])).rows[0],
    ).toEqual({ sold: 1, quantity: 1 });
    // raising the quantity promotes waiting people into the new tickets
    await host.client.patch(`/v1/events/${ev.id}/ticket-types/${tt.id}`, { quantity: 3 });
    expect(
      (await sql('SELECT sold FROM event_ticket_types WHERE id = $1', [tt.id])).rows[0].sold,
    ).toBe(3);
    expect(await realGoing(ev.id)).toBe(3);
  });
});

describe('attendEventWithTicket (commerce contract)', () => {
  const mkOrder = async (buyerId: string, sellerUserId: string) =>
    (
      await sql(
        `INSERT INTO orders (buyer_id, seller_user_id, currency, subtotal_cents, total_cents, idempotency_key, status) VALUES ($1,$2,'USD',1000,1000,$3,'paid') RETURNING id`,
        [buyerId, sellerUserId, uniq('idem')],
      )
    ).rows[0].id as string;

  it('is idempotent per order, decrements availability and marks the buyer going', async () => {
    const host = await signup(t);
    const buyer = await signup(t);
    const ev = await mk(host, { capacity: 10 });
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'GA',
        priceCents: 1000,
        currency: 'USD',
        quantity: 5,
        maxPerUser: 3,
      })
    ).body;
    const orderId = await mkOrder(buyer.id, host.id);
    const r1 = await attendEventWithTicket(t.ctx, {
      eventId: ev.id,
      userId: buyer.id,
      ticketTypeId: tt.id,
      orderId,
      quantity: 2,
    });
    expect(r1).toMatchObject({ status: 'going', alreadyProcessed: false });
    expect(r1.checkinCode).toHaveLength(10);
    const r2 = await attendEventWithTicket(t.ctx, {
      eventId: ev.id,
      userId: buyer.id,
      ticketTypeId: tt.id,
      orderId,
      quantity: 2,
    });
    expect(r2).toMatchObject({
      alreadyProcessed: true,
      grantId: r1.grantId,
      checkinCode: r1.checkinCode,
    });
    expect(
      (await sql('SELECT sold FROM event_ticket_types WHERE id = $1', [tt.id])).rows[0].sold,
    ).toBe(2);
    expect((await counts(ev.id)).going_count).toBe(2);
    const mine = (await buyer.client.get(`/v1/events/${ev.id}/my-ticket`)).body;
    expect(mine).toMatchObject({ status: 'going', spots: 2, code: r1.checkinCode });
    expect(mine.tickets).toEqual([{ id: r1.grantId, quantity: 2, name: 'GA', paid: true }]);
    // per-user limit (3 max, 2 held)
    const order2 = await mkOrder(buyer.id, host.id);
    await expect(
      attendEventWithTicket(t.ctx, {
        eventId: ev.id,
        userId: buyer.id,
        ticketTypeId: tt.id,
        orderId: order2,
        quantity: 2,
      }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'ticket_limit' } });
    expect(
      (
        await attendEventWithTicket(t.ctx, {
          eventId: ev.id,
          userId: buyer.id,
          ticketTypeId: tt.id,
          orderId: order2,
          quantity: 1,
        })
      ).alreadyProcessed,
    ).toBe(false);
    expect((await counts(ev.id)).going_count).toBe(3);
    // paid attendees cannot RSVP their way out
    expect((await rsvp(buyer, ev.id, 'not_going')).status).toBe(422);
    expect((await rsvp(buyer, ev.id, 'interested')).status).toBe(422);
    // validation
    await expect(
      attendEventWithTicket(t.ctx, {
        eventId: ev.id,
        userId: buyer.id,
        ticketTypeId: '00000000-0000-4000-8000-000000000000',
        orderId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      attendEventWithTicket(t.ctx, {
        eventId: ev.id,
        userId: buyer.id,
        ticketTypeId: tt.id,
        orderId,
        quantity: 0,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('CONCURRENCY: parallel purchases never oversell a ticket type or the event, and duplicate deliveries are harmless', async () => {
    const host = await signup(t);
    const ev = await mk(host, { capacity: 3 });
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Limited',
        priceCents: 500,
        currency: 'USD',
        quantity: 3,
      })
    ).body;
    const buyers = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const orders = await Promise.all(buyers.map((b) => mkOrder(b.id, host.id)));
    // every purchase is delivered twice at the same time
    const results = await Promise.allSettled(
      buyers.flatMap((b, i) =>
        [0, 1].map(() =>
          attendEventWithTicket(t.ctx, {
            eventId: ev.id,
            userId: b.id,
            ticketTypeId: tt.id,
            orderId: orders[i]!,
          }),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed.every((f) => f.reason.code === 'conflict')).toBe(true);
    const distinctWinners = new Set(
      ok.map((r) => (r as PromiseFulfilledResult<any>).value.grantId),
    );
    expect(distinctWinners.size).toBe(3);
    expect(
      (await sql('SELECT sold FROM event_ticket_types WHERE id = $1', [tt.id])).rows[0].sold,
    ).toBe(3);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM event_ticket_grants WHERE event_id = $1 AND status = 'active'`,
          [ev.id],
        )
      ).rows[0].n,
    ).toBe(3);
    expect(await realGoing(ev.id)).toBe(3);
    expect((await counts(ev.id)).going_count).toBe(3);
  });

  it('respects event capacity and closed events, and releasing a ticket promotes the waitlist', async () => {
    const host = await signup(t);
    const ev = await mk(host, { capacity: 2 });
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'GA',
        priceCents: 500,
        currency: 'USD',
        quantity: 2,
      })
    ).body;
    const free = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Free',
        priceCents: 0,
        quantity: 2,
      })
    ).body;
    const [b1, b2, w1] = [await signup(t), await signup(t), await signup(t)];
    const o1 = await mkOrder(b1.id, host.id);
    await attendEventWithTicket(t.ctx, {
      eventId: ev.id,
      userId: b1.id,
      ticketTypeId: tt.id,
      orderId: o1,
    });
    await rsvp(w1, ev.id, 'going', { ticketTypeId: free.id });
    expect((await w1.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going'); // 2/2 now
    const w2 = await signup(t);
    expect((await rsvp(w2, ev.id, 'going', { ticketTypeId: free.id })).body.status).toBe(
      'waitlist',
    );
    const o2 = await mkOrder(b2.id, host.id);
    await expect(
      attendEventWithTicket(t.ctx, {
        eventId: ev.id,
        userId: b2.id,
        ticketTypeId: tt.id,
        orderId: o2,
      }),
    ).rejects.toMatchObject({ details: { reason: 'event_full' } });
    // refund of b1's order: capacity returns, the waitlisted person is promoted with their free ticket
    const rel = await releaseEventTicket(t.ctx, { eventId: ev.id, userId: b1.id, orderId: o1 });
    expect(rel).toEqual({ released: 1, promoted: [w2.id] });
    expect(
      (await releaseEventTicket(t.ctx, { eventId: ev.id, userId: b1.id, orderId: o1 })).released,
    ).toBe(0); // idempotent
    expect(
      (await sql('SELECT sold FROM event_ticket_types WHERE id = $1', [tt.id])).rows[0].sold,
    ).toBe(0);
    expect((await w2.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going');
    expect((await b1.client.get(`/v1/events/${ev.id}/my-ticket`)).status).toBe(404);
    expect(await realGoing(ev.id)).toBe(2);
    // closed events refuse tickets
    await host.client.post(`/v1/events/${ev.id}/cancel`, {});
    const o3 = await mkOrder(b2.id, host.id);
    await expect(
      attendEventWithTicket(t.ctx, {
        eventId: ev.id,
        userId: b2.id,
        ticketTypeId: tt.id,
        orderId: o3,
      }),
    ).rejects.toMatchObject({ details: { reason: 'event_closed' } });
  });
});

describe('check-in', () => {
  it('lets only organisers check attendees in, by user id or personal code, idempotently', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const att = await signup(t);
    const wait = await signup(t);
    const stranger = await signup(t);
    const ev = await mk(host, { capacity: 1 });
    await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: co.id });
    await going(att, ev.id);
    await going(wait, ev.id);
    const url = `/v1/events/${ev.id}/check-in`;
    expect((await co.client.post(url, { userId: att.id })).status).toBe(409); // not open yet
    await startNow(ev.id);
    expect((await stranger.client.post(url, { userId: att.id })).status).toBe(403);
    expect((await att.client.post(url, { userId: att.id })).status).toBe(403);
    expect((await anon().post(url, { userId: att.id })).status).toBe(401);
    expect((await host.client.post(url, {})).status).toBe(400);
    expect((await host.client.post(url, { userId: att.id, code: 'ABCDEF' })).status).toBe(400);
    expect((await host.client.post(url, { userId: wait.id })).status).toBe(409); // on the waitlist
    expect((await host.client.post(url, { userId: stranger.id })).status).toBe(409);
    const code = (await att.client.get(`/v1/events/${ev.id}/my-ticket`)).body.code as string;
    expect((await wait.client.get(`/v1/events/${ev.id}/my-ticket`)).body.code).toBeNull();
    const first = await co.client.post(url, { code: code.toLowerCase().replace(/^(.{5})/, '$1-') });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      user: { id: att.id },
      alreadyCheckedIn: false,
      via: 'code',
    });
    expect((await host.client.post(url, { userId: att.id })).body.alreadyCheckedIn).toBe(true);
    expect((await host.client.post(url, { code: 'WRONGCODE1' })).status).toBe(404);
    const row = (
      await sql(
        'SELECT status, checked_in_at, checked_in_by FROM event_attendees WHERE event_id = $1 AND user_id = $2',
        [ev.id, att.id],
      )
    ).rows[0];
    expect(row.status).toBe('attended');
    expect(row.checked_in_by).toBe(co.id);
    expect((await counts(ev.id)).going_count).toBe(1);
    expect(await auditCount(t, 'event.check_in', ev.id)).toBe(1);
    // attended people cannot walk their RSVP back
    expect((await rsvp(att, ev.id, 'not_going')).status).toBe(409);
    // codes never work across events
    const other = await mk(host);
    await going(att, other.id);
    await startNow(other.id);
    expect((await host.client.post(`/v1/events/${other.id}/check-in`, { code })).status).toBe(404);
  });

  it('checks in purchased tickets by their ticket code exactly once', async () => {
    const host = await signup(t);
    const buyer = await signup(t);
    const ev = await mk(host);
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'GA',
        priceCents: 800,
        currency: 'USD',
        quantity: 5,
      })
    ).body;
    const order = (
      await sql(
        `INSERT INTO orders (buyer_id, seller_user_id, currency, subtotal_cents, total_cents, idempotency_key, status) VALUES ($1,$2,'USD',800,800,$3,'paid') RETURNING id`,
        [buyer.id, host.id, uniq('i')],
      )
    ).rows[0].id;
    const item = (
      await sql(
        `INSERT INTO order_items (order_id, item_type, ticket_type_id, title_snapshot, quantity, unit_price_cents) VALUES ($1,'ticket',$2,'GA',1,800) RETURNING id`,
        [order, tt.id],
      )
    ).rows[0].id;
    const code = `TKT-${uniq('c').toUpperCase()}`;
    await sql(
      `INSERT INTO tickets (ticket_type_id, event_id, order_item_id, owner_id, code) VALUES ($1,$2,$3,$4,$5)`,
      [tt.id, ev.id, item, buyer.id, code],
    );
    await attendEventWithTicket(t.ctx, {
      eventId: ev.id,
      userId: buyer.id,
      ticketTypeId: tt.id,
      orderId: order,
    });
    await startNow(ev.id);
    const r = await host.client.post(`/v1/events/${ev.id}/check-in`, { code });
    expect(r.body).toMatchObject({
      user: { id: buyer.id },
      via: 'ticket',
      alreadyCheckedIn: false,
    });
    expect((await sql('SELECT status FROM tickets WHERE code = $1', [code])).rows[0].status).toBe(
      'used',
    );
    expect(
      (await host.client.post(`/v1/events/${ev.id}/check-in`, { code })).body.alreadyCheckedIn,
    ).toBe(true);
    await sql(`UPDATE tickets SET status = 'refunded' WHERE code = $1`, [code]);
    expect((await host.client.post(`/v1/events/${ev.id}/check-in`, { code })).status).toBe(422); // refunded tickets are not valid
  });
});

describe('attendee lists honour privacy', () => {
  it('hosts see everyone; attendees see only friends; anonymous viewers see counts only', async () => {
    const host = await signup(t);
    const me = await signup(t);
    const friend = await signup(t);
    const blockedFriend = await signup(t);
    const strangerGoing = await signup(t);
    const interested = await signup(t);
    const ev = await mk(host);
    await befriend(me, friend);
    await befriend(me, blockedFriend);
    for (const u of [me, friend, blockedFriend, strangerGoing]) await going(u, ev.id);
    await rsvp(interested, ev.id, 'interested');
    const hostView = (await host.client.get(`/v1/events/${ev.id}/attendees`)).body;
    expect(hostView.scope).toBe('all');
    expect(hostView.items.map((i: any) => i.user.id).sort()).toEqual(
      [me.id, friend.id, blockedFriend.id, strangerGoing.id, interested.id].sort(),
    );
    expect(hostView.items[0]).toHaveProperty('spots');
    expect(
      (
        await host.client.get(`/v1/events/${ev.id}/attendees`, { status: 'interested' })
      ).body.items.map((i: any) => i.user.id),
    ).toEqual([interested.id]);
    const myView = (await me.client.get(`/v1/events/${ev.id}/attendees`)).body;
    expect(myView.scope).toBe('friends');
    expect(myView.counts).toMatchObject({ going: 4, interested: 1 });
    expect(myView.items.map((i: any) => i.user.id).sort()).toEqual(
      [friend.id, blockedFriend.id].sort(),
    );
    expect(myView.items[0]).not.toHaveProperty('checkedInAt', expect.any(String));
    await block(me, blockedFriend);
    expect(
      (await me.client.get(`/v1/events/${ev.id}/attendees`)).body.items.map((i: any) => i.user.id),
    ).toEqual([friend.id]);
    const anonView = await anon().get(`/v1/events/${ev.id}/attendees`);
    expect(anonView.status).toBe(200);
    expect(anonView.body).toMatchObject({ scope: 'friends', items: [], counts: { going: 4 } });
    expect((await strangerGoing.client.get(`/v1/events/${ev.id}/attendees`)).body.items).toEqual(
      [],
    );
    // keyset pagination for hosts
    const p1 = (await host.client.get(`/v1/events/${ev.id}/attendees`, { limit: '2' })).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await host.client.get(`/v1/events/${ev.id}/attendees`, { limit: '2', cursor: p1.nextCursor })
    ).body;
    expect(p2.items.map((i: any) => i.user.id)).not.toContain(p1.items[0].user.id);
    expect((await host.client.get(`/v1/events/${ev.id}/attendees`, { cursor: '!!!' })).status).toBe(
      400,
    );
  });
});

describe('co-hosts and invitations', () => {
  it('manages co-hosts (host only), refuses blocked/unknown users and lets co-hosts leave', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const co2 = await signup(t);
    const blocked = await signup(t);
    const ev = await mk(host);
    await block(host, blocked);
    expect(
      (await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: blocked.id })).status,
    ).toBe(404);
    expect(
      (
        await host.client.post(`/v1/events/${ev.id}/cohosts`, {
          userId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect(
      (await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: host.id })).status,
    ).toBe(400);
    expect((await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: co.id })).status).toBe(
      201,
    );
    expect((await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: co.id })).status).toBe(
      200,
    );
    expect(await notifCount(t, co.id, 'event_cohost_added')).toBe(1);
    expect((await co.client.post(`/v1/events/${ev.id}/cohosts`, { userId: co2.id })).status).toBe(
      403,
    );
    expect(
      (await anon().get(`/v1/events/${ev.id}/cohosts`)).body.items.map((u: any) => u.id),
    ).toEqual([co.id]);
    expect((await co.client.get(`/v1/events/${ev.id}`)).body.viewer).toMatchObject({
      isOrganiser: true,
      isManager: false,
    });
    expect((await co.client.del(`/v1/events/${ev.id}/cohosts/${host.id}`)).status).toBe(403);
    expect((await co.client.del(`/v1/events/${ev.id}/cohosts/${co.id}`)).status).toBe(204);
    expect((await co.client.patch(`/v1/events/${ev.id}`, { title: 'Not anymore' })).status).toBe(
      403,
    );
    await host.client.post(`/v1/events/${ev.id}/cohosts`, { userId: co2.id });
    expect((await host.client.del(`/v1/events/${ev.id}/cohosts/${co2.id}`)).status).toBe(204);
    expect((await host.client.del(`/v1/events/${ev.id}/cohosts/${co2.id}`)).status).toBe(404);
  });

  it('lets going attendees invite their friends to public events only; skips blocked and non-friends', async () => {
    const host = await signup(t);
    const att = await signup(t);
    const friend = await signup(t);
    const notFriend = await signup(t);
    const blockedFriend = await signup(t);
    await befriend(att, friend);
    await befriend(att, blockedFriend);
    await block(blockedFriend, att);
    const ev = await mk(host);
    expect(
      (await att.client.post(`/v1/events/${ev.id}/invitations`, { userIds: [friend.id] })).status,
    ).toBe(403); // not going yet
    await going(att, ev.id);
    const r = await att.client.post(`/v1/events/${ev.id}/invitations`, {
      userIds: [friend.id, notFriend.id, blockedFriend.id, att.id],
    });
    expect(r.status).toBe(200);
    expect(r.body.invited).toEqual([friend.id]);
    expect(r.body.skipped.sort()).toEqual([notFriend.id, blockedFriend.id, att.id].sort());
    expect(await notifCount(t, friend.id, 'event_invitation')).toBe(1);
    expect(
      (await friend.client.get('/v1/me/event-invitations')).body.items.map((e: any) => e.id),
    ).toEqual([ev.id]);
    expect(
      (await att.client.post(`/v1/events/${ev.id}/invitations`, { userIds: [friend.id] })).body
        .invited,
    ).toEqual([]); // duplicate
    // organisers may invite anyone (except blocked); the invitation opens a restricted event to the invitee
    const closed = await mk(host, { visibility: 'friends' });
    await befriend(host, att);
    await going(att, closed.id);
    expect((await notFriend.client.get(`/v1/events/${closed.id}`)).status).toBe(404);
    expect(
      (await att.client.post(`/v1/events/${closed.id}/invitations`, { userIds: [friend.id] }))
        .status,
    ).toBe(403); // attendees cannot widen the audience
    expect(
      (
        await host.client.post(`/v1/events/${closed.id}/invitations`, {
          userIds: [notFriend.id, blockedFriend.id],
        })
      ).body.invited,
    ).toEqual([notFriend.id, blockedFriend.id]);
    expect((await notFriend.client.get(`/v1/events/${closed.id}`)).status).toBe(200);
    // private events: attendees cannot invite
    const priv = await mk(host, { visibility: 'private' });
    await host.client.post(`/v1/events/${priv.id}/invitations`, { userIds: [att.id] });
    await going(att, priv.id);
    expect(
      (await att.client.post(`/v1/events/${priv.id}/invitations`, { userIds: [friend.id] })).status,
    ).toBe(403);
    expect(
      (await att.client.post(`/v1/events/${priv.id}/invitations`, { userIds: [] })).status,
    ).toBe(400);
    // responding updates the invitation
    await rsvp(notFriend, closed.id, 'not_going');
    expect(
      (
        await sql(`SELECT status FROM event_invitations WHERE event_id = $1 AND user_id = $2`, [
          closed.id,
          notFriend.id,
        ])
      ).rows[0].status,
    ).toBe('declined');
    expect(
      (
        await sql(`SELECT status FROM event_invitations WHERE event_id = $1 AND user_id = $2`, [
          priv.id,
          att.id,
        ])
      ).rows[0].status,
    ).toBe('accepted');
  });
});

describe('event discussion', () => {
  it('lets hosts and attendees post; strangers may not; posts carry event_id and honour blocks', async () => {
    const host = await signup(t);
    const att = await signup(t);
    const interested = await signup(t);
    const stranger = await signup(t);
    const blocked = await signup(t);
    const ev = await mk(host);
    await going(att, ev.id);
    await rsvp(interested, ev.id, 'interested');
    await going(blocked, ev.id);
    const p1 = await att.client.post(`/v1/events/${ev.id}/posts`, {
      body: 'Looking forward to it!',
    });
    expect(p1.status).toBe(201);
    expect(p1.body).toMatchObject({ eventId: ev.id, visibility: 'public', author: { id: att.id } });
    expect(
      (await host.client.post(`/v1/events/${ev.id}/posts`, { body: 'Doors open at 6' })).status,
    ).toBe(201);
    expect(
      (await interested.client.post(`/v1/events/${ev.id}/posts`, { body: 'Maybe!' })).status,
    ).toBe(201);
    expect((await stranger.client.post(`/v1/events/${ev.id}/posts`, { body: 'Spam' })).status).toBe(
      403,
    );
    expect((await anon().post(`/v1/events/${ev.id}/posts`, { body: 'Spam' })).status).toBe(401);
    expect((await att.client.post(`/v1/events/${ev.id}/posts`, { body: '' })).status).toBe(400);
    const bp = await blocked.client.post(`/v1/events/${ev.id}/posts`, { body: 'Hi from blocked' });
    expect(bp.status).toBe(201);
    await block(att, blocked);
    const list = await att.client.get(`/v1/events/${ev.id}/posts`);
    expect(list.body.items.map((p: any) => p.author.id).sort()).toEqual(
      [att.id, host.id, interested.id].sort(),
    );
    const anonList = await anon().get(`/v1/events/${ev.id}/posts`);
    expect(anonList.body.items).toHaveLength(4);
    expect(
      (await sql('SELECT event_id FROM posts WHERE id = $1', [p1.body.id])).rows[0].event_id,
    ).toBe(ev.id);
    expect((await stranger.client.get(`/v1/posts/${p1.body.id}`)).body.eventId).toBe(ev.id);
    const pg = await anon().get(`/v1/events/${ev.id}/posts`, { limit: '2' });
    expect(pg.body.items).toHaveLength(2);
    expect(
      (await anon().get(`/v1/events/${ev.id}/posts`, { limit: '2', cursor: pg.body.nextCursor }))
        .body.items,
    ).toHaveLength(2);
    // cancelled events close the discussion
    const dead = await mk(host);
    await host.client.post(`/v1/events/${dead.id}/cancel`, {});
    expect((await host.client.post(`/v1/events/${dead.id}/posts`, { body: 'Bye' })).status).toBe(
      409,
    );
  });

  it('scopes discussion of friends/private events to people who can see the event', async () => {
    const host = await signup(t);
    const friend = await signup(t);
    const friendOfFriend = await signup(t);
    const outsider = await signup(t);
    await befriend(host, friend);
    await befriend(friend, friendOfFriend);
    const ev = await mk(host, { visibility: 'friends' });
    await going(friend, ev.id);
    const post = await friend.client.post(`/v1/events/${ev.id}/posts`, { body: 'Secret plans' });
    expect(post.status).toBe(201);
    expect(post.body.visibility).toBe('private'); // event-scoped, never public
    expect(
      (await host.client.get(`/v1/events/${ev.id}/posts`)).body.items.map((p: any) => p.id),
    ).toEqual([post.body.id]);
    expect((await outsider.client.get(`/v1/events/${ev.id}/posts`)).status).toBe(404);
    expect((await anon().get(`/v1/events/${ev.id}/posts`)).status).toBe(404);
    // the post is not reachable through global reads by non-authors
    expect((await host.client.get(`/v1/posts/${post.body.id}`)).status).toBe(404);
    expect((await friend.client.get(`/v1/posts/${post.body.id}`)).status).toBe(200);
    // teens posting to public events are never public
    const teen = await signup(t, { birthDate: teenBirth() });
    const pub = await mk(host);
    await going(teen, pub.id);
    expect(
      (await teen.client.post(`/v1/events/${pub.id}/posts`, { body: 'Teen hello' })).body
        .visibility,
    ).toBe('friends');
  });

  it('community events use community visibility for their posts', async () => {
    const owner = await signup(t);
    const member = await signup(t);
    const outsider = await signup(t);
    const c = (await owner.client.post('/v1/communities', { name: `Disc ${uniq('c')}` })).body;
    await addMemberToCommunity(owner, c.id, member);
    const ev = (
      await owner.client.post('/v1/events', {
        title: 'Community day',
        startsAt: inDays(3),
        communityId: c.id,
        locationText: 'Park',
        publish: true,
      })
    ).body;
    await going(member, ev.id);
    const p = await member.client.post(`/v1/events/${ev.id}/posts`, { body: 'See you there' });
    expect(p.body).toMatchObject({ visibility: 'community', communityId: c.id, eventId: ev.id });
    expect((await outsider.client.get(`/v1/events/${ev.id}/posts`)).status).toBe(404);
    expect((await owner.client.get(`/v1/events/${ev.id}/posts`)).body.items).toHaveLength(1);
  });
});

describe('calendar export', () => {
  it('serves a well-formed, escaped .ics for visible events only', async () => {
    const host = await signup(t);
    const stranger = await signup(t);
    const ev = await mk(host, {
      title: 'Jazz, wine; and \\ more',
      description: 'Line one\nLine two, with; special chars ' + 'x'.repeat(200),
      locationText: '12 Main St, Springfield',
      latitude: 40.5,
      longitude: -73.25,
      endsAt: undefined,
    });
    const res = await t.app.inject({ method: 'GET', url: `/v1/events/${ev.id}/calendar.ics` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(String(res.headers['content-disposition'])).toContain('.ics');
    const body = res.body;
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body).not.toMatch(/[^\r]\n/);
    for (const line of body.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const unfolded = body.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:Jazz\\, wine\\; and \\\\ more');
    expect(unfolded).toContain('DESCRIPTION:Line one\\nLine two\\, with\\; special chars');
    expect(unfolded).toContain('LOCATION:12 Main St\\, Springfield');
    expect(unfolded).toContain('GEO:40.500000;-73.250000');
    expect(unfolded).toContain(`UID:${ev.id}@yapilapi.events`);
    expect(unfolded).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(unfolded).toContain('STATUS:CONFIRMED');
    // private events are invisible
    const priv = await mk(host, { visibility: 'private' });
    expect((await stranger.client.get(`/v1/events/${priv.id}/calendar.ics`)).status).toBe(404);
    expect((await host.client.get(`/v1/events/${priv.id}/calendar.ics`)).status).toBe(200);
    // cancelled events export as CANCELLED so calendars update
    await host.client.post(`/v1/events/${ev.id}/cancel`, {});
    expect(
      (await t.app.inject({ method: 'GET', url: `/v1/events/${ev.id}/calendar.ics` })).body,
    ).toContain('STATUS:CANCELLED');
  });

  it('never leaks the online link to people who are not going', async () => {
    const host = await signup(t);
    const att = await signup(t);
    const stranger = await signup(t);
    const ev = await mk(host, { onlineUrl: 'https://meet.example.com/secret-room' });
    await going(att, ev.id);
    expect((await stranger.client.get(`/v1/events/${ev.id}`)).body).toMatchObject({
      onlineUrl: null,
      hasOnlineUrl: true,
    });
    expect((await anon().get(`/v1/events/${ev.id}`)).body.onlineUrl).toBeNull();
    expect((await att.client.get(`/v1/events/${ev.id}`)).body.onlineUrl).toBe(
      'https://meet.example.com/secret-room',
    );
    expect((await host.client.get(`/v1/events/${ev.id}`)).body.onlineUrl).toBe(
      'https://meet.example.com/secret-room',
    );
  });
});

describe('discovery', () => {
  it('lists upcoming events in start order with keyset pagination and filters', async () => {
    const host = await signup(t);
    const community = (await host.client.post('/v1/communities', { name: `Disc ${uniq('c')}` }))
      .body;
    const tag = uniq('zz');
    const evs = [];
    for (let i = 0; i < 5; i++)
      evs.push(
        await mk(host, {
          title: `Discover ${tag} ${i}`,
          startsAt: inDays(10 + i),
          endsAt: inDays(10 + i, 1),
        }),
      );
    await mk(host, {
      title: `Discover ${tag} online`,
      startsAt: inDays(20),
      endsAt: inDays(20, 1),
      locationText: undefined,
      onlineUrl: 'https://meet.example.com/x',
      topics: ['technology'],
    });
    const paid = await mk(host, {
      title: `Discover ${tag} paid`,
      startsAt: inDays(21),
      endsAt: inDays(21, 1),
    });
    await host.client.post(`/v1/events/${paid.id}/ticket-types`, {
      name: 'P',
      priceCents: 100,
      currency: 'USD',
      quantity: 3,
    });
    const draft = (
      await host.client.post('/v1/events', {
        title: `Discover ${tag} draft`,
        startsAt: inDays(11),
        locationText: 'x',
      })
    ).body;
    const viewer = await signup(t);

    const q = { q: tag, hostId: host.id };
    const p1 = (await viewer.client.get('/v1/events', { ...q, limit: '3' })).body;
    expect(p1.items.map((e: any) => e.title)).toEqual([0, 1, 2].map((i) => `Discover ${tag} ${i}`));
    const p2 = (await viewer.client.get('/v1/events', { ...q, limit: '3', cursor: p1.nextCursor }))
      .body;
    expect(p2.items.map((e: any) => e.title)).toEqual([
      `Discover ${tag} 3`,
      `Discover ${tag} 4`,
      `Discover ${tag} online`,
    ]);
    const p3 = (await viewer.client.get('/v1/events', { ...q, limit: '3', cursor: p2.nextCursor }))
      .body;
    expect(p3.items.map((e: any) => e.title)).toEqual([`Discover ${tag} paid`]);
    expect(p3.nextCursor).toBeNull();
    const all = [...p1.items, ...p2.items, ...p3.items].map((e: any) => e.id);
    expect(all).not.toContain(draft.id);
    expect(new Set(all).size).toBe(all.length);

    expect((await anon().get('/v1/events', { ...q, online: 'true' })).body.items).toHaveLength(1);
    expect((await anon().get('/v1/events', { ...q, topic: 'technology' })).body.items).toHaveLength(
      1,
    );
    expect(
      (await anon().get('/v1/events', { ...q, free: 'false' })).body.items.map((e: any) => e.id),
    ).toEqual([paid.id]);
    expect((await anon().get('/v1/events', { ...q, free: 'true' })).body.items).toHaveLength(6);
    expect(
      (await anon().get('/v1/events', { ...q, from: inDays(12), to: inDays(14) })).body.items,
    ).toHaveLength(2);
    expect(
      (await anon().get('/v1/events', { ...q, businessId: community.id })).body.items,
    ).toHaveLength(0);
    expect((await anon().get('/v1/events', { limit: '0' })).status).toBe(400);
    expect((await anon().get('/v1/events', { when: 'never' })).status).toBe(400);
    // the host sees their own drafts only through /me/events
    expect(
      (await host.client.get('/v1/me/events', { role: 'hosting' })).body.items.map(
        (e: any) => e.id,
      ),
    ).toContain(draft.id);
  });

  it('lists past events newest first', async () => {
    const host = await signup(t);
    const a = await mk(host, { title: `Past A ${uniq('p')}` });
    const b = await mk(host, { title: `Past B ${uniq('p')}` });
    await sql(
      `UPDATE events SET starts_at = now() - interval '10 days', ends_at = now() - interval '10 days' + interval '1 hour', status = 'completed' WHERE id = $1`,
      [a.id],
    );
    await sql(
      `UPDATE events SET starts_at = now() - interval '3 days', ends_at = now() - interval '3 days' + interval '1 hour' WHERE id = $1`,
      [b.id],
    );
    const r = (await anon().get('/v1/events', { when: 'past', hostId: host.id })).body.items.map(
      (e: any) => e.id,
    );
    expect(r).toEqual([b.id, a.id]);
    expect(
      (await anon().get('/v1/events', { hostId: host.id })).body.items.map((e: any) => e.id),
    ).not.toContain(a.id);
  });

  it('finds nearby events with haversine distance, radius and keyset pagination, respecting visibility', async () => {
    const host = await signup(t);
    const stranger = await signup(t);
    const lat = -33.9 + Math.random() * 0.001; // Sydney-ish, isolated from other tests' coordinates
    const lng = 151.2;
    const at = (dLat: number, dLng: number) => ({ latitude: lat + dLat, longitude: lng + dLng });
    const near1 = await mk(host, { title: 'Near 1', ...at(0.01, 0) }); // ~1.1km
    const near2 = await mk(host, { title: 'Near 2', ...at(0, 0.05) }); // ~4.6km
    const mid = await mk(host, { title: 'Mid', ...at(0.2, 0) }); // ~22km
    const far = await mk(host, { title: 'Far', ...at(1, 1) }); // ~140km
    const hidden = await mk(host, { title: 'Hidden', visibility: 'private', ...at(0.001, 0) });
    await mk(host, { title: 'Nowhere geo', latitude: undefined, longitude: undefined });
    const q = { lat: String(lat), lng: String(lng) };
    const r = (await stranger.client.get('/v1/events/nearby', { ...q, radiusKm: '10' })).body;
    expect(r.items.map((e: any) => e.id)).toEqual([near1.id, near2.id]);
    expect(r.items[0].distanceKm).toBeGreaterThan(1);
    expect(r.items[0].distanceKm).toBeLessThan(1.3);
    expect(r.items[1].distanceKm).toBeGreaterThan(4.4);
    expect(r.items[1].distanceKm).toBeLessThan(4.9);
    const wide = (
      await stranger.client.get('/v1/events/nearby', { ...q, radiusKm: '50' })
    ).body.items.map((e: any) => e.id);
    expect(wide).toEqual([near1.id, near2.id, mid.id]);
    expect(wide).not.toContain(hidden.id);
    expect(
      (await host.client.get('/v1/events/nearby', { ...q, radiusKm: '10' })).body.items.map(
        (e: any) => e.id,
      ),
    ).toEqual([hidden.id, near1.id, near2.id]);
    const all = (await anon().get('/v1/events/nearby', { ...q, radiusKm: '500', limit: '2' })).body;
    expect(all.items.map((e: any) => e.id)).toEqual([near1.id, near2.id]);
    const more = (
      await anon().get('/v1/events/nearby', {
        ...q,
        radiusKm: '500',
        limit: '2',
        cursor: all.nextCursor,
      })
    ).body;
    expect(more.items.map((e: any) => e.id)).toEqual([mid.id, far.id]);
    expect(more.nextCursor).toBeNull();
    expect((await anon().get('/v1/events/nearby', { lat: '95', lng: '0' })).status).toBe(400);
    expect((await anon().get('/v1/events/nearby', { lat: '10' })).status).toBe(400);
    expect((await anon().get('/v1/events/nearby', { ...q, radiusKm: '9999' })).status).toBe(400);
  });

  it('finds events near the antimeridian', async () => {
    const host = await signup(t);
    const east = await mk(host, { title: 'Fiji east', latitude: -17.5, longitude: 179.95 });
    const west = await mk(host, { title: 'Fiji west', latitude: -17.5, longitude: -179.95 });
    const r = (
      await anon().get('/v1/events/nearby', { lat: '-17.5', lng: '180', radiusKm: '20' })
    ).body.items.map((e: any) => e.id);
    expect(r.sort()).toEqual([east.id, west.id].sort());
  });

  it('lists my events by role, and saved events', async () => {
    const host = await signup(t);
    const u = await signup(t);
    const [goingEv, interestedEv, waitEv, savedEv, invitedEv, pastEv] = [
      await mk(host, { capacity: 1, startsAt: inDays(4), endsAt: inDays(4, 1) }),
      await mk(host),
      await mk(host, { capacity: 1 }),
      await mk(host),
      await mk(host),
      await mk(host),
    ];
    await going(u, goingEv.id);
    await rsvp(u, interestedEv.id, 'interested');
    await going(await signup(t), waitEv.id);
    await going(u, waitEv.id);
    expect((await u.client.put(`/v1/events/${savedEv.id}/save`)).status).toBe(200);
    expect((await u.client.put(`/v1/events/${savedEv.id}/save`)).status).toBe(200);
    await host.client.post(`/v1/events/${invitedEv.id}/invitations`, { userIds: [u.id] });
    await going(u, pastEv.id);
    await sql(
      `UPDATE events SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1`,
      [pastEv.id],
    );
    const ids = async (role: string) =>
      (await u.client.get('/v1/me/events', { role })).body.items.map((e: any) => e.id);
    expect(await ids('attending')).toEqual([goingEv.id]);
    expect(await ids('interested')).toEqual([interestedEv.id]);
    expect(await ids('waitlist')).toEqual([waitEv.id]);
    expect(await ids('saved')).toEqual([savedEv.id]);
    expect(await ids('invited')).toEqual([invitedEv.id]);
    expect(await ids('past')).toEqual([pastEv.id]);
    expect(await ids('hosting')).toEqual([]);
    expect(
      (await host.client.get('/v1/me/events', { role: 'hosting', limit: '50' })).body.items.length,
    ).toBe(5);
    expect((await u.client.get(`/v1/events/${savedEv.id}`)).body.viewer.saved).toBe(true);
    expect((await u.client.del(`/v1/events/${savedEv.id}/save`)).status).toBe(204);
    expect(await ids('saved')).toEqual([]);
    expect((await anon().get('/v1/me/events')).status).toBe(401);
    expect((await u.client.get('/v1/me/events', { role: 'bogus' })).status).toBe(400);
    // saving hidden events is impossible
    const priv = await mk(host, { visibility: 'private' });
    expect((await u.client.put(`/v1/events/${priv.id}/save`)).status).toBe(404);
  });

  it('exposes share links only for events you may see', async () => {
    const host = await signup(t);
    const stranger = await signup(t);
    const ev = await mk(host);
    const s = await stranger.client.get(`/v1/events/${ev.id}/share`);
    expect(s.body.url).toContain(`/events/${ev.id}`);
    expect(s.body.calendarUrl).toContain(`/v1/events/${ev.id}/calendar.ics`);
    const priv = await mk(host, { visibility: 'private' });
    expect((await stranger.client.get(`/v1/events/${priv.id}/share`)).status).toBe(404);
    expect((await host.client.get(`/v1/events/${priv.id}/share`)).body.note).toBeTruthy();
  });
});

describe('reminders', () => {
  it('sends 24h and 1h reminders exactly once, only for eligible attendees and events', async () => {
    const host = await signup(t);
    const [going1, interested1, notGoing, waitlisted] = [
      await signup(t),
      await signup(t),
      await signup(t),
      await signup(t),
    ];
    const ev = await mk(host, { capacity: 1 });
    await going(going1, ev.id);
    await rsvp(interested1, ev.id, 'interested');
    await rsvp(notGoing, ev.id, 'going'); // waitlist (capacity 1)
    await rsvp(notGoing, ev.id, 'not_going');
    await going(waitlisted, ev.id);
    const far = await mk(host);
    await going(going1, far.id);
    const cancelled = await mk(host);
    await going(going1, cancelled.id);
    await host.client.post(`/v1/events/${cancelled.id}/cancel`, {});
    const now = new Date();
    for (const id of [ev.id, cancelled.id])
      await sql(`UPDATE events SET starts_at = $2, ends_at = $3 WHERE id = $1`, [
        id,
        new Date(now.getTime() + 20 * 3_600_000),
        new Date(now.getTime() + 22 * 3_600_000),
      ]);
    const s1 = await sendEventReminders(t.ctx, now);
    expect(s1.sent).toBeGreaterThanOrEqual(2);
    expect(await notifCount(t, going1.id, 'event_reminder')).toBe(1); // only the eligible event
    expect(await notifCount(t, interested1.id, 'event_reminder')).toBe(1);
    expect(await notifCount(t, notGoing.id, 'event_reminder')).toBe(0);
    expect(await notifCount(t, waitlisted.id, 'event_reminder')).toBe(0);
    const n = (
      await sql(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'event_reminder'`, [
        going1.id,
      ])
    ).rows[0].data;
    expect(n).toMatchObject({ title: ev.title, window: '24h' });
    // idempotent
    const s2 = await sendEventReminders(t.ctx, now);
    expect(s2.sent).toBe(0);
    expect(await notifCount(t, going1.id, 'event_reminder')).toBe(1);
    // concurrent workers never double-send
    const later = new Date(now.getTime() + 19.5 * 3_600_000);
    const [w1, w2] = await Promise.all([
      sendEventReminders(t.ctx, later),
      sendEventReminders(t.ctx, later),
    ]);
    expect(w1.sent + w2.sent).toBe(1); // going1 gets the 1h reminder once; interested users only get the 24h one
    expect(await notifCount(t, going1.id, 'event_reminder')).toBe(2);
    expect(await notifCount(t, interested1.id, 'event_reminder')).toBe(1);
    expect(
      (await sql(`SELECT count(*)::int AS n FROM event_reminders WHERE event_id = $1`, [ev.id]))
        .rows[0].n,
    ).toBe(3);
  });

  it('honours notification preferences', async () => {
    const host = await signup(t);
    const quiet = await signup(t);
    const loud = await signup(t);
    const ev = await mk(host);
    await going(quiet, ev.id);
    await going(loud, ev.id);
    await sql(
      `INSERT INTO notification_preferences (user_id, kind, channel, enabled) VALUES ($1,'event_reminder','in_app',false)`,
      [quiet.id],
    );
    await sql(
      `UPDATE events SET starts_at = now() + interval '30 minutes', ends_at = now() + interval '2 hours' WHERE id = $1`,
      [ev.id],
    );
    await sendEventReminders(t.ctx);
    expect(await notifCount(t, quiet.id, 'event_reminder')).toBe(0);
    const l = (
      await sql(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'event_reminder'`, [
        loud.id,
      ])
    ).rows;
    expect(l).toHaveLength(1);
    expect(l[0].data.window).toBe('1h');
  });
});

describe('memory hooks', () => {
  it('lists attended events and shared friends only for people who attended', async () => {
    const host = await signup(t);
    const me = await signup(t);
    const friend = await signup(t);
    const friendSkipped = await signup(t);
    const stranger = await signup(t);
    const blockedFriend = await signup(t);
    await befriend(me, friend);
    await befriend(me, friendSkipped);
    await befriend(me, blockedFriend);
    const ev = await mk(host);
    await going(me, ev.id);
    await going(friend, ev.id);
    await going(stranger, ev.id);
    await going(blockedFriend, ev.id);
    await rsvp(friendSkipped, ev.id, 'interested');
    // before completion nobody has standing
    expect(await listEventAttendeesForMemory(t.ctx, { eventId: ev.id, userId: me.id })).toBeNull();
    await startNow(ev.id);
    await host.client.post(`/v1/events/${ev.id}/check-in`, { userId: me.id });
    await block(blockedFriend, me);
    const r = await listEventAttendeesForMemory(t.ctx, { eventId: ev.id, userId: me.id });
    expect(r?.event.id).toBe(ev.id);
    expect(r?.attendees.map((a) => a.userId)).toEqual([friend.id]); // not strangers, not interested-only, not blocked
    expect(
      await listEventAttendeesForMemory(t.ctx, { eventId: ev.id, userId: friendSkipped.id }),
    ).toBeNull();
    // a going-only attendee gains standing when the event completes
    await host.client.post(`/v1/events/${ev.id}/complete`);
    expect(
      (
        await listEventAttendeesForMemory(t.ctx, { eventId: ev.id, userId: friend.id })
      )?.attendees.map((a) => a.userId),
    ).toEqual([me.id]);
    const mine = await listAttendedEventsForMemory(t.ctx, me.id);
    expect(mine.map((e) => e.id)).toEqual([ev.id]);
    expect(await listAttendedEventsForMemory(t.ctx, friendSkipped.id)).toEqual([]);
    expect(
      await listAttendedEventsForMemory(t.ctx, me.id, {
        until: new Date(Date.now() - 30 * 86_400_000),
      }),
    ).toEqual([]);
  });
});

describe('account deletion hook', () => {
  const runHooks = (userId: string) =>
    withTransaction(t.ctx.db, async (tx) => {
      for (const h of getDeletionHooks()) await h(t.ctx, tx, userId);
    });

  it('removes attendance, returns tickets and promotes the waitlist', async () => {
    const host = await signup(t);
    const leaver = await signup(t);
    const waiter = await signup(t);
    const ev = await mk(host, { capacity: 5 });
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'Free',
        priceCents: 0,
        quantity: 1,
      })
    ).body;
    await going(leaver, ev.id, { ticketTypeId: tt.id });
    await going(waiter, ev.id, { ticketTypeId: tt.id });
    await leaver.client.put(`/v1/events/${(await mk(host)).id}/rsvp`, { status: 'interested' });
    await runHooks(leaver.id);
    expect(
      (await sql('SELECT 1 FROM event_attendees WHERE user_id = $1', [leaver.id])).rowCount,
    ).toBe(0);
    expect((await waiter.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going');
    expect(
      (await sql('SELECT sold FROM event_ticket_types WHERE id = $1', [tt.id])).rows[0].sold,
    ).toBe(1);
    expect((await counts(ev.id)).going_count).toBe(1);
    expect(await notifCount(t, waiter.id, 'event_waitlist_promoted')).toBe(1);
  });

  it('hands hosted events to a co-host, or cancels them when nobody can take over', async () => {
    const host = await signup(t);
    const co = await signup(t);
    const att = await signup(t);
    const handed = await mk(host);
    await host.client.post(`/v1/events/${handed.id}/cohosts`, { userId: co.id });
    const orphan = await mk(host);
    await going(att, orphan.id);
    const past = await mk(host);
    await sql(
      `UPDATE events SET status = 'completed', starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1`,
      [past.id],
    );
    await runHooks(host.id);
    const h = (await sql('SELECT host_id, status FROM events WHERE id = $1', [handed.id])).rows[0];
    expect(h).toEqual({ host_id: co.id, status: 'published' });
    expect(
      (await sql('SELECT 1 FROM event_organizers WHERE event_id = $1', [handed.id])).rowCount,
    ).toBe(0);
    const o = (
      await sql('SELECT host_id, status, cancel_reason FROM events WHERE id = $1', [orphan.id])
    ).rows[0];
    expect(o).toMatchObject({ host_id: null, status: 'cancelled' });
    expect(await notifCount(t, att.id, 'event_cancelled')).toBe(1);
    expect(
      (await sql('SELECT host_id, status FROM events WHERE id = $1', [past.id])).rows[0],
    ).toEqual({ host_id: null, status: 'completed' });
    // the account row can now be deleted without the host FK blocking it
    await sql('DELETE FROM users WHERE id = $1', [host.id]);
    expect((await anon().get(`/v1/events/${orphan.id}`)).body.status).toBe('cancelled');
  });
});
