import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatJobHandlers } from '../src/lib/chat.ts';
import { GAME_IDLE_JOB } from '../src/lib/chat-games.ts';
import { processJobs } from '../src/lib/jobs.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

async function direct(a: TestUser, b: TestUser): Promise<string> {
  await befriend(a, b);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

async function group(owner: TestUser, others: TestUser[]): Promise<string> {
  for (const o of others) await befriend(owner, o);
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), title: 'Game night' });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

const start = (u: TestUser, conversationId: string, kind: string, playerIds: string[] = [], clientId?: string) =>
  as(t.app, u).post(`/v1/conversations/${conversationId}/games`, { kind, playerIds, ...(clientId ? { clientId } : {}) });

async function started(u: TestUser, conversationId: string, kind: string, playerIds: string[] = []) {
  const r = await start(u, conversationId, kind, playerIds);
  expect(r.status).toBe(201);
  return r.body.message as { id: string; body: string; game: any };
}

/** A move as the apps send it: the move number they saw, and a fresh client move id. */
const move = (u: TestUser, gameId: string, moveNumber: number, m: Record<string, unknown>, clientMoveId: string = randomUUID()) =>
  as(t.app, u).post(`/v1/games/${gameId}/moves`, { moveNumber, clientMoveId, move: m });

/** Play moves in order (each player in turn); every one must go through. */
async function playAll(gameId: string, turns: [TestUser, Record<string, unknown>][]) {
  let game: any = (await as(t.app, turns[0]![0]).get(`/v1/games/${gameId}`)).body.game;
  for (const [u, m] of turns) {
    const r = await move(u, gameId, game.moveNumber, m);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    game = r.body.game;
  }
  return game;
}

const messages = async (u: TestUser, conversationId: string) => (await as(t.app, u).get(`/v1/conversations/${conversationId}/messages`)).body.items as any[];
const handlers = () => chatJobHandlers({ db: db(), config: t.ctx.config, storage: t.ctx.storage, realtime: t.ctx.realtime });

/** A day passes for this game: its latest idle check comes due and runs. */
async function aDayLater(gameId: string) {
  await db().query(`UPDATE chat_games SET last_move_at = last_move_at - interval '25 hours' WHERE id = $1`, [gameId]);
  await db().query(`UPDATE jobs SET run_at = now() WHERE kind = $1 AND payload->>'gameId' = $2 AND status = 'queued'`, [GAME_IDLE_JOB, gameId]);
  for (let i = 0; i < 10; i++) if (!(await processJobs(db(), handlers(), 20))) return;
}

describe('Starting a game', () => {
  it('puts a card in a one-to-one chat that only its members see; one of each kind at a time', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const live = connect(b);
    const outsider = connect(stranger);

    expect((await start(stranger, convo, 'four_up')).status).toBe(404);
    expect((await start(a, convo, 'chess')).status).toBe(400);

    const m = await started(a, convo, 'four_up');
    expect(m.body).toBe('Four up');
    expect(m.game).toMatchObject({ kind: 'four_up', status: 'active', moveNumber: 0, turnId: a.id, createdBy: a.id, winnerId: null });
    expect(m.game.players.map((p: any) => p.id)).toEqual([a.id, b.id]);
    expect(m.game.state.cells).toHaveLength(42);
    expect(m.game.tally).toEqual([
      { userId: a.id, wins: 0 },
      { userId: b.id, wins: 0 },
    ]);
    expect(new Date(m.game.idleEndsAt).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(live.of('message.created').find((e) => e.data.id === m.id)?.data.game.kind).toBe('four_up');
    expect(outsider.events).toEqual([]);

    // The same kind again waits for this one to finish; another kind can go alongside it.
    const again = await start(b, convo, 'four_up');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'game_in_progress', details: { gameId: m.game.id } });
    await started(b, convo, 'noughts');
    const going = (await as(t.app, a).get(`/v1/conversations/${convo}/games`)).body.items;
    expect(going.map((g: any) => g.kind).sort()).toEqual(['four_up', 'noughts']);
    expect((await as(t.app, stranger).get(`/v1/conversations/${convo}/games`)).status).toBe(404);

    // It reads like a message elsewhere: a reply quotes it as a game.
    const fromB = (await messages(b, convo)).find((x) => x.id === m.id);
    expect(fromB.game.id).toBe(m.game.id);
    const reply = await as(t.app, b).post(`/v1/conversations/${convo}/messages`, { body: 'You’re on', replyToId: m.id });
    expect(reply.body.message.replyTo).toMatchObject({ id: m.id, kind: 'game', gameKind: 'four_up' });
    // The card can't be edited.
    expect((await as(t.app, a).patch(`/v1/messages/${m.id}`, { body: 'Chess' })).body.error.code).toBe('not_editable');
    live.remove();
    outsider.remove();
  });

  it('a retry with the same clientId starts one game', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const clientId = randomUUID();
    const first = await start(a, convo, 'noughts', [], clientId);
    const second = await start(a, convo, 'noughts', [], clientId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.message.id).toBe(first.body.message.id);
    const n = await db().query(`SELECT count(*)::int AS n FROM chat_games WHERE conversation_id = $1`, [convo]);
    expect(n.rows[0].n).toBe(1);
  });

  it('two starts at once make one game', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const [x, y] = await Promise.all([start(a, convo, 'word_ladder'), start(b, convo, 'word_ladder')]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
  });

  it('a block in a one-to-one chat stops new games and moves', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await started(a, convo, 'noughts');
    expect((await as(t.app, b).post(`/v1/users/${a.id}/block`)).status).toBeLessThan(300);
    const r = await start(a, convo, 'four_up');
    expect(r.status).toBe(403);
    expect((await move(a, m.game.id, 0, { cell: 4 })).status).toBe(403);
  });

  it('in a group: you choose who plays, from the chat, and people who blocked each other can’t play together', async () => {
    const [a, b, c, d, outside] = [await adult(), await adult(), await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c, d]);
    expect((await start(a, convo, 'four_up')).body.error.code).toBe('choose_players');
    expect((await start(a, convo, 'four_up', [b.id, c.id])).body.error.code).toBe('choose_players');
    expect((await start(a, convo, 'noughts', [outside.id])).body.error.code).toBe('not_in_chat');
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [c.id, d.id]);
    expect((await start(a, convo, 'word_ladder', [c.id, d.id])).status).toBe(403);

    const m = await started(a, convo, 'word_ladder', [b.id, c.id]);
    expect(m.game.players.map((p: any) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(m.game.state).toMatchObject({ kind: 'word_ladder', seats: 3, rungs: [] });
    expect(m.game.state.start).toMatch(/^[a-z]{4}$/);
    expect(m.game.state.best).toBeGreaterThanOrEqual(3);
    // d is in the chat and sees the board, but isn't playing.
    const seen = (await as(t.app, d).get(`/v1/games/${m.game.id}`)).body.game;
    expect(seen.id).toBe(m.game.id);
    expect((await move(d, m.game.id, 0, { pass: true })).body.error.code).toBe('not_a_player');
    expect((await as(t.app, outside).get(`/v1/games/${m.game.id}`)).status).toBe(404);
  });
});

describe('Playing', () => {
  it('keeps turn order, refuses illegal moves and sends every move live', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const liveA = connect(a);
    const liveB = connect(b);
    const m = await started(a, convo, 'four_up');
    const id = m.game.id;

    expect((await move(b, id, 0, { column: 3 })).body.error.code).toBe('not_your_turn');
    expect((await move(a, id, 0, { cell: 3 })).body.error.code).toBe('wrong_move');
    expect((await move(a, id, 0, { column: 9 })).status).toBe(400);

    const first = await move(a, id, 0, { column: 3 });
    expect(first.status).toBe(200);
    expect(first.body.game).toMatchObject({ moveNumber: 1, turnId: b.id });
    expect(first.body.game.state.cells[38]).toBe(0);
    // Both see it, as it happens.
    for (const live of [liveA, liveB]) {
      const update = live.of('game.updated').at(-1);
      expect(update!.data).toMatchObject({ id: m.id, conversationId: convo, game: { id, moveNumber: 1 } });
    }

    // Fill column 0, then try it again.
    await playAll(id, [
      [b, { column: 0 }],
      [a, { column: 0 }],
      [b, { column: 0 }],
      [a, { column: 0 }],
      [b, { column: 0 }],
      [a, { column: 0 }],
    ]);
    expect((await move(b, id, 7, { column: 0 })).body.error.code).toBe('column_full');
    liveA.remove();
    liveB.remove();
  });

  it('a double tap plays once, and a move from an old board is refused', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const { game } = await started(a, convo, 'noughts');
    const tap = randomUUID();
    const one = await move(a, game.id, 0, { cell: 4 }, tap);
    const two = await move(a, game.id, 0, { cell: 4 }, tap);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.duplicate).toBe(true);
    expect(two.body.game.moveNumber).toBe(1);
    const moves = await db().query(`SELECT count(*)::int AS n FROM chat_game_moves WHERE game_id = $1`, [game.id]);
    expect(moves.rows[0].n).toBe(1);

    // b saw move 0 still: refused, with the number to catch up to.
    const stale = await move(b, game.id, 0, { cell: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'game_moved_on', details: { moveNumber: 1 } });

    // Two different moves at once for the same board: one goes through.
    const [x, y] = await Promise.all([move(b, game.id, 1, { cell: 0 }), move(b, game.id, 1, { cell: 8 })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const board = (await as(t.app, a).get(`/v1/games/${game.id}`)).body.game;
    expect(board.moveNumber).toBe(2);
    expect(board.state.cells.filter((c: number | null) => c === 1)).toHaveLength(1);
  });

  it('a win ends the game with a line in the chat, counts in the tally, and a rematch starts with the other player', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const liveB = connect(b);
    const { game } = await started(a, convo, 'noughts');
    const done = await playAll(game.id, [
      [a, { cell: 0 }],
      [b, { cell: 3 }],
      [a, { cell: 1 }],
      [b, { cell: 4 }],
      [a, { cell: 2 }],
    ]);
    expect(done).toMatchObject({ status: 'won', winnerId: a.id, turnId: null, idleEndsAt: null });
    expect(done.state.result).toEqual({ type: 'win', winner: 0, by: 'play', line: [0, 1, 2] });
    expect(done.tally).toEqual([
      { userId: a.id, wins: 1 },
      { userId: b.id, wins: 0 },
    ]);
    expect((await move(b, game.id, 5, { cell: 8 })).body.error.code).toBe('game_over');

    const line = liveB.of('message.created').find((e) => e.data.kind === 'system');
    expect(line!.data.system).toEqual({ type: 'game', gameId: game.id, kind: 'noughts', outcome: 'won', by: 'play' });
    expect(line!.data.sender.id).toBe(a.id);
    expect((await messages(a, convo)).some((x) => x.system?.type === 'game' && x.system.outcome === 'won')).toBe(true);

    // Rematch: only when it's over, once, and the other player goes first.
    const re = await as(t.app, b).post(`/v1/games/${game.id}/rematch`);
    expect(re.status).toBe(201);
    const next = re.body.message.game;
    expect(next.players.map((p: any) => p.id)).toEqual([b.id, a.id]);
    expect(next.turnId).toBe(b.id);
    expect(next.tally).toEqual([
      { userId: b.id, wins: 0 },
      { userId: a.id, wins: 1 },
    ]);
    const same = await as(t.app, a).post(`/v1/games/${game.id}/rematch`);
    expect(same.body.message.game.id).toBe(next.id);
    expect((await as(t.app, a).get(`/v1/games/${game.id}`)).body.game.rematchId).toBe(next.id);
    expect((await as(t.app, a).post(`/v1/games/${next.id}/rematch`)).body.error.code).toBe('game_active');
    liveB.remove();
  });

  it('a draw says so', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const { game } = await started(a, convo, 'noughts');
    const done = await playAll(
      game.id,
      [0, 1, 2, 4, 3, 5, 7, 6, 8].map((cell, i) => [i % 2 ? b : a, { cell }] as [TestUser, Record<string, unknown>]),
    );
    expect(done).toMatchObject({ status: 'draw', winnerId: null });
    const line = (await messages(b, convo)).find((x) => x.system?.type === 'game');
    expect(line.system.outcome).toBe('draw');
  });

  it('forfeit: the other player wins; in a bigger word ladder the others play on', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const one = await direct(a, b);
    const duel = await started(a, one, 'four_up');
    const f = await as(t.app, b).post(`/v1/games/${duel.game.id}/forfeit`);
    expect(f.body.game).toMatchObject({ status: 'won', winnerId: a.id });
    expect(f.body.game.state.result).toEqual({ type: 'win', winner: 0, by: 'forfeit' });
    const line = (await messages(a, one)).find((x) => x.system?.type === 'game');
    expect(line.system).toMatchObject({ outcome: 'won', by: 'forfeit' });
    expect((await as(t.app, b).post(`/v1/games/${duel.game.id}/forfeit`)).body.error.code).toBe('game_over');

    const convo = await group(a, [b, c]);
    const m = await started(a, convo, 'word_ladder', [b.id, c.id]);
    const out = await as(t.app, a).post(`/v1/games/${m.game.id}/forfeit`);
    expect(out.body.game).toMatchObject({ status: 'active', turnId: b.id });
    expect(out.body.game.state.out).toEqual([0]);
    expect((await move(a, m.game.id, 1, { pass: true })).body.error.code).toBe('not_a_player');
  });

  it('word ladder: rungs are checked against the word list and one-letter changes', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const { game } = await started(a, convo, 'word_ladder');
    // A known ladder for the test: cold to warm.
    await db().query(`UPDATE chat_games SET state = state || '{"start":"cold","target":"warm","best":4}'::jsonb WHERE id = $1`, [game.id]);
    expect((await move(a, game.id, 0, { word: 'cxld' })).body.error.code).toBe('not_a_word');
    expect((await move(a, game.id, 0, { word: 'ward' })).body.error.code).toBe('not_one_letter');
    expect((await move(a, game.id, 0, { word: 'cold' })).body.error.code).toBe('not_one_letter');
    const done = await playAll(game.id, [
      [a, { word: 'Cord' }],
      [b, { word: 'card' }],
      [a, { pass: true }],
      [b, { word: 'ward' }],
      [a, { word: 'warm' }],
    ]);
    expect(done.state.rungs.map((r: any) => r.word)).toEqual(['cord', 'card', 'ward', 'warm']);
    expect(done).toMatchObject({ status: 'won', winnerId: a.id });
  });
});

describe('Membership, time-outs and removal', () => {
  it('someone who left the chat can’t move', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const { game } = await started(a, convo, 'noughts', [b.id]);
    await move(a, game.id, 0, { cell: 4 });
    await as(t.app, b).post(`/v1/conversations/${convo}/leave`);
    expect((await move(b, game.id, 1, { cell: 0 })).status).toBe(404);
    expect((await as(t.app, b).get(`/v1/games/${game.id}`)).status).toBe(404);
  });

  it('a day without a move ends it unfinished (the job), and a move in time keeps it going', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const liveA = connect(a);
    const { game } = await started(a, convo, 'four_up');
    await move(a, game.id, 0, { column: 1 });
    // The check queued at the start is out of date after that move: it leaves the game alone.
    await db().query(`UPDATE chat_games SET last_move_at = last_move_at - interval '25 hours' WHERE id = $1`, [game.id]);
    await db().query(`UPDATE jobs SET run_at = now() WHERE kind = $1 AND payload->>'gameId' = $2 AND (payload->>'moveNumber')::int = 0`, [
      GAME_IDLE_JOB,
      game.id,
    ]);
    for (let i = 0; i < 5; i++) if (!(await processJobs(db(), handlers(), 20))) break;
    expect((await as(t.app, a).get(`/v1/games/${game.id}`)).body.game.status).toBe('active');

    await aDayLater(game.id);
    const after = (await as(t.app, a).get(`/v1/games/${game.id}`)).body.game;
    expect(after).toMatchObject({ status: 'unfinished', turnId: null, winnerId: null });
    expect(after.state.result).toEqual({ type: 'unfinished' });
    expect(liveA.of('game.updated').at(-1)!.data.game.status).toBe('unfinished');
    const line = liveA.of('message.created').find((e) => e.data.system?.type === 'game');
    expect(line!.data.system).toMatchObject({ outcome: 'unfinished', kind: 'four_up' });
    // It was a's move last, so the line is from a.
    expect(line!.data.sender.id).toBe(a.id);
    expect((await move(b, game.id, 1, { column: 2 })).body.error.code).toBe('game_over');
    // A new one can start.
    expect((await start(b, convo, 'four_up')).status).toBe(201);
    liveA.remove();
  });

  it('unsending the card removes the game', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await started(a, convo, 'noughts');
    await move(a, m.game.id, 0, { cell: 4 });
    expect((await as(t.app, a).post(`/v1/messages/${m.id}/unsend`)).status).toBe(200);
    expect((await as(t.app, a).get(`/v1/games/${m.game.id}`)).status).toBe(404);
    expect((await db().query(`SELECT 1 FROM chat_game_moves WHERE game_id = $1`, [m.game.id])).rowCount).toBe(0);
    expect((await start(a, convo, 'noughts')).status).toBe(201);
  });
});
