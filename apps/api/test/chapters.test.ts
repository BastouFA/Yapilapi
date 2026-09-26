import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { openDueChapters } from '../src/modules/chapters.ts';

const ADULT = '1990-01-01';
const TEEN = `${new Date().getUTCFullYear() - 15}-01-01`;

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: ADULT });

async function photo(owner: TestUser) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status) VALUES ($1,'image','http://localhost:4000/media/story.jpg','image/jpeg','ready') RETURNING id`,
    [owner.id],
  );
  return rows[0].id as string;
}

/** A 24-hour story; `expired` moves it into the archive. */
async function story(owner: TestUser, opts: { body?: string; withPhoto?: boolean; expired?: boolean } = {}) {
  const mediaId = opts.withPhoto ? await photo(owner) : undefined;
  const r = await as(t.app, owner).post('/v1/moments', { body: opts.body ?? 'A story', mediaId, expiresIn: '24h', visibility: 'followers' });
  expect(r.status).toBe(201);
  const id = r.body.moment.id as string;
  if (opts.expired) await t.ctx.db.query(`UPDATE moments SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  return id;
}

async function mutual(a: TestUser, b: TestUser) {
  await as(t.app, a).post(`/v1/users/${b.id}/follow`);
  await as(t.app, b).post(`/v1/users/${a.id}/follow`);
}

async function chapter(owner: TestUser, body: Record<string, unknown>) {
  const r = await as(t.app, owner).post('/v1/chapters', body);
  expect(r.status).toBe(201);
  return r.body.chapter as { id: string; [k: string]: any };
}

const inFuture = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('story archive', () => {
  it('keeps expired stories with their media, only for their author', async () => {
    const author = await adult();
    const follower = await adult();
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);
    const old = await story(author, { body: 'Beach day', withPhoto: true, expired: true });
    const live = await story(author, { body: 'Still up' });

    const archive = await as(t.app, author).get('/v1/me/archive');
    expect(archive.status).toBe(200);
    const ids = archive.body.items.map((s: any) => s.id);
    expect(ids).toContain(old);
    expect(ids).not.toContain(live);
    const item = archive.body.items.find((s: any) => s.id === old);
    expect(item.mediaUrl).toMatch(/story\.jpg$/);
    expect(item.chapters).toEqual([]);

    const month = new Date().toISOString().slice(0, 7);
    const months = await as(t.app, author).get('/v1/me/archive/months');
    expect(months.body.items).toContainEqual({ month, count: 1 });
    expect((await as(t.app, author).get(`/v1/me/archive?month=${month}`)).body.items.map((s: any) => s.id)).toEqual([old]);
    expect((await as(t.app, author).get('/v1/me/archive?month=2001-01')).body.items).toEqual([]);
    expect((await as(t.app, author).get('/v1/me/archive?month=nope')).status).toBe(400);

    // Nobody else reaches it: not their archive, not the stories strip, not their own chapters.
    expect((await as(t.app, follower).get('/v1/me/archive')).body.items.map((s: any) => s.id)).not.toContain(old);
    const strip = await as(t.app, follower).get('/v1/moments');
    expect(strip.body.items.flatMap((g: any) => g.moments.map((m: any) => m.id))).not.toContain(old);
    const theirs = await chapter(follower, { title: 'Borrowed' });
    expect((await as(t.app, follower).post(`/v1/chapters/${theirs.id}/stories`, { momentId: old })).status).toBe(404);
    expect((await as(t.app, follower).post('/v1/chapters', { title: 'Sneaky', momentIds: [old] })).status).toBe(404);
    expect((await as(t.app, follower).del(`/v1/me/archive/${old}`)).status).toBe(404);
    expect((await as(t.app, null).get('/v1/me/archive')).status).toBe(401);

    // The author can delete it.
    expect((await as(t.app, author).del(`/v1/me/archive/${old}`)).status).toBe(200);
    expect((await as(t.app, author).get('/v1/me/archive')).body.items).toEqual([]);
  });
});

describe('chapter audience', () => {
  it('shows each chapter only to its audience, respecting blocks', async () => {
    const owner = await adult();
    const follower = await adult();
    const friend = await adult();
    const close = await adult();
    const stranger = await adult();
    const blocked = await adult();
    await as(t.app, follower).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, close).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, blocked).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, friend).post(`/v1/users/${owner.id}/friend-request`);
    await as(t.app, owner).post(`/v1/users/${friend.id}/friend-request`);
    expect((await as(t.app, owner).put(`/v1/me/close-friends/${close.id}`)).status).toBe(200);

    const s = await story(owner, { body: 'Summer', expired: true });
    const made: Record<string, string> = {};
    for (const audience of ['public', 'followers', 'friends', 'close_friends', 'only_me'])
      made[audience] = (await chapter(owner, { title: `For ${audience}`, audience, momentIds: [s] })).id;

    const expected: [TestUser | null, string[]][] = [
      [owner, ['public', 'followers', 'friends', 'close_friends', 'only_me']],
      [follower, ['public', 'followers']],
      [friend, ['public', 'followers', 'friends']],
      [close, ['public', 'followers', 'close_friends']],
      [stranger, ['public']],
      [null, ['public']],
    ];
    for (const [viewer, sees] of expected) {
      const list = await as(t.app, viewer).get(`/v1/users/${owner.id}/chapters`);
      expect(list.status).toBe(200);
      const titles = list.body.items.map((c: any) => c.title).sort();
      expect(titles).toEqual(sees.map((a) => `For ${a}`).sort());
      for (const [audience, id] of Object.entries(made)) {
        const one = await as(t.app, viewer).get(`/v1/chapters/${id}`);
        expect(one.status).toBe(sees.includes(audience) ? 200 : 404);
        if (one.status === 200) expect(one.body.stories.map((x: any) => x.id)).toEqual([s]);
      }
    }

    // A block either way hides every chapter, even public ones.
    await as(t.app, owner).post(`/v1/users/${blocked.id}/block`);
    expect((await as(t.app, blocked).get(`/v1/chapters/${made.public}`)).status).toBe(404);
    expect((await as(t.app, blocked).get(`/v1/users/${owner.id}/chapters`)).status).toBe(404);

    // A private account's public chapter is for its followers.
    await as(t.app, owner).patch('/v1/me/profile', { isPrivate: true });
    expect((await as(t.app, stranger).get(`/v1/chapters/${made.public}`)).status).toBe(404);
    expect((await as(t.app, follower).get(`/v1/chapters/${made.public}`)).status).toBe(200);
  });

  it("keeps under-18 accounts' chapters off public", async () => {
    const teen = await signUp(t.app, { birthDate: TEEN });
    const follower = await signUp(t.app, { birthDate: TEEN });
    const stranger = await adult();
    await as(t.app, follower).post(`/v1/users/${teen.id}/follow`);
    expect((await as(t.app, teen).post('/v1/chapters', { title: 'Everyone', audience: 'public' })).status).toBe(403);
    const c = await chapter(teen, { title: 'Class trip', audience: 'followers' });
    expect((await as(t.app, teen).patch(`/v1/chapters/${c.id}`, { audience: 'public' })).status).toBe(403);
    for (const audience of ['friends', 'close_friends', 'only_me', 'followers'])
      expect((await as(t.app, teen).patch(`/v1/chapters/${c.id}`, { audience })).status).toBe(200);
    expect((await as(t.app, follower).get(`/v1/chapters/${c.id}`)).status).toBe(200);
    expect((await as(t.app, stranger).get(`/v1/chapters/${c.id}`)).status).toBe(404);
    // Even a public chapter written straight to the database reads as followers only.
    await t.ctx.db.query(`UPDATE chapters SET audience = 'public' WHERE id = $1`, [c.id]);
    expect((await as(t.app, stranger).get(`/v1/chapters/${c.id}`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/chapters/${c.id}`)).status).toBe(404);
  });

  it('validates title, cover and text', async () => {
    const owner = await adult();
    expect((await as(t.app, owner).post('/v1/chapters', { title: 'x'.repeat(41) })).status).toBe(400);
    expect((await as(t.app, owner).post('/v1/chapters', { title: 'Buy followers cheap', description: 'buy followers' })).status).toBe(422);
    expect((await as(t.app, owner).post('/v1/chapters', { title: 'Ok', coverGradient: 'neon' })).status).toBe(400);
    const s = await story(owner, { withPhoto: true, expired: true });
    const other = await story(owner, { expired: true });
    const c = await chapter(owner, { title: 'Lagos', coverGradient: 'lagoon', coverSymbol: 'globe', momentIds: [s] });
    expect(c.cover).toEqual({ kind: 'gradient', gradient: 'lagoon', symbol: 'globe' });
    expect((await as(t.app, owner).patch(`/v1/chapters/${c.id}`, { coverStoryId: other })).status).toBe(400);
    const withCover = await as(t.app, owner).patch(`/v1/chapters/${c.id}`, { coverStoryId: s });
    expect(withCover.body.chapter.cover).toMatchObject({ kind: 'story', mediaUrl: expect.stringMatching(/story\.jpg$/) });
  });
});

describe('time capsules', () => {
  it('returns no stories before the date, then opens and tells the owner and contributors', async () => {
    const owner = await adult();
    const friend = await adult();
    const viewer = await adult();
    await mutual(owner, friend);
    await as(t.app, viewer).post(`/v1/users/${owner.id}/follow`);

    const mine = await story(owner, { body: 'Graduation', withPhoto: true, expired: true });
    expect((await as(t.app, owner).post('/v1/chapters', { title: 'Too soon', opensAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(400);
    const c = await chapter(owner, { title: 'Class of 2026', audience: 'followers', opensAt: inFuture(365), momentIds: [mine] });
    await as(t.app, owner).patch(`/v1/chapters/${c.id}`, { coverStoryId: mine });
    await as(t.app, owner).post(`/v1/chapters/${c.id}/contributors`, { userId: friend.id });
    await as(t.app, friend).post(`/v1/chapters/${c.id}/join`);
    const theirs = await story(friend, { body: 'Last day', withPhoto: true, expired: true });
    expect((await as(t.app, friend).post(`/v1/chapters/${c.id}/stories`, { momentId: theirs })).status).toBe(201);

    // Viewers: the sealed cover, the date and the count, nothing else.
    const sealed = await as(t.app, viewer).get(`/v1/chapters/${c.id}`);
    expect(sealed.status).toBe(200);
    expect(sealed.body.stories).toEqual([]);
    expect(sealed.body.chapter.storyCount).toBe(2);
    expect(sealed.body.chapter.capsule).toMatchObject({ open: false, sealed: false });
    expect(sealed.body.chapter.cover.kind).toBe('gradient');
    expect(JSON.stringify(sealed.body)).not.toMatch(/story\.jpg|Graduation|Last day/);
    const onProfile = await as(t.app, viewer).get(`/v1/users/${owner.id}/chapters`);
    expect(JSON.stringify(onProfile.body)).not.toMatch(/story\.jpg|Graduation|Last day/);
    // The owner and each contributor get only their own stories back.
    expect((await as(t.app, owner).get(`/v1/chapters/${c.id}`)).body.stories.map((s: any) => s.id)).toEqual([mine]);
    expect((await as(t.app, friend).get(`/v1/chapters/${c.id}`)).body.stories.map((s: any) => s.id)).toEqual([theirs]);
    // No guestbook while sealed.
    expect((await as(t.app, viewer).post(`/v1/chapters/${c.id}/guestbook`, { body: 'Cannot wait' })).status).toBe(400);
    expect((await as(t.app, viewer).get(`/v1/chapters/${c.id}/guestbook`)).body).toEqual({ items: [], open: false });

    // Sealing closes adding and fixes the date.
    expect((await as(t.app, friend).post(`/v1/chapters/${c.id}/seal`)).status).toBe(403);
    const sealing = await as(t.app, owner).post(`/v1/chapters/${c.id}/seal`);
    expect(sealing.status).toBe(200);
    expect(sealing.body.chapter).toMatchObject({ canAdd: false, capsule: { sealed: true, open: false } });
    const late = await story(friend, { expired: true });
    expect((await as(t.app, friend).post(`/v1/chapters/${c.id}/stories`, { momentId: late })).status).toBe(400);
    expect((await as(t.app, owner).patch(`/v1/chapters/${c.id}`, { opensAt: inFuture(2) })).status).toBe(400);
    expect(await openDueChapters(t.ctx.db, t.ctx.realtime)).toBe(0);

    // The date comes (moved into the past in the database).
    await t.ctx.db.query(`UPDATE chapters SET opens_at = now() - interval '1 second' WHERE id = $1`, [c.id]);
    const open = await as(t.app, viewer).get(`/v1/chapters/${c.id}`);
    expect(open.body.chapter.capsule).toMatchObject({ open: true });
    expect(open.body.chapter.cover).toMatchObject({ kind: 'story', mediaUrl: expect.stringMatching(/story\.jpg$/) });
    expect(open.body.stories.map((s: any) => [s.id, s.author.id])).toEqual([
      [mine, owner.id],
      [theirs, friend.id],
    ]);
    expect(open.body.stories[0].mediaUrl).toMatch(/story\.jpg$/);

    expect(await openDueChapters(t.ctx.db, t.ctx.realtime)).toBeGreaterThanOrEqual(1);
    expect(await openDueChapters(t.ctx.db, t.ctx.realtime)).toBe(0);
    for (const who of [owner, friend]) {
      const n = await as(t.app, who).get('/v1/notifications');
      expect(n.body.items.filter((x: any) => x.type === 'chapter_opened' && x.entityId === c.id)).toHaveLength(1);
    }
    const viewerN = await as(t.app, viewer).get('/v1/notifications');
    expect(viewerN.body.items.some((x: any) => x.type === 'chapter_opened')).toBe(false);
  });
});

describe('shared chapters', () => {
  it('lets invited mutual follows add their own stories, and the owner manage them', async () => {
    const owner = await adult();
    const pal = await adult();
    const oneWay = await adult();
    const viewer = await adult();
    await mutual(owner, pal);
    await as(t.app, oneWay).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, viewer).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, viewer).post(`/v1/users/${pal.id}/follow`);

    const ownerStory = await story(owner, { body: 'Road trip day 1', expired: true });
    const c = await chapter(owner, { title: 'Road trip', audience: 'followers', momentIds: [ownerStory] });

    // Only mutual follows, only by the owner.
    expect((await as(t.app, owner).post(`/v1/chapters/${c.id}/contributors`, { userId: oneWay.id })).status).toBe(400);
    expect((await as(t.app, owner).post(`/v1/chapters/${c.id}/contributors`, { userId: owner.id })).status).toBe(400);
    expect((await as(t.app, viewer).post(`/v1/chapters/${c.id}/contributors`, { userId: pal.id })).status).toBe(403);
    expect((await as(t.app, owner).post(`/v1/chapters/${c.id}/contributors`, { userId: pal.id })).status).toBe(201);
    const invite = (await as(t.app, pal).get('/v1/notifications')).body.items.find((x: any) => x.type === 'chapter_invite');
    expect(invite).toMatchObject({ entityId: c.id, actor: { id: owner.id } });

    // Invited isn't a contributor yet.
    const palStory = await story(pal, { body: 'Day 2 from the back seat', expired: true });
    expect((await as(t.app, pal).get('/v1/me/chapters')).body.items.find((x: any) => x.id === c.id)).toMatchObject({ role: 'invited', canAdd: false });
    expect((await as(t.app, pal).post(`/v1/chapters/${c.id}/stories`, { momentId: palStory })).status).toBe(403);
    expect((await as(t.app, pal).post(`/v1/chapters/${c.id}/join`)).status).toBe(200);
    expect((await as(t.app, pal).post(`/v1/chapters/${c.id}/stories`, { momentId: palStory })).status).toBe(201);
    // Only your own stories, and you can't run the chapter.
    expect((await as(t.app, pal).post(`/v1/chapters/${c.id}/stories`, { momentId: ownerStory })).status).toBe(404);
    expect((await as(t.app, viewer).post(`/v1/chapters/${c.id}/stories`, { momentId: palStory })).status).toBe(403);
    expect((await as(t.app, pal).patch(`/v1/chapters/${c.id}`, { title: 'Mine now' })).status).toBe(403);
    expect((await as(t.app, pal).del(`/v1/chapters/${c.id}/stories/${ownerStory}`)).status).toBe(404);
    expect((await as(t.app, pal).del(`/v1/chapters/${c.id}`)).status).toBe(404);

    // Each story is credited to its author.
    const view = await as(t.app, viewer).get(`/v1/chapters/${c.id}`);
    expect(view.body.stories.map((s: any) => s.author.id)).toEqual([owner.id, pal.id]);
    expect(view.body.contributors.map((m: any) => m.user.id)).toEqual([pal.id]);
    expect(view.body.chapter.shared).toBe(true);

    // On the contributor's profile only if they choose.
    expect((await as(t.app, viewer).get(`/v1/users/${pal.id}/chapters`)).body.items).toEqual([]);
    expect((await as(t.app, pal).patch(`/v1/chapters/${c.id}/membership`, { showOnProfile: true })).status).toBe(200);
    expect((await as(t.app, viewer).get(`/v1/users/${pal.id}/chapters`)).body.items.map((x: any) => x.id)).toEqual([c.id]);
    // It still follows the owner's audience there.
    const palFan = await adult();
    await as(t.app, palFan).post(`/v1/users/${pal.id}/follow`);
    expect((await as(t.app, palFan).get(`/v1/users/${pal.id}/chapters`)).body.items).toEqual([]);

    // Contributors' own blocks hide their stories from the people they blocked.
    await as(t.app, pal).post(`/v1/users/${viewer.id}/block`);
    expect((await as(t.app, viewer).get(`/v1/chapters/${c.id}`)).body.stories.map((s: any) => s.author.id)).toEqual([owner.id]);
    await as(t.app, pal).del(`/v1/users/${viewer.id}/block`);

    // The owner can remove any story, and any contributor (their stories go with them).
    const second = await story(pal, { expired: true });
    await as(t.app, pal).post(`/v1/chapters/${c.id}/stories`, { momentId: second });
    expect((await as(t.app, owner).del(`/v1/chapters/${c.id}/stories/${palStory}`)).status).toBe(200);
    expect((await as(t.app, owner).get(`/v1/chapters/${c.id}`)).body.stories.map((s: any) => s.id)).toEqual([ownerStory, second]);
    expect((await as(t.app, owner).del(`/v1/chapters/${c.id}/contributors/${pal.id}`)).status).toBe(200);
    const after = await as(t.app, owner).get(`/v1/chapters/${c.id}`);
    expect(after.body.stories.map((s: any) => s.id)).toEqual([ownerStory]);
    expect(after.body.contributors).toEqual([]);
    // Still a follower, so still sees it, but can't add any more.
    expect((await as(t.app, pal).post(`/v1/chapters/${c.id}/stories`, { momentId: second })).status).toBe(403);
  });
});

describe('chapter guestbook', () => {
  it('takes one moderated line per viewer, and the owner can hide lines', async () => {
    const owner = await adult();
    const a = await adult();
    const b = await adult();
    for (const u of [a, b]) await as(t.app, u).post(`/v1/users/${owner.id}/follow`);
    const c = await chapter(owner, { title: 'Wedding', audience: 'followers', momentIds: [await story(owner, { expired: true })] });

    expect((await as(t.app, a).post(`/v1/chapters/${c.id}/guestbook`, { body: 'x'.repeat(141) })).status).toBe(400);
    expect((await as(t.app, a).post(`/v1/chapters/${c.id}/guestbook`, { body: '   ' })).status).toBe(400);
    expect((await as(t.app, a).post(`/v1/chapters/${c.id}/guestbook`, { body: 'Free crypto, click this link to claim' })).status).toBe(422);
    const line = await as(t.app, a).post(`/v1/chapters/${c.id}/guestbook`, { body: 'What a day. Congratulations to you both.' });
    expect(line.status).toBe(201);
    expect(line.body.entry.pending).toBe(false);
    // Writing again replaces your line.
    await as(t.app, a).post(`/v1/chapters/${c.id}/guestbook`, { body: 'Congratulations to you both.' });

    // Borderline lines wait for review and show only to their writer.
    const held = await as(t.app, b).post(`/v1/chapters/${c.id}/guestbook`, { body: 'You stupid lucky pair' });
    expect(held.status).toBe(201);
    expect(held.body.entry.pending).toBe(true);
    const seenByB = await as(t.app, b).get(`/v1/chapters/${c.id}/guestbook`);
    expect(seenByB.body.items.map((x: any) => x.body).sort()).toEqual(['Congratulations to you both.', 'You stupid lucky pair']);
    for (const who of [owner, a]) {
      const gb = await as(t.app, who).get(`/v1/chapters/${c.id}/guestbook`);
      expect(gb.body.items.map((x: any) => x.body)).toEqual(['Congratulations to you both.']);
    }

    // The owner hides a line: gone for others, marked hidden for the owner.
    const entry = (await as(t.app, owner).get(`/v1/chapters/${c.id}/guestbook`)).body.items[0];
    expect((await as(t.app, a).put(`/v1/chapters/${c.id}/guestbook/${entry.id}/hidden`, { hidden: true })).status).toBe(403);
    expect((await as(t.app, owner).put(`/v1/chapters/${c.id}/guestbook/${entry.id}/hidden`, { hidden: true })).status).toBe(200);
    expect((await as(t.app, b).get(`/v1/chapters/${c.id}/guestbook`)).body.items.map((x: any) => x.body)).toEqual(['You stupid lucky pair']);
    expect((await as(t.app, owner).get(`/v1/chapters/${c.id}/guestbook`)).body.items).toMatchObject([{ id: entry.id, hidden: true }]);
    await as(t.app, owner).put(`/v1/chapters/${c.id}/guestbook/${entry.id}/hidden`, { hidden: false });
    expect((await as(t.app, b).get(`/v1/chapters/${c.id}/guestbook`)).body.items).toHaveLength(2);

    // People outside the audience can't read or write it.
    const stranger = await adult();
    expect((await as(t.app, stranger).get(`/v1/chapters/${c.id}/guestbook`)).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/chapters/${c.id}/guestbook`, { body: 'Hello' })).status).toBe(404);
    // Writers can delete their own line.
    expect((await as(t.app, a).del(`/v1/chapters/${c.id}/guestbook/${entry.id}`)).status).toBe(200);
  });
});
