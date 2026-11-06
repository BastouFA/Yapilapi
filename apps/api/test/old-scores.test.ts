import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * Scores fade with time, and Postgres raises an error when a number gets too small to hold, instead
 * of reaching zero. Nothing about a brand-new database shows that: only scores left alone for weeks
 * do, so these tests make them old.
 */
describe('scores left alone for a long time', () => {
  let t: BuiltApp;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(() => t.close());

  // 40 days is too small for the 4-byte numbers ranking used, and 400 days for any number at all.
  for (const days of [40, 400, 20_000]) {
    it(`still loads feeds, reels and comments ${days} days on`, async () => {
      const u = await signUp(t.app, { displayName: 'Old scores' });
      const api = as(t.app, u);
      const post = (await api.post('/v1/posts', { body: 'Old but gold', visibility: 'public', topics: ['music'] })).body.post as { id: string };
      const comment = await api.post(`/v1/posts/${post.id}/comments`, { body: 'First' });
      expect(comment.status).toBe(201);
      const then = `now() - make_interval(days => ${days})`;
      await t.ctx.db.query(
        `INSERT INTO post_stats (post_id, trend, trend_at) VALUES ($1, 1, ${then})
         ON CONFLICT (post_id) DO UPDATE SET trend = 1, trend_at = ${then}`,
        [post.id],
      );
      await t.ctx.db.query(`UPDATE comments SET created_at = ${then} WHERE post_id = $1`, [post.id]);
      await t.ctx.db.query(`INSERT INTO user_topic_affinity (user_id, topic, score, updated_at) VALUES ($1, 'music', 1, ${then})`, [u.id]);

      const feed = await api.get('/v1/feed?mode=for_you&limit=50');
      expect(feed.status).toBe(200);
      expect(feed.body.items.some((p: { id: string }) => p.id === post.id)).toBe(true);
      expect((await api.get('/v1/reels')).status).toBe(200);
      expect((await api.get(`/v1/posts/${post.id}`)).status).toBe(200);
      expect((await api.get(`/v1/posts/${post.id}/comments?sort=top`)).status).toBe(200);
      // And adding to an old score works too.
      expect((await api.put(`/v1/posts/${post.id}/reaction`, { kind: 'like' })).status).toBeLessThan(300);
    });
  }
});
