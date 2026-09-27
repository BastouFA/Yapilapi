import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

describe('who reposted', () => {
  it('lists reposters to people who can see the post, hiding blocked people and private accounts they do not follow', async () => {
    const adult = { birthDate: '1990-01-01' };
    const author = await signUp(t.app, adult);
    const open = await signUp(t.app, adult);
    const quiet = await signUp(t.app, adult);
    const viewer = await signUp(t.app, adult);
    const blocker = await signUp(t.app, adult);

    const post = (await as(t.app, author).post('/v1/posts', { body: 'Worth sharing' })).body.post;
    await as(t.app, quiet).patch('/v1/me/profile', { isPrivate: true });
    for (const u of [open, quiet, blocker]) expect((await as(t.app, u).put(`/v1/posts/${post.id}/repost`)).status).toBe(200);
    await as(t.app, blocker).post(`/v1/users/${viewer.id}/block`);

    const names = async (who: typeof viewer | null) =>
      ((await as(t.app, who).get(`/v1/posts/${post.id}/reposters`)).body.items as { id: string }[]).map((u) => u.id);

    // The author sees the public reposter and the blocker, not the private account they don't follow.
    expect(new Set(await names(author))).toEqual(new Set([open.id, blocker.id]));
    // Someone blocked by a reposter doesn't see them.
    expect(await names(viewer)).toEqual([open.id]);
    // A private account appears to itself.
    expect(await names(quiet)).toContain(quiet.id);
    // Signed out: only public, non-private reposters.
    expect(new Set(await names(null))).toEqual(new Set([open.id, blocker.id]));
  });

  it("is refused for a post the viewer can't see", async () => {
    const author = await signUp(t.app, { birthDate: '1990-01-01' });
    const stranger = await signUp(t.app, { birthDate: '1990-01-01' });
    const hidden = (await as(t.app, author).post('/v1/posts', { body: 'Only me', visibility: 'private' })).body.post;
    expect((await as(t.app, stranger).get(`/v1/posts/${hidden.id}/reposters`)).status).toBe(404);
  });
});
