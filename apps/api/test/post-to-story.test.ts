import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, followAccepted, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const newPost = async (author: TestUser, body: Record<string, unknown>) => {
  const r = await as(t.app, author).post('/v1/posts', body);
  if (r.status >= 300) throw new Error(`post failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.post as { id: string };
};
const addToStory = (who: TestUser, postId: string, body: Record<string, unknown> = {}) => as(t.app, who).post(`/v1/posts/${postId}/story`, body);
const open = async (viewer: TestUser, storyId: string) => (await as(t.app, viewer).get(`/v1/moments/${storyId}`)).body.group?.moments[0];

describe('adding a post to your story', () => {
  it('shows a public post as a card credited to its author, until it is deleted', async () => {
    const author = await adult();
    const sharer = await adult();
    const fan = await adult();
    await followAccepted(t.app, fan, sharer);
    const p = await newPost(author, { body: 'Market day in Lomé\nMore below', visibility: 'public' });

    const r = await addToStory(sharer, p.id, { body: 'Go see this', visibility: 'followers' });
    expect(r.status).toBe(201);
    const storyId = r.body.moment.id as string;

    // The sharer's followers see the post as a card that opens it, with the first line of its caption.
    const seen = await open(fan, storyId);
    expect(seen.body).toBe('Go see this');
    expect(seen.sharedPost).toMatchObject({ id: p.id, available: true, reel: false, caption: 'Market day in Lomé', author: { id: author.id } });
    expect(seen.canReshare).toBe(false);
    expect((await as(t.app, fan).get('/v1/moments')).body.items.some((g: any) => g.moments.some((m: any) => m.id === storyId))).toBe(true);
    // It counts as a share of the post.
    expect((await t.ctx.db.query(`SELECT 1 FROM feed_events WHERE user_id = $1 AND post_id = $2 AND kind = 'share'`, [sharer.id, p.id])).rowCount).toBe(1);

    // Your own post works too.
    const own = await newPost(sharer, { body: 'Mine', visibility: 'public' });
    expect((await addToStory(sharer, own.id)).status).toBe(201);

    // Deleted, the story stays but the card says the post isn't available.
    await as(t.app, author).del(`/v1/posts/${p.id}`);
    expect((await open(fan, storyId)).sharedPost).toEqual({ id: p.id, available: false });
    expect((await addToStory(fan, p.id)).status).toBe(404);
  });

  it('closes the card once the post is no longer public, and for people blocked by its author', async () => {
    const author = await adult();
    const sharer = await adult();
    const fan = await adult();
    const blocked = await adult();
    await followAccepted(t.app, fan, sharer);
    await followAccepted(t.app, blocked, sharer);
    const p = await newPost(author, { body: 'Public for now', visibility: 'public' });
    const storyId = (await addToStory(sharer, p.id, { visibility: 'followers' })).body.moment.id as string;

    await as(t.app, author).post(`/v1/users/${blocked.id}/block`);
    expect((await open(blocked, storyId)).sharedPost).toEqual({ id: p.id, available: false });
    expect((await open(fan, storyId)).sharedPost).toMatchObject({ id: p.id, available: true });

    await t.ctx.db.query(`UPDATE posts SET visibility = 'followers' WHERE id = $1`, [p.id]);
    expect((await open(fan, storyId)).sharedPost).toEqual({ id: p.id, available: false });
  });

  it('refuses posts that are not public, from private accounts, or between people who blocked each other', async () => {
    const author = await adult();
    const sharer = await adult();
    await followAccepted(t.app, sharer, author);

    const followersOnly = await newPost(author, { body: 'Just followers', visibility: 'followers' });
    const denied = await addToStory(sharer, followersOnly.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('share_not_allowed');

    // A private account's posts stay with the people it approved, even "public" ones.
    const shy = await adult();
    await as(t.app, shy).patch('/v1/me/profile', { isPrivate: true });
    await followAccepted(t.app, sharer, shy);
    const shyPost = await newPost(shy, { body: 'Mine to share', visibility: 'public' });
    expect((await addToStory(sharer, shyPost.id)).body.error.code).toBe('share_not_allowed');
    // Its owner can still add it to their own story, unless moderation limited it.
    expect((await addToStory(shy, shyPost.id)).status).toBe(201);
    await t.ctx.db.query(`UPDATE posts SET moderation_status = 'restricted' WHERE id = $1`, [shyPost.id]);
    expect((await addToStory(shy, shyPost.id)).body.error.code).toBe('share_not_allowed');

    // Blocks go both ways.
    const p = await newPost(author, { body: 'Public', visibility: 'public' });
    await as(t.app, author).post(`/v1/users/${sharer.id}/block`);
    expect((await addToStory(sharer, p.id)).status).toBe(404);
    const other = await adult();
    const q = await newPost(other, { body: 'Public too', visibility: 'public' });
    await as(t.app, sharer).post(`/v1/users/${other.id}/block`);
    expect((await addToStory(sharer, q.id)).status).toBe(404);

    // Signed out, and posts that don't exist.
    expect((await as(t.app, null).post(`/v1/posts/${p.id}/story`, {})).status).toBe(401);
    expect((await addToStory(author, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
