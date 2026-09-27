import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { hasHiddenWord } from '../src/lib/comments.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const postBy = async (u: TestUser, extra: Record<string, unknown> = {}) =>
  (await as(t.app, u).post('/v1/posts', { body: 'Morning market run', ...extra })).body.post as { id: string; commentPolicy: string; viewer: any };
const comment = async (u: TestUser, postId: string, body: string, parentId?: string) => as(t.app, u).post(`/v1/posts/${postId}/comments`, { body, parentId });
const list = async (u: TestUser | null, postId: string, query = '') => (await as(t.app, u).get(`/v1/posts/${postId}/comments${query}`)).body;
const count = async (postId: string) => (await t.ctx.db.query(`SELECT comment_count FROM posts WHERE id = $1`, [postId])).rows[0].comment_count as number;
const notes = async (userId: string, type: string) =>
  (await t.ctx.db.query(`SELECT actor_id, data FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [userId, type])).rows;

describe('threads', () => {
  it('keeps one level of nesting, lists replies per thread and tells the person answered', async () => {
    const author = await adult();
    const ada = await adult();
    const bola = await adult();
    const cy = await adult();
    const post = await postBy(author);
    const top = (await comment(ada, post.id, 'Those tomatoes look great')).body.comment;
    expect(top).toMatchObject({ parentId: null, replyToId: null, likes: 0, replies: 0, pinned: false, editedAt: null });

    const r1 = await comment(bola, post.id, `@${ada.username} where from`, top.id);
    expect(r1.status).toBe(201);
    expect(r1.body.comment).toMatchObject({ parentId: top.id, replyToId: top.id });
    // A reply to a reply joins the top-level thread and remembers whom it answered.
    const r2 = (await comment(ada, post.id, `@${bola.username} the corner stall`, r1.body.comment.id)).body.comment;
    expect(r2).toMatchObject({ parentId: top.id, replyToId: r1.body.comment.id });

    const page = await list(cy, post.id);
    expect(page.items.map((c: any) => c.id)).toEqual([top.id]);
    expect(page.items[0].replies).toBe(2);
    const replies = (await as(t.app, cy).get(`/v1/comments/${top.id}/replies`)).body.items;
    expect(replies.map((c: any) => c.id)).toEqual([r1.body.comment.id, r2.id]);
    expect(await count(post.id)).toBe(3);

    // Bola is told Ada answered; Ada is told about Bola's reply (not also as a mention).
    expect((await notes(bola.id, 'comment_reply')).length).toBe(1);
    expect((await notes(ada.id, 'comment_reply')).length).toBe(1);
    expect((await notes(ada.id, 'comment_mention')).length).toBe(0);

    // More replies to Ada's comment collapse into one notification.
    await comment(cy, post.id, 'Same, love that stall', top.id);
    const batched = await notes(ada.id, 'comment_reply');
    expect(batched).toHaveLength(1);
    expect(batched[0].data.count).toBe(2);
    expect(batched[0].actor_id).toBe(cy.id);

    // Replies to the post author's comment don't also count as a new comment notification for them.
    const own = (await comment(author, post.id, 'Thanks all')).body.comment;
    const before = (await notes(author.id, 'post_comment')).length;
    await comment(bola, post.id, 'Anytime', own.id);
    expect((await notes(author.id, 'post_comment')).length).toBe(before);
    expect((await notes(author.id, 'comment_reply')).length).toBe(1);

    // Removing a top-level comment removes its thread from the count.
    expect((await as(t.app, ada).del(`/v1/comments/${top.id}`)).body.comments).toBe(2);
    expect((await as(t.app, cy).get(`/v1/comments/${top.id}/replies`)).status).toBe(404);
  });
});

describe('likes', () => {
  it('toggles, counts, marks the author’s like, batches notifications and shows likers only to the writer', async () => {
    const author = await adult();
    const writer = await adult();
    const fans = [await adult(), await adult(), await adult()];
    const post = await postBy(author);
    const c = (await comment(writer, post.id, 'Best post this week')).body.comment;

    for (const f of fans) expect((await as(t.app, f).put(`/v1/comments/${c.id}/like`)).body).toMatchObject({ liked: true });
    // Liking twice counts once.
    expect((await as(t.app, fans[0]!).put(`/v1/comments/${c.id}/like`)).body.likes).toBe(3);
    expect((await as(t.app, fans[0]!).del(`/v1/comments/${c.id}/like`)).body).toEqual({ liked: false, likes: 2 });
    await as(t.app, fans[0]!).put(`/v1/comments/${c.id}/like`);

    const liked = await notes(writer.id, 'comment_like');
    expect(liked).toHaveLength(1);
    expect(liked[0].data).toMatchObject({ commentId: c.id, count: 3 });

    let seen = (await list(fans[1]!, post.id)).items[0];
    expect(seen).toMatchObject({ likes: 3, likedByAuthor: false, viewer: { liked: true, canEdit: false, canDelete: false } });
    await as(t.app, author).put(`/v1/comments/${c.id}/like`);
    seen = (await list(fans[1]!, post.id)).items[0];
    expect(seen).toMatchObject({ likes: 4, likedByAuthor: true });

    // Only the writer sees who liked it.
    const likers = await as(t.app, writer).get(`/v1/comments/${c.id}/likes`);
    expect(likers.status).toBe(200);
    expect(likers.body.items.map((u: any) => u.id).sort()).toEqual([author.id, ...fans.map((f) => f.id)].sort());
    expect((await as(t.app, fans[1]!).get(`/v1/comments/${c.id}/likes`)).status).toBe(403);
    expect((await as(t.app, author).get(`/v1/comments/${c.id}/likes`)).status).toBe(403);
    expect((await as(t.app, null).put(`/v1/comments/${c.id}/like`)).status).toBe(401);
  });
});

describe('blocks and minors', () => {
  it('keeps blocked people from commenting, replying and liking', async () => {
    const author = await adult();
    const writer = await adult();
    const blockedByAuthor = await adult();
    const blockedByWriter = await adult();
    const post = await postBy(author);
    const c = (await comment(writer, post.id, 'Lovely light here')).body.comment;
    await as(t.app, author).post(`/v1/users/${blockedByAuthor.id}/block`);
    await as(t.app, writer).post(`/v1/users/${blockedByWriter.id}/block`);

    expect((await comment(blockedByAuthor, post.id, 'Hello')).status).toBe(404);
    expect((await as(t.app, blockedByAuthor).put(`/v1/comments/${c.id}/like`)).status).toBe(404);
    // Someone the writer blocked can still comment on the post, but can't see, answer or like the writer's comment.
    expect((await comment(blockedByWriter, post.id, 'Hello')).status).toBe(201);
    expect((await comment(blockedByWriter, post.id, 'Hi', c.id)).status).toBe(404);
    expect((await as(t.app, blockedByWriter).put(`/v1/comments/${c.id}/like`)).status).toBe(404);
    expect((await list(blockedByWriter, post.id)).items.map((x: any) => x.author.id)).not.toContain(writer.id);
  });

  it('follows the minor rule for mentions in comments and replies', async () => {
    const author = await adult();
    const grownUp = await adult();
    const teen = await signUp(t.app, { birthDate: '2011-03-01' });
    const post = await postBy(author);
    await comment(grownUp, post.id, `Look @${teen.username}`);
    expect(await notes(teen.id, 'comment_mention')).toHaveLength(0);
    const c = (await comment(grownUp, post.id, 'Great spot')).body.comment;
    // Editing a mention in doesn't get around it either.
    await as(t.app, grownUp).patch(`/v1/comments/${c.id}`, { body: `Great spot @${teen.username}` });
    expect(await notes(teen.id, 'comment_mention')).toHaveLength(0);
  });
});

describe('pinning', () => {
  it('lets only the post author pin one top-level comment, shown first', async () => {
    const author = await adult();
    const ada = await adult();
    const bola = await adult();
    const post = await postBy(author);
    const first = (await comment(ada, post.id, 'First')).body.comment;
    const second = (await comment(bola, post.id, 'Second')).body.comment;
    const reply = (await comment(bola, post.id, 'A reply', first.id)).body.comment;

    expect((await as(t.app, ada).put(`/v1/posts/${post.id}/pinned-comment`, { commentId: first.id })).status).toBe(403);
    expect((await as(t.app, author).put(`/v1/posts/${post.id}/pinned-comment`, { commentId: reply.id })).status).toBe(400);
    const other = await postBy(author);
    expect((await as(t.app, author).put(`/v1/posts/${other.id}/pinned-comment`, { commentId: first.id })).status).toBe(404);

    expect((await as(t.app, author).put(`/v1/posts/${post.id}/pinned-comment`, { commentId: first.id })).body).toEqual({ pinnedCommentId: first.id });
    for (const sort of ['top', 'newest']) {
      const items = (await list(bola, post.id, `?sort=${sort}`)).items;
      expect(items[0]).toMatchObject({ id: first.id, pinned: true });
      expect(items.filter((c: any) => c.id === first.id)).toHaveLength(1);
    }
    // Pinning another replaces it.
    await as(t.app, author).put(`/v1/posts/${post.id}/pinned-comment`, { commentId: second.id });
    expect((await list(ada, post.id)).items.filter((c: any) => c.pinned).map((c: any) => c.id)).toEqual([second.id]);

    expect((await as(t.app, ada).del(`/v1/posts/${post.id}/pinned-comment`)).status).toBe(403);
    expect((await as(t.app, author).del(`/v1/posts/${post.id}/pinned-comment`)).body).toEqual({ pinnedCommentId: null });
    expect((await list(ada, post.id)).items.some((c: any) => c.pinned)).toBe(false);

    // A removed comment stops being pinned.
    await as(t.app, author).put(`/v1/posts/${post.id}/pinned-comment`, { commentId: first.id });
    await as(t.app, ada).del(`/v1/comments/${first.id}`);
    expect((await t.ctx.db.query(`SELECT pinned_comment_id FROM posts WHERE id = $1`, [post.id])).rows[0].pinned_comment_id).toBeNull();
  });
});

describe('sorting', () => {
  it('orders Top by likes, the author’s like, replies and freshness, and Newest by time', async () => {
    const author = await adult();
    const people = await Promise.all([adult(), adult(), adult(), adult()]);
    const post = await postBy(author);
    const old = (await comment(people[0]!, post.id, 'An older comment with likes')).body.comment;
    const quiet = (await comment(people[1]!, post.id, 'A quiet comment')).body.comment;
    const replied = (await comment(people[2]!, post.id, 'A comment people answered')).body.comment;
    const fresh = (await comment(people[3]!, post.id, 'The newest comment')).body.comment;
    // Make the first three older, so freshness alone doesn't decide.
    await t.ctx.db.query(`UPDATE comments SET created_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])`, [[old.id, quiet.id, replied.id]]);
    for (const p of people) await as(t.app, p).put(`/v1/comments/${old.id}/like`);
    await comment(people[0]!, post.id, 'Answer one', replied.id);
    await comment(people[1]!, post.id, 'Answer two', replied.id);
    await as(t.app, author).put(`/v1/comments/${quiet.id}/like`);

    const top = (await list(people[0]!, post.id, '?sort=top')).items.map((c: any) => c.id);
    expect(top[0]).toBe(old.id);
    expect(top.indexOf(quiet.id)).toBeLessThan(top.indexOf(replied.id)); // the author's like counts for more than two replies
    expect(top).toHaveLength(4);
    // Default is Top.
    expect((await list(people[0]!, post.id)).items.map((c: any) => c.id)).toEqual(top);

    const newest = (await list(people[0]!, post.id, '?sort=newest')).items.map((c: any) => c.id);
    expect(newest[0]).toBe(fresh.id);

    // Paging never repeats or skips.
    for (const sort of ['top', 'newest']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: any = await list(people[0]!, post.id, `?sort=${sort}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        seen.push(...page.items.map((c: any) => c.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(sort === 'top' ? top : newest);
    }
  });
});

describe('editing', () => {
  it('lets the writer edit within 15 minutes, with the same checks and only new mentions told', async () => {
    const author = await adult();
    const writer = await adult();
    const other = await adult();
    const ada = await adult();
    const bola = await adult();
    const post = await postBy(author);
    const c = (await comment(writer, post.id, `Hi @${ada.username}`)).body.comment;
    expect(c.viewer.canEdit).toBe(true);
    expect(await notes(ada.id, 'comment_mention')).toHaveLength(1);

    expect((await as(t.app, other).patch(`/v1/comments/${c.id}`, { body: 'Mine now' })).status).toBe(403);
    expect((await as(t.app, author).patch(`/v1/comments/${c.id}`, { body: 'Mine now' })).status).toBe(403);
    const edited = await as(t.app, writer).patch(`/v1/comments/${c.id}`, { body: `Hi @${ada.username} and @${bola.username}` });
    expect(edited.status).toBe(200);
    expect(edited.body.comment.body).toBe(`Hi @${ada.username} and @${bola.username}`);
    expect(edited.body.comment.editedAt).toEqual(expect.any(String));
    expect(await notes(ada.id, 'comment_mention')).toHaveLength(1);
    expect(await notes(bola.id, 'comment_mention')).toHaveLength(1);
    // Dropping a mention and adding it back doesn't tell them again.
    await as(t.app, writer).patch(`/v1/comments/${c.id}`, { body: 'Hi all' });
    await as(t.app, writer).patch(`/v1/comments/${c.id}`, { body: `Hi @${ada.username}` });
    expect(await notes(ada.id, 'comment_mention')).toHaveLength(1);

    // The same safety checks as a new comment.
    expect((await as(t.app, writer).patch(`/v1/comments/${c.id}`, { body: '' })).status).toBe(400);

    // After 15 minutes it's final.
    await t.ctx.db.query(`UPDATE comments SET created_at = now() - interval '16 minutes' WHERE id = $1`, [c.id]);
    const late = await as(t.app, writer).patch(`/v1/comments/${c.id}`, { body: 'Too late' });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe('edit_window_closed');
    expect((await list(writer, post.id)).items[0]).toMatchObject({ viewer: { canEdit: false, canDelete: true } });
  });
});

describe('comment controls', () => {
  it('lets the author choose who can comment, and defaults to everyone', async () => {
    const author = await adult();
    const follower = await adult();
    const followed = await adult();
    const stranger = await adult();
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);
    await as(t.app, author).post(`/v1/users/${followed.id}/follow`);

    const post = await postBy(author);
    expect(post.commentPolicy).toBe('everyone');
    expect((await comment(stranger, post.id, 'Hello')).status).toBe(201);

    expect((await as(t.app, stranger).put(`/v1/posts/${post.id}/comment-settings`, { policy: 'off' })).status).toBe(403);
    expect((await as(t.app, author).put(`/v1/posts/${post.id}/comment-settings`, { policy: 'nobody' })).status).toBe(400);

    const tryAll = async () => ({
      author: (await comment(author, post.id, 'x')).status,
      follower: (await comment(follower, post.id, 'x')).status,
      followed: (await comment(followed, post.id, 'x')).status,
      stranger: (await comment(stranger, post.id, 'x')).status,
    });
    await as(t.app, author).put(`/v1/posts/${post.id}/comment-settings`, { policy: 'followers' });
    expect(await tryAll()).toEqual({ author: 201, follower: 201, followed: 403, stranger: 403 });
    await as(t.app, author).put(`/v1/posts/${post.id}/comment-settings`, { policy: 'following' });
    expect(await tryAll()).toEqual({ author: 201, follower: 403, followed: 201, stranger: 403 });
    await as(t.app, author).put(`/v1/posts/${post.id}/comment-settings`, { policy: 'off' });
    expect(await tryAll()).toEqual({ author: 403, follower: 403, followed: 403, stranger: 403 });
    const closed = await comment(stranger, post.id, 'x');
    expect(closed.body.error.code).toBe('comments_closed');

    // The post and the comment list say whether you can comment.
    const page = await list(stranger, post.id);
    expect(page).toMatchObject({ commentPolicy: 'off', canComment: false, isPostAuthor: false });
    expect((await as(t.app, stranger).get(`/v1/posts/${post.id}`)).body.post.viewer.canComment).toBe(false);
    expect((await list(null, post.id)).canComment).toBe(false);

    // Chosen when sharing.
    const followersOnly = await postBy(author, { commentPolicy: 'followers' });
    expect(followersOnly.commentPolicy).toBe('followers');
    expect((await as(t.app, follower).get(`/v1/posts/${followersOnly.id}`)).body.post.viewer.canComment).toBe(true);
    expect((await comment(stranger, followersOnly.id, 'x')).status).toBe(403);
  });
});

describe('hidden words', () => {
  it('matches whole words and phrases', () => {
    expect(hasHiddenWord('What a CLASS act', ['ass'])).toBe(false);
    expect(hasHiddenWord('What an #Ass', ['ass'])).toBe(true);
    expect(hasHiddenWord('Buy  cheap   followers now', ['cheap followers'])).toBe(true);
    expect(hasHiddenWord('Nothing to see', [])).toBe(false);
  });

  it('hides matching comments from everyone but the writer, and lets the author review them', async () => {
    const author = await adult();
    const writer = await adult();
    const viewer = await adult();
    const post = await postBy(author);
    const earlier = (await comment(writer, post.id, 'Total spoiler inside')).body.comment;
    expect(await count(post.id)).toBe(1);

    expect((await as(t.app, author).put('/v1/me/hidden-words', { words: Array.from({ length: 101 }, (_, i) => `w${i}`) })).status).toBe(400);
    const saved = await as(t.app, author).put('/v1/me/hidden-words', { words: ['Spoiler', 'spoiler', '  giveaway  link '] });
    expect(saved.body.words.sort()).toEqual(['giveaway link', 'spoiler']);
    expect((await as(t.app, author).get('/v1/me/hidden-words')).body.words.sort()).toEqual(['giveaway link', 'spoiler']);
    // Comments already there are checked again.
    expect(await count(post.id)).toBe(0);

    const hidden = (await comment(writer, post.id, 'Click my GIVEAWAY link')).body.comment;
    const fine = (await comment(writer, post.id, 'Nice photo')).body.comment;
    // The post author's own comments are never hidden by their own words.
    await comment(author, post.id, 'No spoiler please');
    expect(await count(post.id)).toBe(2);
    expect((await list(viewer, post.id)).items.map((c: any) => c.id)).not.toContain(hidden.id);
    expect((await list(writer, post.id)).items.map((c: any) => c.id)).toEqual(expect.arrayContaining([hidden.id, earlier.id, fine.id]));
    expect((await list(null, post.id)).items.map((c: any) => c.id)).not.toContain(hidden.id);
    // Hidden comments notify no one and can't be liked.
    expect((await as(t.app, viewer).put(`/v1/comments/${hidden.id}/like`)).status).toBe(404);

    const authorView = await list(author, post.id);
    expect(authorView).toMatchObject({ isPostAuthor: true, hiddenCount: 2 });
    expect(authorView.items.map((c: any) => c.id)).not.toContain(hidden.id);
    expect((await as(t.app, viewer).get(`/v1/posts/${post.id}/comments/hidden`)).status).toBe(403);
    const review = (await as(t.app, author).get(`/v1/posts/${post.id}/comments/hidden`)).body.items;
    expect(review.map((c: any) => [c.id, c.hidden])).toEqual([
      [hidden.id, true],
      [earlier.id, true],
    ]);
    expect((await list(viewer, post.id)).hiddenCount).toBeUndefined();

    expect((await as(t.app, viewer).post(`/v1/comments/${hidden.id}/unhide`)).status).toBe(403);
    expect((await as(t.app, author).post(`/v1/comments/${hidden.id}/unhide`)).status).toBe(200);
    expect((await list(viewer, post.id)).items.map((c: any) => c.id)).toContain(hidden.id);
    expect(await count(post.id)).toBe(3);
    // Let through once, it stays: saving the words again doesn't hide it.
    await as(t.app, author).put('/v1/me/hidden-words', { words: ['spoiler', 'giveaway link'] });
    expect((await list(viewer, post.id)).items.map((c: any) => c.id)).toContain(hidden.id);

    // Editing into a hidden word hides it; removing the word brings the earlier one back.
    await as(t.app, writer).patch(`/v1/comments/${fine.id}`, { body: 'Nice photo, spoiler: rain' });
    expect((await list(viewer, post.id)).items.map((c: any) => c.id)).not.toContain(fine.id);
    await as(t.app, author).put('/v1/me/hidden-words', { words: [] });
    const back = (await list(viewer, post.id)).items.map((c: any) => c.id);
    expect(back).toEqual(expect.arrayContaining([earlier.id, fine.id, hidden.id]));
    expect(await count(post.id)).toBe(4);
  });
});

describe('counts', () => {
  it('leave out removed comments', async () => {
    const author = await adult();
    const writer = await adult();
    const post = await postBy(author);
    const a = (await comment(writer, post.id, 'One')).body.comment;
    await comment(writer, post.id, 'Two');
    expect(await count(post.id)).toBe(2);
    // The post author can remove any comment on their post; others can't.
    expect((await as(t.app, await adult()).del(`/v1/comments/${a.id}`)).status).toBe(404);
    expect((await as(t.app, author).del(`/v1/comments/${a.id}`)).body.comments).toBe(1);
    expect((await as(t.app, writer).get(`/v1/posts/${post.id}`)).body.post.counts.comments).toBe(1);
  });
});

describe('translation', () => {
  it('detects the language on create and edit, forgets translations on edit and hide, and never translates a hidden comment for others', async () => {
    const author = await adult();
    const writer = await adult();
    const reader = await adult();
    const post = await postBy(author);
    const translations = async (id: string) =>
      Number((await t.ctx.db.query(`SELECT count(*) AS n FROM translations WHERE kind = 'comment' AND item_id = $1`, [id])).rows[0].n);
    const cache = (id: string) =>
      t.ctx.db.query(
        `INSERT INTO translations (kind, item_id, target, content_hash, source_lang, body, provider, model) VALUES ('comment', $1, 'en', 'h', 'fr', 'x', 'dev', 'dev')`,
        [id],
      );

    const c = (await comment(writer, post.id, 'Bonjour à tous, quelle belle journée à la plage avec mes amis')).body.comment;
    expect(c.lang).toBe('fr');
    expect((await list(reader, post.id)).items[0].lang).toBe('fr');

    await cache(c.id);
    const edited = (await as(t.app, writer).patch(`/v1/comments/${c.id}`, { body: 'Hola a todos, qué día tan bonito en la playa' })).body.comment;
    expect(edited.lang).toBe('es');
    expect(await translations(c.id)).toBe(0);

    // Hidden by the author's hidden words: its translations go, and others can't ask for one.
    await cache(c.id);
    await as(t.app, author).put('/v1/me/hidden-words', { words: ['playa'] });
    expect(await translations(c.id)).toBe(0);
    expect((await as(t.app, reader).post('/v1/translate', { kind: 'comment', id: c.id, target: 'en' })).status).toBe(404);
  });
});
