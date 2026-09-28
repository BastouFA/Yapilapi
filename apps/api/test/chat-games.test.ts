import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chessFromFen } from '@yapilapi/shared';
import { chatJobHandlers } from '../src/lib/chat.ts';
import { GAME_IDLE_JOB } from '../src/lib/chat-games.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser, jobRunner, type JobRunner } from './helpers.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
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
  for (let i = 0; i < 10; i++) if (!(await runJobs(handlers(), 20))) return;
}

describe('Starting a game', () => {
  it('puts a card in a one-to-one chat that only its members see; one of each kind at a time', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const live = connect(b);
    const outsider = connect(stranger);

    expect((await start(stranger, convo, 'four_up')).status).toBe(404);
    expect((await start(a, convo, 'go')).status).toBe(400);

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
    for (let i = 0; i < 5; i++) if (!(await runJobs(handlers(), 20))) break;
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

describe('Chess', () => {
  /** Start a chess game in a new one-to-one chat; `color` is the starter's side. */
  async function chess(color?: 'white' | 'black' | 'random') {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const r = await as(t.app, a).post(`/v1/conversations/${convo}/games`, { kind: 'chess', ...(color ? { color } : {}) });
    expect(r.status).toBe(201);
    return { a, b, convo, message: r.body.message as { id: string; body: string; game: any }, id: r.body.message.game.id as string };
  }
  /** Squares as the apps send them: "e2e4", "e7e8q". */
  const sq = (m: string) => ({ from: m.slice(0, 2), to: m.slice(2, 4), ...(m[4] ? { promotion: m[4] } : {}) });
  /** Put the board in a position (the starter playing white unless `white` says otherwise). */
  const setPosition = (id: string, fen: string, white = 0) => db().query(`UPDATE chat_games SET state = $2 WHERE id = $1`, [id, chessFromFen(fen, white)]);
  const draw = (u: TestUser, id: string, action: string) => as(t.app, u).post(`/v1/games/${id}/draw`, { action });

  it('starts with the colour the starter chose; white moves first', async () => {
    const white = await chess();
    expect(white.message.body).toBe('Chess');
    expect(white.message.game).toMatchObject({ kind: 'chess', turnId: white.a.id, moveNumber: 0 });
    expect(white.message.game.state).toMatchObject({ white: 0, side: 'w', board: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', san: [] });

    const black = await chess('black');
    expect(black.message.game.players.map((p: any) => p.id)).toEqual([black.a.id, black.b.id]);
    expect(black.message.game.state.white).toBe(1);
    expect(black.message.game.turnId).toBe(black.b.id);

    const random = await chess('random');
    expect([0, 1]).toContain(random.message.game.state.white);
    expect(random.message.game.turnId).toBe(random.message.game.players[random.message.game.state.white].id);

    // One chess game at a time in a chat.
    expect((await start(white.b, white.convo, 'chess')).body.error.code).toBe('game_in_progress');
    expect((await as(t.app, white.a).post(`/v1/conversations/${white.convo}/games`, { kind: 'chess', color: 'green' })).status).toBe(400);
  });

  it('in a group, you choose one person to play', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    expect((await start(a, convo, 'chess', [b.id, c.id])).body.error.code).toBe('choose_players');
    const m = await started(a, convo, 'chess', [c.id]);
    expect(m.game.players.map((p: any) => p.id)).toEqual([a.id, c.id]);
    expect((await move(b, m.game.id, 0, sq('e2e4'))).body.error.code).toBe('not_a_player');
  });

  it('the server refuses illegal moves, moves out of turn and malformed squares', async () => {
    const { a, b, id } = await chess();
    expect((await move(b, id, 0, sq('e7e5'))).body.error.code).toBe('not_your_turn');
    expect((await move(a, id, 0, sq('e2e5'))).body.error.code).toBe('illegal_move');
    expect((await move(a, id, 0, sq('f1c4'))).body.error.code).toBe('illegal_move');
    expect((await move(a, id, 0, sq('e7e5'))).body.error.code).toBe('not_your_piece');
    expect((await move(a, id, 0, sq('e4e5'))).body.error.code).toBe('not_your_piece');
    expect((await move(a, id, 0, sq('e2e4q'))).body.error.code).toBe('bad_promotion');
    expect((await move(a, id, 0, { from: 'z9', to: 'e4' })).status).toBe(400);
    expect((await move(a, id, 0, { from: 'e2', to: 'e4', promotion: 'k' })).status).toBe(400);
    expect((await move(a, id, 0, { column: 3 })).body.error.code).toBe('wrong_move');
    const ok = await move(a, id, 0, sq('e2e4'));
    expect(ok.status).toBe(200);
    expect(ok.body.game).toMatchObject({ moveNumber: 1, turnId: b.id });
    expect(ok.body.game.state).toMatchObject({ side: 'b', ep: 'e3', san: ['e4'], last: { from: 'e2', to: 'e4', piece: 'p' } });
    expect((await db().query(`SELECT count(*)::int AS n FROM chat_game_moves WHERE game_id = $1`, [id])).rows[0].n).toBe(1);
  });

  it('a double tap plays once, and two moves for the same board: one goes through', async () => {
    const { a, b, id } = await chess();
    const tap = randomUUID();
    expect((await move(a, id, 0, sq('d2d4'), tap)).status).toBe(200);
    const again = await move(a, id, 0, sq('d2d4'), tap);
    expect(again.body).toMatchObject({ duplicate: true, game: { moveNumber: 1 } });
    const [x, y] = await Promise.all([move(b, id, 1, sq('d7d5')), move(b, id, 1, sq('g8f6'))]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await move(a, id, 1, sq('c2c4'))).body.error.code).toBe('game_moved_on');
    const board = (await as(t.app, a).get(`/v1/games/${id}`)).body.game;
    expect(board.moveNumber).toBe(2);
    expect(board.state.san).toHaveLength(2);
  });

  it('checkmate ends the game with the winner’s line in the chat', async () => {
    const { a, b, convo, id } = await chess();
    const liveA = connect(a);
    const done = await playAll(id, [
      [a, sq('f2f3')],
      [b, sq('e7e5')],
      [a, sq('g2g4')],
      [b, sq('d8h4')],
    ]);
    expect(done).toMatchObject({ status: 'won', winnerId: b.id, turnId: null });
    expect(done.state.san).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    expect(done.state.result).toEqual({ type: 'win', winner: 1, by: 'play' });
    expect(done.tally).toEqual([
      { userId: a.id, wins: 0 },
      { userId: b.id, wins: 1 },
    ]);
    const line = liveA.of('message.created').find((e) => e.data.system?.type === 'game');
    expect(line!.data.system).toEqual({ type: 'game', gameId: id, kind: 'chess', outcome: 'won', by: 'play' });
    expect(line!.data.sender.id).toBe(b.id);
    expect((await move(a, id, 4, sq('a2a3'))).body.error.code).toBe('game_over');
    expect((await messages(a, convo)).some((x) => x.system?.type === 'game' && x.system.kind === 'chess')).toBe(true);
    liveA.remove();
  });

  it('promotion: the pawn needs a choice, and becomes that piece', async () => {
    const { a, id } = await chess();
    await setPosition(id, '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
    expect((await move(a, id, 0, sq('e7e8'))).body.error.code).toBe('promotion_needed');
    const r = await move(a, id, 0, sq('e7e8n'));
    expect(r.status).toBe(200);
    expect(r.body.game.state.board.startsWith('4N3')).toBe(true);
    expect(r.body.game.state.san).toEqual(['e8=N+']);
  });

  it('stalemate and the other draw rules end the game as a draw, with the reason in the line', async () => {
    const stale = await chess();
    await setPosition(stale.id, '7k/8/6K1/8/8/8/8/5Q2 w - - 0 1');
    const s = await move(stale.a, stale.id, 0, sq('f1f7'));
    expect(s.body.game).toMatchObject({ status: 'draw', winnerId: null });
    expect(s.body.game.state.result).toEqual({ type: 'draw', reason: 'stalemate' });
    const line = (await messages(stale.b, stale.convo)).find((x) => x.system?.type === 'game');
    expect(line.system).toMatchObject({ outcome: 'draw', reason: 'stalemate' });

    const bare = await chess();
    await setPosition(bare.id, 'k7/8/8/8/8/8/1q6/K7 w - - 0 1');
    expect((await move(bare.a, bare.id, 0, sq('a1b2'))).body.game.state.result).toEqual({ type: 'draw', reason: 'material' });

    const fifty = await chess();
    await setPosition(fifty.id, '7k/8/8/8/8/8/8/R5K1 w - - 99 80');
    expect((await move(fifty.a, fifty.id, 0, sq('a1a2'))).body.game.state.result).toEqual({ type: 'draw', reason: 'fifty_moves' });

    const rep = await chess();
    const shuffle: [TestUser, Record<string, unknown>][] = [
      [rep.a, sq('g1f3')],
      [rep.b, sq('g8f6')],
      [rep.a, sq('f3g1')],
      [rep.b, sq('f6g8')],
    ];
    await playAll(rep.id, shuffle);
    const repeated = await playAll(rep.id, shuffle);
    expect(repeated).toMatchObject({ status: 'draw' });
    expect(repeated.state.result).toEqual({ type: 'draw', reason: 'repetition' });
  });

  it('draw offers: offer, decline, offer again later, lapse, accept', async () => {
    const { a, b, convo, id } = await chess();
    const liveB = connect(b);
    const offered = await draw(a, id, 'offer');
    expect(offered.status).toBe(200);
    expect(offered.body.game).toMatchObject({ moveNumber: 1, status: 'active', turnId: a.id });
    expect(offered.body.game.state.drawOffer).toEqual({ seat: 0, at: 0 });
    expect(liveB.of('game.updated').at(-1)!.data.game.state.drawOffer).toEqual({ seat: 0, at: 0 });
    // A move sent for the board before the offer is refused: load it again.
    expect((await move(a, id, 0, sq('e2e4'))).body.error.code).toBe('game_moved_on');

    expect((await draw(a, id, 'accept')).body.error.code).toBe('no_draw_offer');
    expect((await draw(b, id, 'offer')).body.error.code).toBe('draw_offered');
    const declined = await draw(b, id, 'decline');
    expect(declined.body.game.state.drawOffer).toBeNull();
    expect((await draw(a, id, 'offer')).body.error.code).toBe('draw_too_soon');
    expect((await draw(b, id, 'decline')).body.error.code).toBe('no_draw_offer');
    expect((await as(t.app, a).post(`/v1/games/${id}/draw`, { action: 'maybe' })).status).toBe(400);

    await playAll(id, [
      [a, sq('e2e4')],
      [b, sq('e7e5')],
    ]);
    // b offers on a's turn; a's move doesn't answer it, and b's next move lets it lapse.
    await draw(b, id, 'offer');
    let g = await playAll(id, [[a, sq('g1f3')]]);
    expect(g.state.drawOffer).toMatchObject({ seat: 1 });
    g = await playAll(id, [[b, sq('b8c6')]]);
    expect(g.state.drawOffer).toBeNull();
    expect((await draw(a, id, 'accept')).body.error.code).toBe('no_draw_offer');

    await draw(a, id, 'offer');
    const accepted = await draw(b, id, 'accept');
    expect(accepted.body.game).toMatchObject({ status: 'draw', winnerId: null, turnId: null });
    expect(accepted.body.game.state.result).toEqual({ type: 'draw', reason: 'agreed' });
    const line = (await messages(a, convo)).find((x) => x.system?.type === 'game');
    expect(line.system).toMatchObject({ kind: 'chess', outcome: 'draw', reason: 'agreed' });
    expect(line.sender.id).toBe(b.id);
    const logged = await db().query(`SELECT move->>'draw' AS draw FROM chat_game_moves WHERE game_id = $1 AND move->>'draw' IS NOT NULL ORDER BY number`, [id]);
    expect(logged.rows.map((r) => r.draw)).toEqual(['offer', 'decline', 'offer', 'offer', 'accept']);
    expect((await draw(a, id, 'offer')).body.error.code).toBe('game_over');
    liveB.remove();
  });

  it('only chess has draw offers, only players make them, and blocks stop them', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const noughts = await started(a, convo, 'noughts', [b.id]);
    expect((await draw(a, noughts.game.id, 'offer')).body.error.code).toBe('wrong_move');
    const game = await started(a, convo, 'chess', [b.id]);
    expect((await draw(c, game.game.id, 'offer')).body.error.code).toBe('not_a_player');

    const duel = await chess();
    expect((await as(t.app, duel.b).post(`/v1/users/${duel.a.id}/block`)).status).toBeLessThan(300);
    expect((await draw(duel.a, duel.id, 'offer')).status).toBe(403);
    expect((await move(duel.a, duel.id, 0, sq('e2e4'))).status).toBe(403);
  });

  it('resigning: the other player wins, and a rematch swaps colours', async () => {
    const { a, b, convo, id } = await chess('black');
    await playAll(id, [[b, sq('e2e4')]]);
    const r = await as(t.app, a).post(`/v1/games/${id}/forfeit`);
    expect(r.body.game).toMatchObject({ status: 'won', winnerId: b.id });
    expect(r.body.game.state.result).toEqual({ type: 'win', winner: 1, by: 'forfeit' });
    const line = (await messages(b, convo)).find((x) => x.system?.type === 'game');
    expect(line.system).toMatchObject({ kind: 'chess', outcome: 'won', by: 'forfeit' });

    // a played black; in the rematch a plays white, and moves first.
    const re = await as(t.app, b).post(`/v1/games/${id}/rematch`);
    expect(re.status).toBe(201);
    const next = re.body.message.game;
    expect(next.players.map((p: any) => p.id)).toEqual([b.id, a.id]);
    expect(next.state.white).toBe(1);
    expect(next.turnId).toBe(a.id);
    expect(next.state.san).toEqual([]);
  });

  it('someone who left the group can’t move or offer a draw', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const { game } = await started(a, convo, 'chess', [b.id]);
    await move(a, game.id, 0, sq('e2e4'));
    await as(t.app, b).post(`/v1/conversations/${convo}/leave`);
    expect((await move(b, game.id, 1, sq('e7e5'))).status).toBe(404);
    expect((await draw(b, game.id, 'offer')).status).toBe(404);
  });
});
