import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * The first integrated flow from the build directive:
 * sign up → profile → interests → follow → home → discover → create post → post appears →
 * like → comment → follow user → message → create group → community
 */
describe('core vertical slice', () => {
  let t: BuiltApp;
  let ada: TestUser;
  let ben: TestUser;
  let cy: TestUser;

  beforeAll(async () => {
    t = await testApp();
    ben = await signUp(t.app, { displayName: 'Ben' });
    cy = await signUp(t.app, { displayName: 'Cy' });
  });
  afterAll(() => t.close());

  it('signs up and reads the session', async () => {
    ada = await signUp(t.app, { displayName: 'Ada' });
    const me = await as(t.app, ada).get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe(ada.username);
    expect(me.body.user.emailVerified).toBe(false);
  });

  it('verifies email with the emailed token', async () => {
    const outbox = (await t.app.inject({ url: '/dev/outbox' })).json().items;
    const mail = outbox.findLast((m: { to: string }) => m.to === ada.email);
    const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    expect((await as(t.app, null).post('/v1/auth/verify-email', { token })).status).toBe(200);
    expect((await as(t.app, ada).get('/v1/auth/me')).body.user.emailVerified).toBe(true);
    // Tokens are single-use.
    expect((await as(t.app, null).post('/v1/auth/verify-email', { token })).status).toBe(400);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const dup = await as(t.app, null).post('/v1/auth/register', { email: ada.email, password: 'another-long-password', username: 'someone_new', displayName: 'X' });
    expect(dup.status).toBe(409);
    const weak = await as(t.app, null).post('/v1/auth/register', { email: 'weak@example.test', password: 'short', username: 'weakling', displayName: 'W' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details.fields.password).toBeTruthy();
  });

  it('logs in with the right password only', async () => {
    expect((await as(t.app, null).post('/v1/auth/login', { email: ada.email, password: 'wrong-password!!' })).status).toBe(401);
    const ok = await as(t.app, null).post('/v1/auth/login', { email: ada.email, password: ada.password });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
  });

  it('edits the profile and sets interests', async () => {
    const p = await as(t.app, ada).patch('/v1/me/profile', { bio: 'Maths and machines', mode: 'creator' });
    expect(p.status).toBe(200);
    expect(p.body.profile.bio).toBe('Maths and machines');
    const i = await as(t.app, ada).put('/v1/me/interests', { topics: ['technology', 'Science', 'music'] });
    expect(i.body.interests).toEqual(['technology', 'science', 'music']);
    await as(t.app, ada).post('/v1/me/onboarding/complete');
    expect((await as(t.app, ada).get('/v1/auth/me')).body.user.onboarded).toBe(true);
  });

  it('follows people and shows the relationship', async () => {
    expect((await as(t.app, ada).post(`/v1/users/${ben.id}/follow`)).status).toBe(200);
    const prof = await as(t.app, ada).get(`/v1/users/${ben.username}`);
    expect(prof.body.profile.relationship.following).toBe(true);
    expect(prof.body.profile.counts.followers).toBe(1);
    expect((await as(t.app, ada).post(`/v1/users/${ada.id}/follow`)).status).toBe(400);
  });

  it('creates a post that appears in followers’ feeds', async () => {
    const created = await as(t.app, ben).post('/v1/posts', { body: 'Hello from Ben, talking about technology', topics: ['technology'] });
    expect(created.status).toBe(201);
    const postId = created.body.post.id;

    const following = await as(t.app, ada).get('/v1/feed?mode=following');
    expect(following.body.items.map((p: { id: string }) => p.id)).toContain(postId);

    const forYou = await as(t.app, ada).get('/v1/feed?mode=for_you');
    const item = forYou.body.items.find((p: { id: string }) => p.id === postId);
    expect(item).toBeTruthy();
    expect(item.reason).toMatch(/You follow Ben/);

    const why = await as(t.app, ada).get(`/v1/posts/${postId}/why`);
    expect(why.body.reasons.join(' ')).toMatch(/follow Ben/);
  });

  it('likes and comments, notifying the author', async () => {
    const post = (await as(t.app, ben).post('/v1/posts', { body: 'Second post' })).body.post;
    const like = await as(t.app, ada).put(`/v1/posts/${post.id}/reaction`, { kind: 'like' });
    expect(like.body).toEqual({ liked: true, likes: 1 });
    // Liking twice is idempotent.
    expect((await as(t.app, ada).put(`/v1/posts/${post.id}/reaction`, { kind: 'like' })).body.likes).toBe(1);

    const comment = await as(t.app, ada).post(`/v1/posts/${post.id}/comments`, { body: 'Nice one' });
    expect(comment.status).toBe(201);
    const list = await as(t.app, cy).get(`/v1/posts/${post.id}/comments`);
    expect(list.body.items[0].body).toBe('Nice one');

    const reloaded = await as(t.app, ada).get(`/v1/posts/${post.id}`);
    expect(reloaded.body.post.counts).toEqual({ likes: 1, comments: 1 });
    expect(reloaded.body.post.viewer.liked).toBe(true);

    const notes = await as(t.app, ben).get('/v1/notifications');
    const types = notes.body.items.map((n: { type: string }) => n.type);
    expect(types).toEqual(expect.arrayContaining(['follow', 'post_reaction', 'post_comment']));
    expect(notes.body.unread).toBeGreaterThanOrEqual(3);
  });

  it('enforces post visibility on the server', async () => {
    const friendsOnly = (await as(t.app, ben).post('/v1/posts', { body: 'Friends only', visibility: 'friends' })).body.post;
    const privatePost = (await as(t.app, ben).post('/v1/posts', { body: 'Just me', visibility: 'private' })).body.post;
    expect((await as(t.app, ada).get(`/v1/posts/${friendsOnly.id}`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/posts/${privatePost.id}`)).status).toBe(404);
    expect((await as(t.app, ben).get(`/v1/posts/${privatePost.id}`)).status).toBe(200);

    // Become friends → the friends-only post opens up.
    expect((await as(t.app, ada).post(`/v1/users/${ben.id}/friend-request`)).body.status).toBe('sent');
    const reqs = await as(t.app, ben).get('/v1/me/friend-requests');
    expect((await as(t.app, ben).post(`/v1/friend-requests/${reqs.body.items[0].id}/accept`)).body.status).toBe('friends');
    expect((await as(t.app, ada).get(`/v1/posts/${friendsOnly.id}`)).status).toBe(200);
    // Nobody else sees it, and it can't be liked by outsiders either.
    expect((await as(t.app, cy).put(`/v1/posts/${friendsOnly.id}/reaction`, {})).status).toBe(404);
  });

  it('messages another user in real time and creates a group', async () => {
    const dm = await as(t.app, ada).post('/v1/conversations', { memberIds: [ben.id] });
    expect(dm.status).toBe(201);
    const convId = dm.body.conversation.id;
    // Asking again returns the same direct conversation.
    expect((await as(t.app, ada).post('/v1/conversations', { memberIds: [ben.id] })).body.conversation.id).toBe(convId);

    const sent = await as(t.app, ada).post(`/v1/conversations/${convId}/messages`, { body: 'Hi Ben!', clientId: 'c-1' });
    expect(sent.status).toBe(201);
    // Client retries with the same clientId don't duplicate.
    await as(t.app, ada).post(`/v1/conversations/${convId}/messages`, { body: 'Hi Ben!', clientId: 'c-1' });
    const msgs = await as(t.app, ben).get(`/v1/conversations/${convId}/messages`);
    expect(msgs.body.items.map((m: { body: string }) => m.body)).toEqual(['Hi Ben!']);

    const inbox = await as(t.app, ben).get('/v1/conversations');
    expect(inbox.body.items[0].unreadCount).toBe(1);
    await as(t.app, ben).post(`/v1/conversations/${convId}/read`);
    expect((await as(t.app, ben).get('/v1/conversations')).body.items[0].unreadCount).toBe(0);

    // Outsiders can't read it.
    expect((await as(t.app, cy).get(`/v1/conversations/${convId}/messages`)).status).toBe(404);

    const group = await as(t.app, ada).post('/v1/conversations', { memberIds: [ben.id, cy.id], title: 'Weekend plans' });
    expect(group.body.conversation.kind).toBe('group');
    expect(group.body.conversation.members).toHaveLength(3);

    const summary = await as(t.app, ada).post('/v1/ai/assist', { task: 'summarize_conversation', conversationId: convId });
    expect(summary.status).toBe(200);
    expect(summary.body.contextScopes).toEqual([`conversation:${convId}`]);
    // AI can't read conversations you're not in.
    expect((await as(t.app, cy).post('/v1/ai/assist', { task: 'summarize_conversation', conversationId: convId })).status).toBe(404);
  });

  it('creates a community, joins it and posts inside', async () => {
    const created = await as(t.app, ada).post('/v1/communities', { name: 'Test Makers', slug: `makers-${Date.now().toString(36)}`, topics: ['technology'] });
    expect(created.status).toBe(201);
    const slug = created.body.community.slug;
    expect(created.body.community.myRole).toBe('owner');

    expect((await as(t.app, cy).post('/v1/posts', { body: 'sneaky', communityId: created.body.community.id })).status).toBe(403);
    expect((await as(t.app, cy).post(`/v1/communities/${slug}/join`)).body.status).toBe('active');
    expect((await as(t.app, cy).post('/v1/posts', { body: 'Glad to be here', communityId: created.body.community.id })).status).toBe(201);

    const posts = await as(t.app, null).get(`/v1/communities/${slug}/posts`);
    expect(posts.body.items[0].body).toBe('Glad to be here');
    const detail = await as(t.app, cy).get(`/v1/communities/${slug}`);
    expect(detail.body.community.memberCount).toBe(2);
    expect(detail.body.chatConversationId).toBeTruthy();

    // A member can't promote themselves.
    expect((await as(t.app, cy).put(`/v1/communities/${slug}/members/${cy.id}/role`, { role: 'admin' })).status).toBe(403);
    expect((await as(t.app, ada).put(`/v1/communities/${slug}/members/${cy.id}/role`, { role: 'moderator' })).body.role).toBe('moderator');

    const feed = await as(t.app, cy).get('/v1/feed?mode=communities');
    expect(feed.body.items.some((p: { body: string }) => p.body === 'Glad to be here')).toBe(true);
  });

  it('discovers people, communities and events through search', async () => {
    const res = await as(t.app, cy).get(`/v1/search?q=${encodeURIComponent('Ben')}&type=people`);
    expect(res.body.results.people.some((u: { id: string }) => u.id === ben.id)).toBe(true);
    const nl = await as(t.app, cy).get(`/v1/search?q=${encodeURIComponent('find technology communities')}`);
    expect(nl.body.intent.types).toContain('communities');
    expect(nl.body.results.communities.length).toBeGreaterThan(0);
  });
});

describe('feed explanations', () => {
  it('only says "a community you are in" for communities the viewer joined', async () => {
    const t = await testApp();
    const owner = await signUp(t.app);
    const viewer = await signUp(t.app);
    const slug = `why-${Date.now().toString(36)}`;
    const c = (await as(t.app, owner).post('/v1/communities', { name: 'Why Club', slug })).body.community;
    const post = (await as(t.app, owner).post('/v1/posts', { body: 'Club news', communityId: c.id })).body.post;
    const before = (await as(t.app, viewer).get('/v1/feed?mode=for_you')).body.items.find((p: { id: string }) => p.id === post.id);
    expect(before?.reason ?? '').not.toMatch(/community you're in/);
    await as(t.app, viewer).post(`/v1/communities/${slug}/join`);
    const after = (await as(t.app, viewer).get('/v1/feed?mode=for_you')).body.items.find((p: { id: string }) => p.id === post.id);
    expect(after.reason).toMatch(/community you're in/);
    await t.close();
  });
});
