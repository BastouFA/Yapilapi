import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { sendCountdownReminders } from '../src/lib/stories.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const follow = (who: TestUser, whom: TestUser) => as(t.app, who).post(`/v1/users/${whom.id}/follow`);
const story = async (author: TestUser, body: Record<string, unknown>) => {
  const r = await as(t.app, author).post('/v1/moments', body);
  if (r.status !== 201) throw new Error(`story failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.moment as { id: string; tags: string[] };
};
const open = async (viewer: TestUser, id: string) => (await as(t.app, viewer).get(`/v1/moments/${id}`)).body.group?.moments[0];
const notifications = async (user: TestUser, type: string) =>
  (await t.ctx.db.query(`SELECT actor_id, entity_type, entity_id, data FROM notifications WHERE user_id = $1 AND type = $2`, [user.id, type])).rows;
const at = { x: 0.5, y: 0.5 };

describe('sharing a story to a chat', () => {
  it('shows a story card that only opens for people who can see the story', async () => {
    const author = await adult();
    const fan = await adult();
    const stranger = await adult();
    await follow(fan, author);
    const s = await story(author, { body: 'Followers only', visibility: 'followers' });

    const sent = await as(t.app, fan).post(`/v1/moments/${s.id}/send`, { userIds: [stranger.id], body: 'Look' });
    expect(sent.status).toBe(201);
    const [conversationId] = sent.body.conversationIds;

    // The sender can see it: the card opens, credited to the author.
    const mine = (await as(t.app, fan).get(`/v1/conversations/${conversationId}/messages`)).body.items.at(-1);
    expect(mine.story).toMatchObject({ id: s.id, available: true, body: 'Followers only', author: { id: author.id } });

    // The recipient can't: nothing about the story comes through.
    const theirs = (await as(t.app, stranger).get(`/v1/conversations/${conversationId}/messages`)).body.items.at(-1);
    expect(theirs.body).toBe('Look');
    expect(theirs.story).toEqual({ id: s.id, available: false });
    expect((await as(t.app, stranger).get(`/v1/moments/${s.id}`)).status).toBe(404);
    const inbox = (await as(t.app, stranger).get('/v1/conversations')).body.items.find((c: any) => c.id === conversationId);
    expect(inbox.lastMessage.story).toEqual({ id: s.id, available: false });

    // You can't share a story you can't see, directly or through a message.
    expect((await as(t.app, stranger).post(`/v1/moments/${s.id}/send`, { userIds: [fan.id] })).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/conversations/${conversationId}/messages`, { storyId: s.id })).status).toBe(404);

    // Once the recipient follows the author, the same card opens for them.
    await follow(stranger, author);
    const later = (await as(t.app, stranger).get(`/v1/conversations/${conversationId}/messages`)).body.items.at(-1);
    expect(later.story).toMatchObject({ id: s.id, available: true });

    // Deleted stories stop opening for everyone.
    await as(t.app, author).del(`/v1/moments/${s.id}`);
    const gone = (await as(t.app, fan).get(`/v1/conversations/${conversationId}/messages`)).body.items.at(-1);
    expect(gone.story).toEqual({ id: s.id, available: false });
  });

  it('keeps close friends stories closed to people who are not on the list', async () => {
    const author = await adult();
    const close = await adult();
    const other = await adult();
    await follow(close, author);
    await follow(other, author);
    await as(t.app, author).put(`/v1/me/close-friends/${close.id}`);
    const s = await story(author, { body: 'Just us', visibility: 'close_friends' });
    const sent = await as(t.app, close).post(`/v1/moments/${s.id}/send`, { userIds: [other.id] });
    expect(sent.status).toBe(201);
    const msg = (await as(t.app, other).get(`/v1/conversations/${sent.body.conversationIds[0]}/messages`)).body.items.at(-1);
    expect(msg.story).toEqual({ id: s.id, available: false });
  });
});

describe('resharing', () => {
  it('allows public stories and stories you are mentioned in, and the author can turn it off', async () => {
    const author = await adult();
    const sharer = await adult();
    const sharerFan = await adult();
    await follow(sharer, author);
    await follow(sharerFan, sharer);

    const followersOnly = await story(author, { body: 'Not for resharing', visibility: 'followers' });
    expect((await open(sharer, followersOnly.id)).canReshare).toBe(false);
    const denied = await as(t.app, sharer).post(`/v1/moments/${followersOnly.id}/reshare`, {});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('reshare_not_allowed');

    const pub = await story(author, { body: 'Share me', visibility: 'public' });
    expect((await as(t.app, author).post(`/v1/moments/${pub.id}/reshare`, {})).status).toBe(400); // your own
    expect((await open(sharer, pub.id)).canReshare).toBe(true);
    const r = await as(t.app, sharer).post(`/v1/moments/${pub.id}/reshare`, { body: 'Look at this', visibility: 'followers' });
    expect(r.status).toBe(201);

    // The reshare shows the original as a card credited to its author, for the sharer's followers too.
    const group = (await as(t.app, sharerFan).get('/v1/moments')).body.items.find((g: any) => g.author.id === sharer.id);
    expect(group.moments[0].reshareOf).toMatchObject({ id: pub.id, available: true, author: { id: author.id } });
    expect(group.moments[0].canReshare).toBe(false); // a reshare isn't reshared again
    expect(await notifications(author, 'story_reshare')).toEqual([expect.objectContaining({ actor_id: sharer.id, entity_type: 'moment', entity_id: pub.id })]);
    expect((await as(t.app, author).get(`/v1/moments/${pub.id}/viewers`)).body.reshares).toBe(1);

    // Only the author can turn resharing off, and then nobody can reshare it.
    expect((await as(t.app, sharer).patch(`/v1/moments/${pub.id}`, { allowReshare: false })).status).toBe(404);
    expect((await as(t.app, author).patch(`/v1/moments/${pub.id}`, { allowReshare: false })).body).toEqual({ allowReshare: false });
    const off = await as(t.app, sharerFan).post(`/v1/moments/${pub.id}/reshare`, {});
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('reshare_off');
    expect((await open(sharerFan, pub.id)).canReshare).toBe(false);
  });

  it('lets people mentioned in a story add it to theirs, with the card closed to people who cannot see the original', async () => {
    const author = await adult();
    const friend = await adult();
    const friendFan = await adult();
    await follow(friend, author);
    await follow(friendFan, friend);
    await as(t.app, author).put(`/v1/me/close-friends/${friend.id}`);
    const s = await story(author, { body: `With @${friend.username}`, visibility: 'close_friends' });
    const seen = await open(friend, s.id);
    expect(seen).toMatchObject({ mentionsYou: true, canReshare: true });
    expect((await as(t.app, friend).post(`/v1/moments/${s.id}/reshare`, { visibility: 'followers' })).status).toBe(201);
    const group = (await as(t.app, friendFan).get('/v1/moments')).body.items.find((g: any) => g.author.id === friend.id);
    expect(group.moments[0].reshareOf).toEqual({ id: s.id, available: false });
  });
});

describe('mentions in stories', () => {
  it('notifies people mentioned in text or on a sticker, only if they can see the story', async () => {
    const author = await adult();
    const fan = await adult();
    const stickerFan = await adult();
    const outsider = await adult();
    await follow(fan, author);
    await follow(stickerFan, author);
    const s = await story(author, {
      body: `Dinner with @${fan.username} and @${outsider.username}`,
      visibility: 'followers',
      stickers: [{ type: 'mention', ...at, username: `@${stickerFan.username}` }],
    });
    expect(await notifications(fan, 'story_mention')).toEqual([expect.objectContaining({ actor_id: author.id, entity_type: 'moment', entity_id: s.id })]);
    expect(await notifications(stickerFan, 'story_mention')).toHaveLength(1);
    expect(await notifications(outsider, 'story_mention')).toHaveLength(0); // can't see a followers-only story

    const seen = await open(stickerFan, s.id);
    expect(seen.stickers).toEqual([expect.objectContaining({ type: 'mention', x: 0.5, y: 0.5, user: expect.objectContaining({ id: stickerFan.id }) })]);
    expect(seen.mentionsYou).toBe(true);

    // A sticker has to name someone real.
    const bad = await as(t.app, author).post('/v1/moments', { body: 'Hi', stickers: [{ type: 'mention', ...at, username: 'nobody_here_at_all' }] });
    expect(bad.status).toBe(400);
  });
});

describe('hashtags in stories', () => {
  it('lists active public stories on the tag page and in trending, never followers-only or close friends ones', async () => {
    const tag = `st${Date.now().toString(36)}`;
    const author = await adult();
    const close = await adult();
    const privateAuthor = await adult();
    await follow(close, author);
    await as(t.app, author).put(`/v1/me/close-friends/${close.id}`);
    const pub = await story(author, { body: `Sunrise #${tag}`, visibility: 'public' });
    expect(pub.tags).toEqual([tag]);
    const followersOnly = await story(author, { body: 'Tagged by sticker', visibility: 'followers', stickers: [{ type: 'hashtag', ...at, tag: `#${tag}` }] });
    expect(followersOnly.tags).toEqual([tag]);
    const closeOnly = await story(author, { body: `Just us #${tag}`, visibility: 'close_friends' });
    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [privateAuthor.id]);
    const hidden = await story(privateAuthor, { body: `Private account #${tag}`, visibility: 'public' });

    // Even someone who can see every one of these stories only gets the public one here.
    for (const viewer of [close, null]) {
      const res = await as(t.app, viewer).get(`/v1/tags/${tag}/stories`);
      expect(res.status).toBe(200);
      const ids = res.body.items.flatMap((g: any) => g.moments.map((m: any) => m.id));
      expect(ids).toEqual([pub.id]);
      expect(ids).not.toContain(followersOnly.id);
      expect(ids).not.toContain(closeOnly.id);
      expect(ids).not.toContain(hidden.id);
    }

    const trending = (await as(t.app, null).get('/v1/trending?limit=30')).body.items.find((x: any) => x.tag === tag);
    expect(trending).toMatchObject({ posts: 1, people: 1 });

    // Deleted (or expired) stories drop out.
    await as(t.app, author).del(`/v1/moments/${pub.id}`);
    expect((await as(t.app, null).get(`/v1/tags/${tag}/stories`)).body.items).toEqual([]);
    expect((await as(t.app, null).get('/v1/trending?limit=30')).body.items.some((x: any) => x.tag === tag)).toBe(false);
  });

  it('opens a public story from the tag page for people who do not follow the author', async () => {
    const tag = `op${Date.now().toString(36)}`;
    const author = await adult();
    const visitor = await adult();
    const s = await story(author, { body: `Market day #${tag}`, visibility: 'public' });
    expect((await as(t.app, visitor).get('/v1/moments')).body.items.some((g: any) => g.author.id === author.id)).toBe(false); // not in the strip
    expect((await as(t.app, visitor).post(`/v1/moments/${s.id}/view`)).status).toBe(200);
    expect((await open(visitor, s.id)).tags).toEqual([tag]);
  });
});

describe('interactive stickers', () => {
  it('lets each viewer vote once in a poll and shows results only after voting', async () => {
    const author = await adult();
    const a = await adult();
    const b = await adult();
    const outsider = await adult();
    await follow(a, author);
    await follow(b, author);
    expect((await as(t.app, author).post('/v1/moments', { body: 'x', stickers: [{ type: 'poll', ...at, options: ['One', 'Two', 'Three'] }] })).status).toBe(
      400,
    );
    expect(
      (
        await as(t.app, author).post('/v1/moments', {
          body: 'x',
          stickers: [
            { type: 'poll', ...at, options: ['A', 'B'] },
            { type: 'poll', ...at, options: ['C', 'D'] },
          ],
        })
      ).status,
    ).toBe(400);
    const s = await story(author, {
      body: 'Lunch?',
      visibility: 'followers',
      stickers: [{ type: 'poll', ...at, question: 'Where?', options: ['Rice', 'Soup'] }],
    });
    const poll = (await open(a, s.id)).stickers[0];
    expect(poll).toMatchObject({ type: 'poll', question: 'Where?', options: ['Rice', 'Soup'], voted: null });
    expect(poll.results).toBeUndefined();

    const url = `/v1/moments/${s.id}/stickers/${poll.id}/vote`;
    expect((await as(t.app, a).post(url, { option: 2 })).status).toBe(400);
    expect((await as(t.app, a).post(url, { option: 0 })).body).toEqual({ voted: 0, results: [100, 0], votes: 1 });
    expect((await as(t.app, a).post(url, { option: 1 })).status).toBe(409); // once
    expect((await as(t.app, author).post(url, { option: 1 })).status).toBe(400); // not your own
    expect((await as(t.app, outsider).post(url, { option: 1 })).status).toBe(404); // can't see it
    expect((await as(t.app, a).post(`/v1/moments/${s.id}/stickers/nope/vote`, { option: 1 })).status).toBe(404);

    // Before voting, b sees no results; after, the percentages.
    expect((await open(b, s.id)).stickers[0].results).toBeUndefined();
    expect((await as(t.app, b).post(url, { option: 1 })).body.results).toEqual([50, 50]);
    expect((await open(b, s.id)).stickers[0]).toMatchObject({ voted: 1, results: [50, 50], votes: 2 });

    // The author sees the counts in "Seen by".
    const results = (await as(t.app, author).get(`/v1/moments/${s.id}/viewers`)).body.results;
    expect(results).toEqual([{ stickerId: poll.id, type: 'poll', options: ['Rice', 'Soup'], counts: [1, 1], percents: [50, 50], votes: 2 }]);
  });

  it('keeps question answers private to the author', async () => {
    const author = await adult();
    const fan = await adult();
    const other = await adult();
    await follow(fan, author);
    await follow(other, author);
    const s = await story(author, { body: 'Ask me', visibility: 'followers', stickers: [{ type: 'question', ...at, prompt: 'Any questions?' }] });
    const q = (await open(fan, s.id)).stickers[0];
    const url = `/v1/moments/${s.id}/stickers/${q.id}/answers`;
    expect((await as(t.app, fan).post(url, { text: '' })).status).toBe(400);
    expect((await as(t.app, fan).post(url, { text: 'What camera do you use?' })).body).toEqual({ answered: 1 });
    expect((await as(t.app, author).post(url, { text: 'Me' })).status).toBe(400);

    // Other viewers see only the prompt; the answers are the author's.
    const theirs = (await open(other, s.id)).stickers[0];
    expect(theirs).toEqual(expect.objectContaining({ type: 'question', prompt: 'Any questions?', answered: 0 }));
    expect(JSON.stringify(theirs)).not.toContain('camera');
    expect((await as(t.app, other).get(`/v1/moments/${s.id}/viewers`)).status).toBe(403);
    const results = (await as(t.app, author).get(`/v1/moments/${s.id}/viewers`)).body.results;
    expect(results[0]).toMatchObject({ type: 'question', prompt: 'Any questions?', answers: [{ text: 'What camera do you use?', user: { id: fan.id } }] });
  });

  it('takes one slider answer per viewer and shows the author the average', async () => {
    const author = await adult();
    const a = await adult();
    const b = await adult();
    await follow(a, author);
    await follow(b, author);
    const s = await story(author, { body: 'Rate it', visibility: 'followers', stickers: [{ type: 'slider', ...at, prompt: 'How spicy?', emoji: '🌶️' }] });
    const slider = (await open(a, s.id)).stickers[0];
    const url = `/v1/moments/${s.id}/stickers/${slider.id}/slide`;
    expect((await as(t.app, a).post(url, { value: 1.5 })).status).toBe(400);
    expect((await as(t.app, a).post(url, { value: 0.8 })).status).toBe(200);
    expect((await as(t.app, a).post(url, { value: 0.1 })).status).toBe(409);
    expect((await as(t.app, b).post(url, { value: 0.4 })).status).toBe(200);
    expect((await as(t.app, author).post(url, { value: 0.4 })).status).toBe(400);
    const seen = (await open(a, s.id)).stickers[0];
    expect(seen.mine).toBeCloseTo(0.8);
    expect(seen.average).toBeUndefined();
    const mine = (await open(author, s.id)).stickers[0];
    expect(mine.average).toBeCloseTo(0.6);
    const results = (await as(t.app, author).get(`/v1/moments/${s.id}/viewers`)).body.results;
    expect(results[0]).toMatchObject({ type: 'slider', emoji: '🌶️', count: 2 });
    expect(results[0].average).toBeCloseTo(0.6);
  });

  it('reminds people who asked when a countdown ends', async () => {
    const author = await adult();
    const fan = await adult();
    await follow(fan, author);
    expect(
      (
        await as(t.app, author).post('/v1/moments', {
          body: 'x',
          stickers: [{ type: 'countdown', ...at, title: 'Launch', endsAt: new Date(Date.now() - 60_000).toISOString() }],
        })
      ).status,
    ).toBe(400);
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const s = await story(author, { body: 'Soon', visibility: 'followers', stickers: [{ type: 'countdown', ...at, title: 'Launch', endsAt }] });
    const c = (await open(fan, s.id)).stickers[0];
    expect(c).toMatchObject({ type: 'countdown', title: 'Launch', endsAt, reminding: false });
    const url = `/v1/moments/${s.id}/stickers/${c.id}/reminder`;
    expect((await as(t.app, fan).put(url)).body).toEqual({ reminding: true });
    expect((await as(t.app, fan).put(url)).body).toEqual({ reminding: true }); // still one reminder
    expect((await open(fan, s.id)).stickers[0].reminding).toBe(true);
    expect((await as(t.app, author).get(`/v1/moments/${s.id}/viewers`)).body.results[0]).toMatchObject({ type: 'countdown', reminders: 1 });

    // Nothing before the end; one notification after it.
    await sendCountdownReminders(t.ctx.db, t.ctx.realtime);
    expect(await notifications(fan, 'story_countdown')).toHaveLength(0);
    await t.ctx.db.query(`UPDATE story_responses SET remind_at = now() - interval '1 second' WHERE moment_id = $1`, [s.id]);
    await sendCountdownReminders(t.ctx.db, t.ctx.realtime);
    await sendCountdownReminders(t.ctx.db, t.ctx.realtime);
    expect(await notifications(fan, 'story_countdown')).toEqual([expect.objectContaining({ entity_id: s.id, data: { title: 'Launch' } })]);

    // Turning a reminder off works before it's sent.
    const other = await adult();
    await follow(other, author);
    await as(t.app, other).put(url);
    expect((await as(t.app, other).del(url)).body).toEqual({ reminding: false });
    expect((await open(other, s.id)).stickers[0].reminding).toBe(false);
  });

  it('allows link stickers only for accounts older than 7 days, and shows the domain', async () => {
    const author = await adult();
    const fan = await adult();
    await follow(fan, author);
    const link = { type: 'link', ...at, url: 'https://www.example.com/tickets?id=1' };
    const young = await as(t.app, author).post('/v1/moments', { body: 'Tickets', stickers: [link] });
    expect(young.status).toBe(403);
    expect(young.body.error.code).toBe('link_sticker_not_allowed');
    expect((await as(t.app, author).post('/v1/moments', { body: 'x', stickers: [{ ...link, url: 'javascript:alert(1)' }] })).status).toBe(400);
    await t.ctx.db.query(`UPDATE users SET created_at = now() - interval '8 days' WHERE id = $1`, [author.id]);
    const s = await story(author, { body: 'Tickets', visibility: 'followers', stickers: [link] });
    expect((await open(fan, s.id)).stickers[0]).toMatchObject({ type: 'link', url: link.url, domain: 'example.com' });
  });

  it('links a place sticker to an existing place', async () => {
    const author = await adult();
    const fan = await adult();
    await follow(fan, author);
    expect(
      (await as(t.app, author).post('/v1/moments', { body: 'x', stickers: [{ type: 'place', ...at, placeId: '00000000-0000-4000-8000-000000000000' }] }))
        .status,
    ).toBe(404);
    const place = (
      await t.ctx.db.query(`INSERT INTO places (name, category, city, created_by) VALUES ('Mama Put', 'restaurant', 'Lagos', $1) RETURNING id`, [author.id])
    ).rows[0];
    const s = await story(author, { body: 'Lunch', visibility: 'followers', stickers: [{ type: 'place', ...at, placeId: place.id }] });
    expect((await open(fan, s.id)).stickers[0]).toMatchObject({ type: 'place', placeId: place.id, name: 'Mama Put', city: 'Lagos' });
  });
});
