import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

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

async function post(author: TestUser, body: string, extra: Record<string, unknown> = {}) {
  const r = await as(t.app, author).post('/v1/posts', { body, ...extra });
  expect(r.status).toBe(201);
  return r.body.post.id as string;
}

async function photoPost(author: TestUser, body: string) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, moderation) VALUES ($1,'image','http://localhost:4000/media/board-cover.jpg','image/jpeg','ready','ok') RETURNING id`,
    [author.id],
  );
  const id = await post(author, body);
  await t.ctx.db.query(`INSERT INTO post_media (post_id, media_id, position) VALUES ($1,$2,0)`, [id, rows[0].id]);
  await t.ctx.db.query(`UPDATE posts SET kind = 'photo' WHERE id = $1`, [id]);
  return id;
}

async function mutual(a: TestUser, b: TestUser) {
  await as(t.app, a).post(`/v1/users/${b.id}/follow`);
  await as(t.app, b).post(`/v1/users/${a.id}/follow`);
}

async function board(owner: TestUser, body: Record<string, unknown>) {
  const r = await as(t.app, owner).post('/v1/boards', body);
  expect(r.status).toBe(201);
  return r.body.board as { id: string; [k: string]: any };
}

const ids = (r: { body: any }) => (r.body.items as { id: string }[]).map((x) => x.id);

describe('saved page', () => {
  it('lists saves newest first with filters and private notes', async () => {
    const author = await adult();
    const me = await adult();
    const other = await adult();
    const text = await post(author, 'Just words');
    const photo = await photoPost(author, 'A picture');
    for (const id of [text, photo]) expect((await as(t.app, me).put(`/v1/posts/${id}/save`)).status).toBe(200);

    const all = await as(t.app, me).get('/v1/me/saved');
    expect(all.status).toBe(200);
    expect(ids(all)).toEqual([photo, text]);
    expect(ids(await as(t.app, me).get('/v1/me/saved?filter=photos'))).toEqual([photo]);
    expect(ids(await as(t.app, me).get('/v1/me/saved?filter=text'))).toEqual([text]);
    expect(ids(await as(t.app, me).get('/v1/me/saved?filter=videos'))).toEqual([]);
    expect((await as(t.app, me).get('/v1/me/saved?filter=gifs')).status).toBe(400);

    // Paging.
    const first = await as(t.app, me).get('/v1/me/saved?limit=1');
    expect(ids(first)).toEqual([photo]);
    expect(ids(await as(t.app, me).get(`/v1/me/saved?limit=1&cursor=${first.body.nextCursor}`))).toEqual([text]);

    // A note is only ever yours.
    const note = await as(t.app, me).put(`/v1/posts/${text}/save/note`, { note: 'Try this recipe on Sunday' });
    expect(note.body).toEqual({ saved: true, note: 'Try this recipe on Sunday' });
    expect((await as(t.app, me).get('/v1/me/saved')).body.items.find((p: any) => p.id === text).viewer.note).toBe('Try this recipe on Sunday');
    expect((await as(t.app, me).get(`/v1/posts/${text}/save`)).body).toMatchObject({ saved: true, note: 'Try this recipe on Sunday' });
    expect((await as(t.app, me).put(`/v1/posts/${text}/save/note`, { note: 'x'.repeat(281) })).status).toBe(400);
    expect((await as(t.app, null).put(`/v1/posts/${text}/save/note`, { note: 'hi' })).status).toBe(401);
    expect((await as(t.app, null).get('/v1/me/saved')).status).toBe(401);
    // Someone else sees neither the note on the post nor on their own save of it.
    await as(t.app, other).put(`/v1/posts/${text}/save`);
    const theirs = await as(t.app, other).get('/v1/me/saved');
    expect(theirs.body.items.find((p: any) => p.id === text).viewer.note).toBeUndefined();
    expect(JSON.stringify(theirs.body)).not.toContain('Sunday');
    expect(JSON.stringify((await as(t.app, other).get(`/v1/posts/${text}`)).body)).not.toContain('Sunday');
    expect((await as(t.app, other).get(`/v1/posts/${text}/save`)).body.note).toBe('');
    // Clearing.
    await as(t.app, me).put(`/v1/posts/${text}/save/note`, { note: '' });
    expect((await as(t.app, me).get('/v1/me/saved')).body.items.find((p: any) => p.id === text).viewer.note).toBeUndefined();
    // A note on a post you can't see is refused.
    const hidden = await post(author, 'Only me', { visibility: 'private' });
    expect((await as(t.app, me).put(`/v1/posts/${hidden}/save/note`, { note: 'hi' })).status).toBe(404);
  });
});

describe('boards', () => {
  it('creates, renames, reorders, removes and deletes, keeping the saves', async () => {
    const author = await adult();
    const me = await adult();
    const [a, b, c] = [await post(author, 'One'), await post(author, 'Two'), await photoPost(author, 'Three')];
    const trip = await board(me, { name: 'Trip to Accra', description: 'Places to eat', postIds: [a] });
    expect(trip).toMatchObject({ name: 'Trip to Accra', visibility: 'private', role: 'owner', itemCount: 1, canAdd: true, coverPostId: null });
    expect(trip.cover).toMatchObject({ postId: a, text: 'One', imageUrl: null });
    // Adding saves the post too.
    expect(ids(await as(t.app, me).get('/v1/me/saved'))).toContain(a);

    expect((await as(t.app, me).post(`/v1/boards/${trip.id}/items`, { postId: b })).status).toBe(201);
    expect((await as(t.app, me).post(`/v1/boards/${trip.id}/items`, { postId: b })).status).toBe(200);
    expect((await as(t.app, me).post(`/v1/boards/${trip.id}/items`, { postId: c })).status).toBe(201);
    // Newest on top; the cover is the first item unless one is chosen.
    expect(ids(await as(t.app, me).get(`/v1/boards/${trip.id}/items`))).toEqual([c, b, a]);
    let got = await as(t.app, me).get(`/v1/boards/${trip.id}`);
    expect(got.body.board).toMatchObject({ itemCount: 3, cover: { postId: c, imageUrl: 'http://localhost:4000/media/board-cover.jpg' } });
    expect(ids(await as(t.app, me).get(`/v1/boards/${trip.id}/items?filter=photos`))).toEqual([c]);
    const page = await as(t.app, me).get(`/v1/boards/${trip.id}/items?limit=2`);
    expect(ids(page)).toEqual([c, b]);
    expect(ids(await as(t.app, me).get(`/v1/boards/${trip.id}/items?limit=2&cursor=${page.body.nextCursor}`))).toEqual([a]);

    // Save to: which boards hold the post.
    const mine = await as(t.app, me).get(`/v1/boards?postId=${a}`);
    expect(mine.body.items.find((x: any) => x.id === trip.id).contains).toBe(true);
    expect((await as(t.app, me).get(`/v1/posts/${a}/save`)).body.boardIds).toEqual([trip.id]);

    // Rename, cover, reorder.
    const renamed = await as(t.app, me).patch(`/v1/boards/${trip.id}`, { name: 'Accra, June', coverPostId: a });
    expect(renamed.body.board).toMatchObject({ name: 'Accra, June', coverPostId: a, cover: { postId: a } });
    expect((await as(t.app, me).patch(`/v1/boards/${trip.id}`, { coverPostId: await post(author, 'Elsewhere') })).status).toBe(400);
    expect((await as(t.app, me).put(`/v1/boards/${trip.id}/order`, { postIds: [a, c, b] })).status).toBe(200);
    expect(ids(await as(t.app, me).get(`/v1/boards/${trip.id}/items`))).toEqual([a, c, b]);
    expect((await as(t.app, me).put(`/v1/boards/${trip.id}/order`, { postIds: [a, c] })).status).toBe(409);

    // Limits and validation.
    expect((await as(t.app, me).post('/v1/boards', { name: 'x'.repeat(61) })).status).toBe(400);
    expect((await as(t.app, me).post('/v1/boards', { name: '   ' })).status).toBe(400);
    expect((await as(t.app, me).post('/v1/boards', { name: 'Fun', description: 'Party time \u{1F389}' })).status).toBe(400);
    expect((await as(t.app, me).post('/v1/boards', { name: 'Fun', visibility: 'everyone' })).status).toBe(400);
    await t.ctx.db.query(
      `INSERT INTO boards (owner_id, name) SELECT $1, 'Filler ' || g FROM generate_series(1, 200 - (SELECT count(*) FROM boards WHERE owner_id = $1)) g`,
      [me.id],
    );
    expect((await as(t.app, me).post('/v1/boards', { name: 'One too many' })).status).toBe(400);
    await t.ctx.db.query(`DELETE FROM boards WHERE owner_id = $1 AND name LIKE 'Filler %'`, [me.id]);

    // Removing an item and deleting the board keep the saves.
    expect((await as(t.app, me).del(`/v1/boards/${trip.id}/items/${a}`)).status).toBe(200);
    expect((await as(t.app, me).get(`/v1/boards/${trip.id}`)).body.board).toMatchObject({ itemCount: 2, coverPostId: null });
    expect((await as(t.app, me).del(`/v1/boards/${trip.id}`)).status).toBe(200);
    expect((await as(t.app, me).get(`/v1/boards/${trip.id}`)).status).toBe(404);
    expect(ids(await as(t.app, me).get('/v1/me/saved'))).toEqual(expect.arrayContaining([a, b, c]));

    // Unsaving takes the post off your own boards.
    const again = await board(me, { name: 'Again', postIds: [b] });
    await as(t.app, me).del(`/v1/posts/${b}/save`);
    got = await as(t.app, me).get(`/v1/boards/${again.id}`);
    expect(got.body.board.itemCount).toBe(0);
    expect(got.body.board.cover).toBeNull();
  });

  it('keeps private boards to their owner and lets only the owner manage', async () => {
    const owner = await adult();
    const stranger = await adult();
    const p = await post(owner, 'Mine');
    const b = await board(owner, { name: 'Secret plans', postIds: [p] });
    for (const viewer of [stranger, null]) {
      expect((await as(t.app, viewer).get(`/v1/boards/${b.id}`)).status).toBe(404);
      expect((await as(t.app, viewer).get(`/v1/boards/${b.id}/items`)).status).toBe(404);
    }
    expect((await as(t.app, stranger).patch(`/v1/boards/${b.id}`, { name: 'Mine now' })).status).toBe(404);
    expect((await as(t.app, stranger).del(`/v1/boards/${b.id}`)).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/boards/${b.id}/items`, { postId: p })).status).toBe(404);
    expect((await as(t.app, stranger).del(`/v1/boards/${b.id}/items/${p}`)).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/boards/${b.id}/collaborators`, { userId: stranger.id })).status).toBe(404);
    expect((await as(t.app, stranger).get('/v1/boards')).body.items.map((x: any) => x.id)).not.toContain(b.id);
    expect((await as(t.app, null).get('/v1/boards')).status).toBe(401);
    expect((await as(t.app, null).post('/v1/boards', { name: 'x' })).status).toBe(401);
  });
});

describe('shared boards', () => {
  it('lets invited friends accept, see and add, and only the owner manage', async () => {
    const owner = await adult();
    const friend = await adult();
    const pal = await adult();
    const stranger = await adult();
    await mutual(owner, friend);
    await as(t.app, owner).post(`/v1/users/${pal.id}/friend-request`);
    await as(t.app, pal).post(`/v1/users/${owner.id}/friend-request`);
    const first = await post(owner, 'Beach');
    const plan = await board(owner, { name: 'Weekend plan', postIds: [first] });

    // Only friends or mutual follows can be invited, and only by the owner.
    expect((await as(t.app, owner).post(`/v1/boards/${plan.id}/collaborators`, { userId: stranger.id })).status).toBe(400);
    expect((await as(t.app, owner).post(`/v1/boards/${plan.id}/collaborators`, { userId: owner.id })).status).toBe(400);
    const inv = await as(t.app, owner).post(`/v1/boards/${plan.id}/collaborators`, { userId: friend.id });
    expect(inv.status).toBe(201);
    // Inviting makes a private board shared.
    expect(inv.body.board.visibility).toBe('shared');
    expect(inv.body.collaborators).toEqual([expect.objectContaining({ status: 'invited', user: expect.objectContaining({ id: friend.id }) })]);
    expect((await as(t.app, owner).post(`/v1/boards/${plan.id}/collaborators`, { userId: pal.id })).status).toBe(201);

    // The invite is a notification; the invitee can look before answering, but not add yet.
    const notes = await as(t.app, friend).get('/v1/notifications');
    expect(notes.body.items).toContainEqual(
      expect.objectContaining({ type: 'board_invite', entityType: 'board', entityId: plan.id, data: { name: 'Weekend plan' } }),
    );
    expect((await as(t.app, friend).get(`/v1/boards/${plan.id}`)).body.board.role).toBe('invited');
    const friendsPost = await post(friend, 'Market');
    expect((await as(t.app, friend).post(`/v1/boards/${plan.id}/items`, { postId: friendsPost })).status).toBe(403);
    expect((await as(t.app, friend).post(`/v1/boards/${plan.id}/join`)).status).toBe(200);
    expect((await as(t.app, friend).post(`/v1/boards/${plan.id}/join`)).status).toBe(404);
    expect((await as(t.app, pal).del(`/v1/boards/${plan.id}/membership`)).status).toBe(200);
    expect((await as(t.app, pal).get(`/v1/boards/${plan.id}`)).status).toBe(404);

    // A collaborator sees and adds; it shows in their boards.
    expect((await as(t.app, friend).post(`/v1/boards/${plan.id}/items`, { postId: friendsPost })).status).toBe(201);
    expect(ids(await as(t.app, owner).get(`/v1/boards/${plan.id}/items`))).toEqual([friendsPost, first]);
    expect((await as(t.app, owner).get(`/v1/boards/${plan.id}/items`)).body.removable).toEqual([friendsPost, first]);
    expect((await as(t.app, friend).get(`/v1/boards/${plan.id}/items`)).body.removable).toEqual([friendsPost]);
    const theirs = (await as(t.app, friend).get('/v1/boards')).body.items.find((x: any) => x.id === plan.id);
    expect(theirs).toMatchObject({ role: 'collaborator', canAdd: true, itemCount: 2, collaboratorCount: 1 });
    expect(theirs.coverPostId).toBeUndefined();
    // The owner hears about it once, quietly: more adds raise the count.
    const second = await post(friend, 'Museum');
    await as(t.app, friend).post(`/v1/boards/${plan.id}/items`, { postId: second });
    const added = (await as(t.app, owner).get('/v1/notifications')).body.items.filter((n: any) => n.type === 'board_item_added');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ entityId: plan.id, data: { name: 'Weekend plan', count: 2 } });

    // Collaborators can't manage the board or take off what others added.
    expect((await as(t.app, friend).patch(`/v1/boards/${plan.id}`, { name: 'Ours' })).status).toBe(403);
    expect((await as(t.app, friend).patch(`/v1/boards/${plan.id}`, { visibility: 'public' })).status).toBe(403);
    expect((await as(t.app, friend).del(`/v1/boards/${plan.id}`)).status).toBe(403);
    expect((await as(t.app, friend).post(`/v1/boards/${plan.id}/collaborators`, { userId: pal.id })).status).toBe(403);
    expect((await as(t.app, friend).del(`/v1/boards/${plan.id}/collaborators/${owner.id}`)).status).toBe(403);
    expect((await as(t.app, friend).del(`/v1/boards/${plan.id}/items/${first}`)).status).toBe(403);
    expect((await as(t.app, friend).del(`/v1/boards/${plan.id}/items/${second}`)).status).toBe(200);
    // Nobody else gets in.
    expect((await as(t.app, stranger).get(`/v1/boards/${plan.id}`)).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/boards/${plan.id}/items`, { postId: first })).status).toBe(404);
    expect((await as(t.app, stranger).del(`/v1/boards/${plan.id}/membership`)).status).toBe(404);

    // Making it private again closes it to collaborators.
    await as(t.app, owner).patch(`/v1/boards/${plan.id}`, { visibility: 'private' });
    expect((await as(t.app, friend).get(`/v1/boards/${plan.id}`)).status).toBe(404);
    expect((await as(t.app, friend).post(`/v1/boards/${plan.id}/items`, { postId: second })).status).toBe(404);
    await as(t.app, owner).patch(`/v1/boards/${plan.id}`, { visibility: 'shared' });

    // Leaving: the board goes; what they added stays.
    expect((await as(t.app, friend).del(`/v1/boards/${plan.id}/membership`)).status).toBe(200);
    expect((await as(t.app, friend).get(`/v1/boards/${plan.id}`)).status).toBe(404);
    expect(ids(await as(t.app, owner).get(`/v1/boards/${plan.id}/items`))).toContain(friendsPost);

    // The owner removes collaborators.
    await as(t.app, owner).post(`/v1/boards/${plan.id}/collaborators`, { userId: friend.id });
    await as(t.app, friend).post(`/v1/boards/${plan.id}/join`);
    expect((await as(t.app, owner).del(`/v1/boards/${plan.id}/collaborators/${friend.id}`)).status).toBe(200);
    expect((await as(t.app, friend).get(`/v1/boards/${plan.id}`)).status).toBe(404);
  });

  it('keeps younger people safe and caps collaborators', async () => {
    const owner = await adult();
    const teen = await signUp(t.app, { birthDate: TEEN });
    await mutual(owner, teen);
    const b = await board(owner, { name: 'Ideas' });
    expect((await as(t.app, owner).post(`/v1/boards/${b.id}/collaborators`, { userId: teen.id })).status).toBe(403);
    // Teens can't make a board public.
    expect((await as(t.app, teen).post('/v1/boards', { name: 'Mine', visibility: 'public' })).status).toBe(403);
    const tb = await board(teen, { name: 'Mine' });
    expect((await as(t.app, teen).patch(`/v1/boards/${tb.id}`, { visibility: 'public' })).status).toBe(403);

    const people = await Promise.all(Array.from({ length: 30 }, () => adult()));
    await t.ctx.db.query(`INSERT INTO board_members (board_id, user_id, invited_by) SELECT $1, unnest($2::uuid[]), $3`, [
      b.id,
      people.map((p) => p.id),
      owner.id,
    ]);
    const one = await adult();
    await mutual(owner, one);
    const r = await as(t.app, owner).post(`/v1/boards/${b.id}/collaborators`, { userId: one.id });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('30');
  });
});

describe('what a board shows', () => {
  it('never shows a viewer a post they can no longer see, and counts only what they see', async () => {
    const owner = await adult();
    const viewer = await adult();
    const privAuthor = await adult();
    const blocked = await adult();
    const creator = await adult();
    const deleter = await adult();
    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [privAuthor.id]);
    // The owner follows everyone, so they can see all of it.
    for (const u of [blocked, creator, deleter]) await as(t.app, owner).post(`/v1/users/${u.id}/follow`);
    await t.ctx.db.query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [owner.id, privAuthor.id]);

    const open = await photoPost(owner, 'Open to all');
    const followersOnly = await post(creator, 'For my followers', { visibility: 'followers' });
    const privateAccount = await post(privAuthor, 'Private account post');
    const byBlocked = await post(blocked, 'By someone who blocks the viewer');
    const locked = await post(creator, 'Subscribers only text');
    await t.ctx.db.query(`UPDATE posts SET visibility = 'subscribers' WHERE id = $1`, [locked]);
    const doomed = await post(deleter, 'About to be deleted');
    // Someone who can't open a subscriber-only post can't put it on a board.
    expect((await as(t.app, owner).post('/v1/boards', { name: 'Locked', postIds: [locked] })).status).toBe(403);
    const b = await board(owner, { name: 'Everything', visibility: 'public', postIds: [open, followersOnly, privateAccount, byBlocked, doomed] });
    expect(b.itemCount).toBe(5);
    // A subscriber put it there once (their subscription has since lapsed): it stays out of sight.
    await t.ctx.db.query(`INSERT INTO board_items (board_id, post_id, added_by, position) VALUES ($1,$2,$3,-100)`, [b.id, locked, creator.id]);
    await as(t.app, blocked).post(`/v1/users/${viewer.id}/block`);
    await as(t.app, deleter).del(`/v1/posts/${doomed}`);

    // The owner sees what they can see.
    const ownerItems = ids(await as(t.app, owner).get(`/v1/boards/${b.id}/items`));
    expect(ownerItems.sort()).toEqual([open, followersOnly, privateAccount, byBlocked].sort());
    expect((await as(t.app, owner).get(`/v1/boards/${b.id}`)).body.board.itemCount).toBe(4);

    // Another viewer only gets the public post: no followers-only, private account, blocked, deleted or locked posts.
    // (A block is between two people: someone signed out still sees that author's public post.)
    const expected: [TestUser | null, string[], string[]][] = [
      [viewer, [open], ['By someone who blocks']],
      [null, [open, byBlocked], []],
    ];
    for (const [who, sees, alsoHidden] of expected) {
      const items = await as(t.app, who).get(`/v1/boards/${b.id}/items`);
      expect(ids(items)).toEqual(sees);
      const got = await as(t.app, who).get(`/v1/boards/${b.id}`);
      expect(got.body.board.itemCount).toBe(sees.length);
      expect(got.body.board.cover.postId).toBe(open);
      const listed = (await as(t.app, who).get(`/v1/users/${owner.username}/boards`)).body.items.find((x: any) => x.id === b.id);
      expect(listed.itemCount).toBe(sees.length);
      const s = JSON.stringify([items.body, got.body, listed]);
      for (const secret of ['For my followers', 'Private account post', 'Subscribers only', 'About to be deleted', ...alsoHidden])
        expect(s).not.toContain(secret);
    }
    // A chosen cover the viewer can't see falls back to one they can.
    await as(t.app, owner).patch(`/v1/boards/${b.id}`, { coverPostId: followersOnly });
    expect((await as(t.app, viewer).get(`/v1/boards/${b.id}`)).body.board.cover.postId).toBe(open);
    expect((await as(t.app, owner).get(`/v1/boards/${b.id}`)).body.board.cover.postId).toBe(followersOnly);

    // Once the viewer follows the creator, the followers-only post appears.
    await as(t.app, viewer).post(`/v1/users/${creator.id}/follow`);
    expect(ids(await as(t.app, viewer).get(`/v1/boards/${b.id}/items`)).sort()).toEqual([open, followersOnly].sort());

    // Reordering as someone who sees less never moves or reveals the rest: only the owner and collaborators reorder anyway.
    expect((await as(t.app, viewer).put(`/v1/boards/${b.id}/order`, { postIds: [followersOnly, open] })).status).toBe(403);
  });

  it('lets collaborators reorder only what they see, leaving the rest in place', async () => {
    const owner = await adult();
    const friend = await adult();
    const hidden = await adult();
    await mutual(owner, friend);
    await as(t.app, owner).post(`/v1/users/${hidden.id}/follow`);
    const [x, y] = [await post(owner, 'X'), await post(owner, 'Y')];
    const h = await post(hidden, 'Hidden from friend', { visibility: 'followers' });
    const b = await board(owner, { name: 'Mixed', postIds: [x, h, y] });
    expect(ids(await as(t.app, owner).get(`/v1/boards/${b.id}/items`))).toEqual([x, h, y]);
    await as(t.app, owner).post(`/v1/boards/${b.id}/collaborators`, { userId: friend.id });
    await as(t.app, friend).post(`/v1/boards/${b.id}/join`);
    expect(ids(await as(t.app, friend).get(`/v1/boards/${b.id}/items`))).toEqual([x, y]);
    // Asking to include a post they can't see is refused.
    expect((await as(t.app, friend).put(`/v1/boards/${b.id}/order`, { postIds: [y, h, x] })).status).toBe(409);
    expect((await as(t.app, friend).put(`/v1/boards/${b.id}/order`, { postIds: [y, x] })).status).toBe(200);
    expect(ids(await as(t.app, owner).get(`/v1/boards/${b.id}/items`))).toEqual([y, h, x]);
    // A collaborator can't add a post they can't see.
    const h2 = await post(hidden, 'Also hidden', { visibility: 'followers' });
    expect((await as(t.app, friend).post(`/v1/boards/${b.id}/items`, { postId: h2 })).status).toBe(404);
  });

  it("hides boards from people the owner blocked, and a board's notes stay private", async () => {
    const owner = await adult();
    const friend = await adult();
    const blockedViewer = await adult();
    await mutual(owner, friend);
    const p = await post(owner, 'Shared idea');
    const b = await board(owner, { name: 'Open board', visibility: 'public', postIds: [p] });
    await as(t.app, owner).put(`/v1/posts/${p}/save/note`, { note: 'owner-only-note' });
    await as(t.app, owner).post(`/v1/boards/${b.id}/collaborators`, { userId: friend.id });
    await as(t.app, friend).post(`/v1/boards/${b.id}/join`);
    for (const who of [friend, blockedViewer, null]) {
      const r = await as(t.app, who).get(`/v1/boards/${b.id}/items`);
      expect(ids(r)).toEqual([p]);
      expect(JSON.stringify(r.body)).not.toContain('owner-only-note');
    }
    expect((await as(t.app, owner).get(`/v1/boards/${b.id}/items`)).body.items[0].viewer.note).toBe('owner-only-note');
    // The friend's own note shows only to them.
    await as(t.app, friend).put(`/v1/posts/${p}/save/note`, { note: 'friend-note' });
    expect((await as(t.app, friend).get(`/v1/boards/${b.id}/items`)).body.items[0].viewer.note).toBe('friend-note');
    expect(JSON.stringify((await as(t.app, owner).get(`/v1/boards/${b.id}/items`)).body)).not.toContain('friend-note');

    await as(t.app, owner).post(`/v1/users/${blockedViewer.id}/block`);
    expect((await as(t.app, blockedViewer).get(`/v1/boards/${b.id}`)).status).toBe(404);
    expect((await as(t.app, blockedViewer).get(`/v1/boards/${b.id}/items`)).status).toBe(404);
    expect((await as(t.app, blockedViewer).get(`/v1/users/${owner.username}/boards`)).status).toBe(404);
  });
});

describe('boards on profiles', () => {
  it('shows only public boards, to people who may see the profile', async () => {
    const owner = await adult();
    const viewer = await adult();
    const friend = await adult();
    await mutual(owner, friend);
    const p = await post(owner, 'Hello');
    const pub = await board(owner, { name: 'Public picks', visibility: 'public', postIds: [p] });
    const shared = await board(owner, { name: 'Just us', visibility: 'shared', postIds: [p] });
    const priv = await board(owner, { name: 'Only me', postIds: [p] });
    await as(t.app, owner).post(`/v1/boards/${shared.id}/collaborators`, { userId: friend.id });
    await as(t.app, friend).post(`/v1/boards/${shared.id}/join`);

    for (const who of [owner, viewer, friend, null]) {
      const r = await as(t.app, who).get(`/v1/users/${owner.username}/boards`);
      expect(r.status).toBe(200);
      expect(r.body.items.map((x: any) => x.id)).toEqual([pub.id]);
    }
    // Public boards open for anyone, read-only.
    const anon = await as(t.app, null).get(`/v1/boards/${pub.id}`);
    expect(anon.body.board).toMatchObject({ role: null, canAdd: false, itemCount: 1 });
    expect((await as(t.app, viewer).post(`/v1/boards/${pub.id}/items`, { postId: p })).status).toBe(403);
    expect((await as(t.app, viewer).get(`/v1/boards/${shared.id}`)).status).toBe(404);
    expect((await as(t.app, viewer).get(`/v1/boards/${priv.id}`)).status).toBe(404);

    // A private account's public boards are for its followers.
    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [owner.id]);
    expect((await as(t.app, viewer).get(`/v1/users/${owner.username}/boards`)).body.items).toEqual([]);
    expect((await as(t.app, viewer).get(`/v1/boards/${pub.id}`)).status).toBe(404);
    expect((await as(t.app, friend).get(`/v1/users/${owner.username}/boards`)).body.items.map((x: any) => x.id)).toEqual([pub.id]);

    // A teen's boards never show as public.
    const teen = await signUp(t.app, { birthDate: TEEN });
    await t.ctx.db.query(`INSERT INTO boards (owner_id, name, visibility) VALUES ($1, 'Forced', 'public')`, [teen.id]);
    await t.ctx.db.query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [teen.id]);
    expect((await as(t.app, viewer).get(`/v1/users/${teen.username}/boards`)).body.items).toEqual([]);
    expect((await as(t.app, null).get(`/v1/users/${teen.username}/boards`)).status).toBe(404);
  });
});
