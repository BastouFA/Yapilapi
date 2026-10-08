import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SQUAD_MEMBERS, squadNoticeHref, squadNoticeText } from '@yapilapi/shared';
import { t as tr, tp as trp } from '@yapilapi/shared/i18n';
import { as, followAccepted, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { sweepSquadMemories, weekStartOf } from '../src/lib/squads.ts';

/**
 * Squads (lib/squads.ts, modules/squads.ts): docs/product/squads.md. Nobody outside a squad sees
 * it, who is in it or anything shared with it, through any endpoint.
 */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = (extra: Record<string, unknown> = {}) => signUp(t.app, extra);
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
/** Follow each other (what inviting needs, besides friends). */
const mutual = async (a: TestUser, b: TestUser) => {
  await followAccepted(t.app, a, b);
  await followAccepted(t.app, b, a);
};
const befriend = async (a: TestUser, b: TestUser) => {
  await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
  await as(t.app, b).post(`/v1/users/${a.id}/friend-request`);
};
const notes = async (u: TestUser, type?: string) => ((await as(t.app, u).get('/v1/notifications')).body.items as any[]).filter((n) => !type || n.type === type);
const create = (owner: TestUser, invite: TestUser[], extra: Record<string, unknown> = {}) =>
  as(t.app, owner).post('/v1/squads', { name: 'Crew', userIds: invite.map((u) => u.id), ...extra });

/** A squad with `owner` and `joined` in it (all following each other), `pending` invited. */
async function squadOf(owner: TestUser, joined: TestUser[], pending: TestUser[] = []) {
  for (const u of [...joined, ...pending]) await mutual(owner, u);
  const invite = [...joined, ...pending];
  // A squad starts with at least two invites.
  const extra = invite.length < 2 ? [await adult()] : [];
  for (const u of extra) await mutual(owner, u);
  const r = await create(owner, [...invite, ...extra]);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.squad.id as string;
  for (const u of joined) expect((await as(t.app, u).post(`/v1/squads/${id}/accept`)).status).toBe(200);
  return { id, conversationId: r.body.squad.conversationId as string };
}
const squadPost = (u: TestUser, squadId: string, body: string, extra: Record<string, unknown> = {}) =>
  as(t.app, u).post('/v1/posts', { body, visibility: 'squad', squadId, ...extra });
const video = async (u: TestUser) =>
  (
    await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/s.mp4','video/mp4','ready',10000) RETURNING id, url`,
      [u.id],
    )
  ).rows[0] as { id: string; url: string };
const reel = async (u: TestUser, extra: Record<string, unknown>) => {
  const m = await video(u);
  return as(t.app, u).post('/v1/posts', { body: 'A reel', format: 'reel', media: [{ id: m.id, url: m.url, kind: 'video' }], ...extra });
};
const secret = () => `squadword${randomUUID().slice(0, 8)}`;
const leaks = (body: unknown, ...needles: string[]) => needles.some((n) => JSON.stringify(body ?? null).includes(n));

describe('Squads: making one and joining', () => {
  it('creates a squad with invites, and people join by accepting', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    await mutual(ada, bola);
    await befriend(ada, cleo);
    const r = await create(ada, [bola, cleo], { color: 'teal' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const sq = r.body.squad;
    expect(sq).toMatchObject({ name: 'Crew', color: 'teal', memberCount: 3, viewer: { role: 'owner', invited: false } });
    expect(sq.members.map((m: any) => [m.user.id, m.role, m.invited])).toEqual([
      [ada.id, 'owner', false],
      [bola.id, 'member', true],
      [cleo.id, 'member', true],
    ]);
    expect(sq.conversationId).toBeTruthy();

    // Bola is told, and sees the squad as an invite (who is in it, not who else is invited).
    const invite = await notes(bola, 'squad_invite');
    expect(invite).toHaveLength(1);
    expect(invite[0]).toMatchObject({ entityType: 'squad', entityId: sq.id, data: { name: 'Crew' } });
    const say = (n: any) =>
      squadNoticeText(
        n,
        (k, v) => tr(k, 'en', v),
        (k, c, v) => trp(k, c, 'en', v),
      );
    expect(say(invite[0])).toBe(`${invite[0].actor.displayName} invited you to join Crew`);
    expect(squadNoticeHref(invite[0])).toBe(sq.id);
    const seen = (await as(t.app, bola).get(`/v1/squads/${sq.id}`)).body.squad;
    expect(seen.viewer).toMatchObject({ role: null, invited: true, invitedBy: { id: ada.id } });
    expect(seen.members.map((m: any) => m.user.id)).toEqual([ada.id]);
    expect(seen.conversationId).toBeNull();
    const list = (await as(t.app, bola).get('/v1/squads')).body.items;
    expect(list[0]).toMatchObject({ id: sq.id, role: null, invitedBy: { id: ada.id } });

    // Accepting: in the squad and its chat; the others hear.
    const joined = await as(t.app, bola).post(`/v1/squads/${sq.id}/accept`);
    expect(joined.body.squad.viewer.role).toBe('member');
    expect(joined.body.squad.conversationId).toBe(sq.conversationId);
    const chats = (await as(t.app, bola).get('/v1/conversations')).body.items;
    const chat = chats.find((c: any) => c.id === sq.conversationId);
    expect(chat).toMatchObject({ kind: 'group', title: 'Crew', squadId: sq.id });
    expect(chat.members.map((m: any) => m.id).sort()).toEqual([ada.id, bola.id].sort());
    expect(await notes(bola, 'squad_invite')).toHaveLength(0);
    expect(say((await notes(ada, 'squad_joined'))[0])).toMatch(/joined Crew$/);

    // Declining: the invite is gone, and the squad with it.
    expect((await as(t.app, cleo).post(`/v1/squads/${sq.id}/decline`)).status).toBe(200);
    expect((await as(t.app, cleo).get(`/v1/squads/${sq.id}`)).status).toBe(404);
    expect((await as(t.app, ada).get(`/v1/squads/${sq.id}`)).body.squad.memberCount).toBe(2);
  });

  it('invites only people you follow who follow you back, or friends; 2 to 9 at first, 10 people at most', async () => {
    const ada = await adult();
    const bola = await adult();
    const fan = await adult();
    await mutual(ada, bola);
    await followAccepted(t.app, fan, ada);
    await followAccepted(t.app, ada, fan);
    const stranger = await adult();
    await followAccepted(t.app, ada, stranger);
    const r = await create(ada, [bola, stranger]);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('squad_invite_not_allowed');
    expect((await create(ada, [bola])).status).toBe(400);
    expect((await create(ada, [bola, fan], { name: '' })).status).toBe(400);
    expect((await create(ada, [bola, fan], { color: 'neon' })).status).toBe(400);
    // Nothing was made by the refused attempts.
    expect((await as(t.app, ada).get('/v1/squads')).body.items).toHaveLength(0);

    const many: TestUser[] = [];
    for (let i = 0; i < MAX_SQUAD_MEMBERS; i++) {
      const u = await adult();
      await mutual(ada, u);
      many.push(u);
    }
    expect((await create(ada, many)).status).toBe(400);
    const made = await create(ada, many.slice(0, MAX_SQUAD_MEMBERS - 1));
    expect(made.status).toBe(201);
    expect(made.body.squad.memberCount).toBe(MAX_SQUAD_MEMBERS);
    // Full: invites count, so nobody else can be invited until someone declines.
    const more = await as(t.app, ada).post(`/v1/squads/${made.body.squad.id}/invites`, { userIds: [many[9]!.id] });
    expect(more.status).toBe(409);
    expect(more.body.error.code).toBe('squad_full');
    await as(t.app, many[0]!).post(`/v1/squads/${made.body.squad.id}/decline`);
    const now = await as(t.app, ada).post(`/v1/squads/${made.body.squad.id}/invites`, { userIds: [many[9]!.id, ada.id] });
    expect(now.body.invited).toBe(1);
    // Someone who isn't in it can't invite.
    expect((await as(t.app, stranger).post(`/v1/squads/${made.body.squad.id}/invites`, { userIds: [ada.id] })).status).toBe(404);
  });

  it('keeps blocked people apart, before and after the invite', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const dayo = await adult();
    const { id } = await squadOf(ada, [bola]);
    await mutual(ada, cleo);
    // Cleo blocked Bola: Cleo can't be invited into a squad Bola is in.
    await as(t.app, cleo).post(`/v1/users/${bola.id}/block`);
    const r = await as(t.app, ada).post(`/v1/squads/${id}/invites`, { userIds: [cleo.id] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('blocked_in_group');
    // Dayo is invited, then blocks Bola: accepting is refused.
    await mutual(ada, dayo);
    expect((await as(t.app, ada).post(`/v1/squads/${id}/invites`, { userIds: [dayo.id] })).body.invited).toBe(1);
    await as(t.app, dayo).post(`/v1/users/${bola.id}/block`);
    const accept = await as(t.app, dayo).post(`/v1/squads/${id}/accept`);
    expect(accept.status).toBe(403);
    expect(accept.body.error.code).toBe('squad_not_allowed');
    // Candidates leave out people who can't be in it with the members.
    const candidates = (await as(t.app, ada).get(`/v1/squads/candidates?squadId=${id}`)).body.items.map((u: any) => u.id);
    expect(candidates).not.toContain(cleo.id);
    expect(candidates).not.toContain(bola.id);
  });

  it('keeps under-18s with under-18s, or with adults who are their friends', async () => {
    const ada = await adult();
    const kid = await teen();
    const kid2 = await teen();
    const bola = await adult();
    // Following each other isn't enough between an adult and a teen.
    await mutual(ada, kid);
    await mutual(ada, bola);
    const r = await create(ada, [kid, bola]);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('minor_protection');
    // Friends: Ada may, but Bola (an adult who isn't Kid's friend) can't be in it with Kid.
    await befriend(ada, kid);
    const { id } = await squadOf(ada, [bola]);
    const add = await as(t.app, ada).post(`/v1/squads/${id}/invites`, { userIds: [kid.id] });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('minor_protection');
    // Two teens who follow each other can have a squad.
    await mutual(kid, kid2);
    const kid3 = await teen();
    await mutual(kid, kid3);
    expect((await create(kid, [kid2, kid3])).status).toBe(201);
  });
});

describe('Squads: only members see what is shared', () => {
  it('a squad post, its comments and the squad reach members only, through every endpoint', async () => {
    const ada = await adult();
    const bola = await adult();
    const outsider = await adult();
    const { id } = await squadOf(ada, [bola]);
    // The outsider follows Ada and is followed back, and is friends with her: still outside the squad.
    await mutual(ada, outsider);
    await befriend(ada, outsider);
    const word = secret();
    const p = await squadPost(ada, id, `Saturday plans ${word} #${word}`);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const postId = p.body.post.id as string;
    expect(p.body.post).toMatchObject({ visibility: 'squad', squad: { id, name: 'Crew' } });
    const comment = await as(t.app, bola).post(`/v1/posts/${postId}/comments`, { body: `Count me in ${word}` });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    // Members: the squad page, the post, its comments, their feed.
    expect((await as(t.app, bola).get(`/v1/squads/${id}/posts`)).body.items.map((x: any) => x.id)).toEqual([postId]);
    expect((await as(t.app, bola).get(`/v1/posts/${postId}`)).body.post.squad).toMatchObject({ id, name: 'Crew' });
    expect((await as(t.app, bola).get(`/v1/posts/${postId}/comments`)).body.items).toHaveLength(1);
    expect(leaks((await as(t.app, bola).get('/v1/feed?mode=following')).body, postId)).toBe(true);

    // Everyone else, signed in or not: nothing, anywhere.
    for (const viewer of [outsider, null]) {
      const v = as(t.app, viewer);
      expect((await v.get(`/v1/posts/${postId}`)).status).toBe(viewer ? 404 : 404);
      const comments = await v.get(`/v1/posts/${postId}/comments`);
      expect(leaks(comments.body, word)).toBe(false);
      expect(leaks((await v.get(`/v1/users/${ada.username}/posts`)).body, postId, word)).toBe(false);
      const found = (await v.get(`/v1/search?q=${word}`)).body;
      expect(leaks(found.results, postId, word), JSON.stringify(found.results)).toBe(false);
      expect(leaks((await v.get(`/v1/tags/${word}/posts`)).body, postId)).toBe(false);
      expect((await v.get(`/v1/squads/${id}`)).status).toBe(viewer ? 404 : 401);
      expect((await v.get(`/v1/squads/${id}/posts`)).status).toBe(viewer ? 404 : 401);
    }
    const o = as(t.app, outsider);
    for (const mode of ['following', 'friends', 'for_you']) expect(leaks((await o.get(`/v1/feed?mode=${mode}`)).body, postId), mode).toBe(false);
    expect(leaks((await o.get('/v1/reels')).body, postId)).toBe(false);
    expect((await o.post(`/v1/posts/${postId}/comments`, { body: 'hi' })).status).toBe(404);
    expect((await o.get(`/v1/squads/candidates?squadId=${id}`)).status).toBe(404);
    expect((await o.get('/v1/squads')).body.items).toEqual([]);
    expect(leaks(await notes(outsider), id, word, 'Crew')).toBe(false);
    expect(leaks((await o.get('/v1/me/export')).body, word, id)).toBe(false);
    // Reporting: a member can, as for any post; an outsider can't even name it.
    expect((await as(t.app, bola).post('/v1/reports', { targetType: 'post', targetId: postId, reason: 'spam' })).status).toBe(201);
    expect((await o.post('/v1/reports', { targetType: 'post', targetId: postId, reason: 'spam' })).status).toBe(404);
    // A member's own export lists the squad, never who else is in it.
    const exported = (await as(t.app, bola).get('/v1/me/export')).body;
    expect(exported.squads.squads).toEqual([expect.objectContaining({ id, name: 'Crew', role: 'member', status: 'active' })]);
    expect(leaks(exported.squads, ada.id)).toBe(false);

    // A squad post's audience never opens up.
    expect((await as(t.app, ada).patch(`/v1/posts/${postId}`, { visibility: 'public' })).status).toBe(400);
    // Only members post to it.
    expect((await squadPost(outsider, id, 'Let me in')).status).toBe(404);
    expect((await as(t.app, ada).post('/v1/posts', { body: 'x', visibility: 'squad' })).status).toBe(400);
  });

  it('the squad story is one ring for members, shown first, and nobody else sees it', async () => {
    const ada = await adult();
    const bola = await adult();
    const outsider = await adult();
    const { id } = await squadOf(ada, [bola]);
    await mutual(bola, outsider);
    await befriend(bola, outsider);
    // Bola's own story for their people, and one for the squad.
    expect((await as(t.app, bola).post('/v1/moments', { body: 'Mine', visibility: 'friends' })).status).toBe(201);
    const s = await as(t.app, bola).post('/v1/moments', { body: 'For the crew', visibility: 'squad', squadId: id, expiresIn: 'permanent' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const storyId = s.body.moment.id as string;
    const until = new Date(s.body.moment.expires_at ?? s.body.moment.expiresAt).getTime();
    // Squad stories last 24 hours, whatever was asked.
    expect(Math.abs(until - Date.now() - 24 * 3_600_000)).toBeLessThan(120_000);
    expect((await as(t.app, ada).post('/v1/moments', { body: 'Me too', visibility: 'squad', squadId: id })).status).toBe(201);

    const strip = (await as(t.app, ada).get('/v1/moments')).body.items;
    // Ada's own ring first (her story went to the squad, so the squad's ring), then the squad, then the rest.
    const ring = strip.find((g: any) => g.squad?.id === id);
    expect(ring.squad).toMatchObject({ id, name: 'Crew', color: 'coral' });
    expect(ring.moments.map((m: any) => m.author.id)).toEqual([bola.id, ada.id]);
    expect(strip[0].squad?.id).toBe(id);
    expect(ring.moments.every((m: any) => m.squadId === id && !m.canReshare)).toBe(true);
    // Bola's own ring holds only the story for his people.
    const bolas = (await as(t.app, bola).get('/v1/moments')).body.items;
    expect(bolas[0]).toMatchObject({ mine: true });
    expect(bolas[0].moments.map((m: any) => m.body)).toEqual(['Mine']);

    const o = as(t.app, outsider);
    const theirs = (await o.get('/v1/moments')).body.items;
    expect(leaks(theirs, storyId, 'For the crew')).toBe(false);
    expect(theirs.flatMap((g: any) => g.moments.map((m: any) => m.body))).toEqual(['Mine']);
    expect((await o.get(`/v1/moments/${storyId}`)).status).toBe(404);
    expect((await o.post(`/v1/moments/${storyId}/reshare`, {})).status).toBe(404);
    // A member can't reshare it either, and nobody outside posts to it.
    expect((await as(t.app, ada).post(`/v1/moments/${storyId}/reshare`, {})).status).toBe(403);
    expect((await o.post('/v1/moments', { body: 'x', visibility: 'squad', squadId: id })).status).toBe(404);
  });

  it('tells the others about new squad posts, batched per squad', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const { id } = await squadOf(ada, [bola, cleo]);
    await squadPost(ada, id, 'One');
    await squadPost(bola, id, 'Two');
    const told = await notes(cleo, 'squad_post');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ entityType: 'squad', entityId: id, data: { count: 2, name: 'Crew' } });
    expect(
      squadNoticeText(
        told[0],
        (k, v) => tr(k, 'en', v),
        (k, c, v) => trp(k, c, 'en', v),
      ),
    ).toMatch(/and 1 other shared in Crew$/);
    // Your own posts don't tell you; someone with the friends category off isn't told.
    expect(await notes(ada, 'squad_post')).toHaveLength(1);
    await db().query(`UPDATE user_preferences SET notification_categories = notification_categories || '{"friends": false}' WHERE user_id = $1`, [bola.id]);
    await db().query(`UPDATE notifications SET read_at = now() WHERE user_id = $1`, [bola.id]);
    await squadPost(ada, id, 'Three');
    expect((await notes(bola, 'squad_post')).filter((n) => !n.readAt && !n.read)).toHaveLength(0);
  });
});

describe('Squads: leaving, removing, handing on and deleting', () => {
  it('follows who is in it: leaving and removal take away the posts, the story and the chat', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const dayo = await adult();
    const { id, conversationId } = await squadOf(ada, [bola, cleo, dayo]);
    const post = (await squadPost(ada, id, 'Before you go')).body.post.id as string;
    await as(t.app, ada).post('/v1/moments', { body: 'Story', visibility: 'squad', squadId: id });

    // The owner can't leave without handing it on.
    const own = await as(t.app, ada).post(`/v1/squads/${id}/leave`);
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('squad_owner');

    // Bola leaves: no post, no story, no chat, no squad notifications.
    expect((await as(t.app, bola).post(`/v1/squads/${id}/leave`)).status).toBe(200);
    expect((await as(t.app, bola).get(`/v1/posts/${post}`)).status).toBe(404);
    expect(leaks((await as(t.app, bola).get('/v1/moments')).body, id)).toBe(false);
    expect((await as(t.app, bola).get(`/v1/conversations/${conversationId}`)).status).toBe(404);
    expect(leaks(await notes(bola), id)).toBe(false);

    // Admins remove members but not the owner or other admins; the owner removes anyone.
    expect((await as(t.app, ada).put(`/v1/squads/${id}/members/${cleo.id}/role`, { role: 'admin' })).body.squad.members[1]).toMatchObject({
      role: 'admin',
    });
    expect((await as(t.app, cleo).del(`/v1/squads/${id}/members/${ada.id}`)).status).toBe(403);
    expect((await as(t.app, dayo).del(`/v1/squads/${id}/members/${cleo.id}`)).status).toBe(403);
    const out = await as(t.app, cleo).del(`/v1/squads/${id}/members/${dayo.id}`);
    expect(out.status).toBe(200);
    expect(out.body.squad.members.map((m: any) => m.user.id)).toEqual([ada.id, cleo.id]);
    expect((await as(t.app, dayo).get(`/v1/squads/${id}/posts`)).status).toBe(404);
    const chat = (await as(t.app, ada).get(`/v1/conversations/${conversationId}`)).body.conversation;
    expect(chat.members.map((m: any) => m.id).sort()).toEqual([ada.id, cleo.id].sort());
    // Cleo is an admin in the chat too (the squad's admins are).
    expect(chat.adminIds.sort()).toEqual([ada.id, cleo.id].sort());

    // Handing it on: Cleo owns it, Ada stays as an admin and may now leave.
    const handed = await as(t.app, ada).post(`/v1/squads/${id}/owner`, { userId: cleo.id });
    expect(handed.body.squad.members.map((m: any) => [m.user.id, m.role])).toEqual([
      [cleo.id, 'owner'],
      [ada.id, 'admin'],
    ]);
    expect((await as(t.app, ada).post(`/v1/squads/${id}/leave`)).status).toBe(200);
    // Ada still sees her own post; Cleo still sees it in the squad.
    expect((await as(t.app, ada).get(`/v1/posts/${post}`)).status).toBe(200);
    expect((await as(t.app, cleo).get(`/v1/squads/${id}/posts`)).body.items.map((p: any) => p.id)).toEqual([post]);
  });

  it('the chat is managed from the squad', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const { id, conversationId } = await squadOf(ada, [bola]);
    await mutual(ada, cleo);
    await befriend(ada, cleo);
    for (const r of [
      await as(t.app, ada).post(`/v1/conversations/${conversationId}/members`, { userIds: [cleo.id] }),
      await as(t.app, ada).del(`/v1/conversations/${conversationId}/members/${bola.id}`),
      await as(t.app, ada).patch(`/v1/conversations/${conversationId}`, { title: 'Other' }),
      await as(t.app, bola).post(`/v1/conversations/${conversationId}/leave`),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('squad_chat');
    }
    // Renaming the squad renames its chat; a message works as in any group.
    await as(t.app, ada).patch(`/v1/squads/${id}`, { name: 'Weekend crew' });
    expect((await as(t.app, bola).get(`/v1/conversations/${conversationId}`)).body.conversation.title).toBe('Weekend crew');
    expect((await as(t.app, bola).post(`/v1/conversations/${conversationId}/messages`, { body: 'Hi all', clientId: randomUUID() })).status).toBe(201);
    const lines = (await as(t.app, ada).get(`/v1/conversations/${conversationId}/messages`)).body.items;
    expect(lines.some((m: any) => m.system?.action === 'added')).toBe(true);
    expect(lines.some((m: any) => m.system?.action === 'renamed')).toBe(true);
  });

  it('deleting it leaves posts with their authors only and the chat as a plain group', async () => {
    const ada = await adult();
    const bola = await adult();
    const { id, conversationId } = await squadOf(ada, [bola]);
    const mine = (await squadPost(bola, id, 'Mine')).body.post.id as string;
    // Only the owner deletes.
    expect((await as(t.app, bola).del(`/v1/squads/${id}`)).status).toBe(403);
    expect((await as(t.app, ada).del(`/v1/squads/${id}`)).status).toBe(200);
    expect((await as(t.app, ada).get(`/v1/squads/${id}`)).status).toBe(404);
    expect((await as(t.app, ada).get(`/v1/posts/${mine}`)).status).toBe(404);
    const own = await as(t.app, bola).get(`/v1/posts/${mine}`);
    expect(own.status).toBe(200);
    expect(own.body.post.squad).toBeNull();
    const chat = (await as(t.app, bola).get(`/v1/conversations/${conversationId}`)).body.conversation;
    expect(chat.squadId).toBeUndefined();
    expect((await as(t.app, bola).post(`/v1/conversations/${conversationId}/leave`)).status).toBe(200);
    expect(await notes(bola, 'squad_post')).toHaveLength(0);
  });

  it('an account that goes hands its squads on', async () => {
    const ada = await adult();
    const bola = await adult();
    const { id } = await squadOf(ada, [bola]);
    const del = await t.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: { authorization: `Bearer ${ada.token}` },
      payload: { password: ada.password },
    });
    expect(del.statusCode, del.body).toBeLessThan(300);
    const sq = (await as(t.app, bola).get(`/v1/squads/${id}`)).body.squad;
    expect(sq.viewer.role).toBe('owner');
    expect(sq.members.filter((m: any) => !m.invited).map((m: any) => m.user.id)).toEqual([bola.id]);
  });
});

describe('Squads: weekly memory', () => {
  it('makes one memory for a squad that shared last week, tells each member once, and pins it', async () => {
    const ada = await adult();
    const bola = await adult();
    const { id } = await squadOf(ada, [bola]);
    const quiet = await squadOf(bola, [ada]);
    const now = new Date();
    const lastWeek = new Date(Date.parse(`${weekStartOf(now)}T00:00:00Z`) - 3 * 86_400_000);
    const p1 = (await squadPost(ada, id, 'Picnic')).body.post.id as string;
    const p2 = (await squadPost(bola, id, 'Beach')).body.post.id as string;
    await db().query(`UPDATE posts SET created_at = $2 WHERE id = ANY($1::uuid[])`, [[p1, p2], lastWeek]);
    await db().query(`UPDATE posts SET like_count = 5 WHERE id = $1`, [p2]);

    expect(await sweepSquadMemories({ db: db(), realtime: t.ctx.realtime }, { now })).toBeGreaterThanOrEqual(1);
    // Once a week only.
    expect(await sweepSquadMemories({ db: db(), realtime: t.ctx.realtime }, { now })).toBe(0);
    for (const u of [ada, bola]) {
      const told = (await notes(u, 'squad_memory')).filter((n) => n.entityId === id);
      expect(told).toHaveLength(1);
      expect(
        squadNoticeText(
          told[0],
          (k, v) => tr(k, 'en', v),
          (k, c, v) => trp(k, c, 'en', v),
        ),
      ).toBe('Your week in Crew is ready');
    }
    // A squad that shared nothing gets nothing.
    expect((await notes(ada, 'squad_memory')).some((n) => n.entityId === quiet.id)).toBe(false);

    const memory = (await as(t.app, bola).get(`/v1/squads/${id}`)).body.squad.memory;
    expect(memory).toMatchObject({ weekStart: weekStartOf(lastWeek), counts: { posts: 2, reels: 0, people: 2 } });
    expect(memory.top.map((p: any) => p.id)).toEqual([p2, p1]);
    expect(memory.people.map((u: any) => u.id).sort()).toEqual([ada.id, bola.id].sort());
    expect((await as(t.app, bola).get(`/v1/squads/${id}/memories/${memory.id}`)).body.memory.id).toBe(memory.id);
    expect((await as(t.app, await adult()).get(`/v1/squads/${id}/memories/${memory.id}`)).status).toBe(404);
  });
});

describe('Squads: Pass the Mic for the squad only', () => {
  it('a chain started with a squad reel is seen and joined by the squad only', async () => {
    const ada = await adult();
    const bola = await adult();
    const outsider = await adult();
    const { id } = await squadOf(ada, [bola]);
    await mutual(ada, outsider);
    const start = await reel(ada, { visibility: 'squad', squadId: id, chainPrompt: 'Our best shot this week' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const chainId = start.body.post.chain.id as string;
    const chain = (await as(t.app, bola).get(`/v1/chains/${chainId}`)).body.chain;
    expect(chain).toMatchObject({ squad: { id, name: 'Crew' }, viewer: { canJoin: true } });

    // A member takes the mic with a reel for the squad; a public reel can't join it.
    expect((await reel(bola, { visibility: 'public', chainId })).status).toBe(400);
    const joined = await reel(bola, { visibility: 'squad', squadId: id, chainId });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect(joined.body.post.chain).toMatchObject({ id: chainId, position: 2 });

    // Outsiders: no chain, no shelf, no taking the mic.
    const o = as(t.app, outsider);
    expect((await o.get(`/v1/chains/${chainId}`)).status).toBe(404);
    expect((await o.get(`/v1/chains/${chainId}/links`)).status).toBe(404);
    expect(leaks((await o.get('/v1/chains/active?limit=30')).body, chainId)).toBe(false);
    expect(leaks((await as(t.app, bola).get('/v1/chains/active?limit=30')).body, chainId)).toBe(false);
    expect((await reel(outsider, { visibility: 'public', chainId })).status).toBe(404);
    // A squad reel can't join someone's public chain either.
    const open = (await reel(outsider, { visibility: 'public', chainPrompt: 'Open to all' })).body.post.chain.id as string;
    expect((await reel(ada, { visibility: 'squad', squadId: id, chainId: open })).status).toBe(400);
  });
});

describe('Squads: switched off, and the admin console', () => {
  it('is behind the SQUADS flag, and admins see counts', async () => {
    const admin = await adult();
    await db().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    const r = await as(t.app, admin).get('/v1/admin/squads');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ squads: expect.any(Number), members: expect.any(Number), invites: expect.any(Number), postsThisWeek: expect.any(Number) });
    expect(r.body.squads).toBeGreaterThan(0);
    expect((await as(t.app, await adult()).get('/v1/admin/squads')).status).toBe(403);

    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    await mutual(ada, bola);
    await mutual(ada, cleo);
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('SQUADS', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    try {
      expect((await create(ada, [bola, cleo])).status).toBe(404);
      expect((await as(t.app, ada).get('/v1/squads')).body.items).toEqual([]);
    } finally {
      await db().query(`DELETE FROM feature_flags WHERE key = 'SQUADS'`);
    }
  });
});
