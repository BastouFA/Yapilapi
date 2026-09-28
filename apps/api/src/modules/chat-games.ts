import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { tx } from '@yapilapi/database';
import {
  applyMove,
  chatGameDrawSchema,
  chatGameMoveSchema,
  createChatGameSchema,
  drawAction,
  forfeit,
  GAME_ACTIVE_LIMIT,
  GAME_KIND_ACTIVE_LIMIT,
  GAME_NAMES,
  GAME_PLAYERS,
  newGame,
  winnerSeat,
  type GameError,
  type GameKind,
  type GameState,
  type Message,
} from '@yapilapi/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { GAME_COLS, gameById, insertEndLine, presentGames, publishGame, publishLine, scheduleIdleEnd, type GameRow } from '../lib/chat-games.ts';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { enqueue } from '../lib/jobs.ts';
import { assertMessagePace } from '../lib/spam.ts';
import { isBlockedEitherWay } from '../lib/users.ts';
import { me, requireAuth, type AuthUser } from '../plugins/auth.ts';
import type { ChatHelpers } from './chat-polls-lists.ts';

const idParam = z.object({ id: z.string().uuid() });

/** What each refused move says (the shared rules give the code). */
const MOVE_ERRORS: Record<GameError, [number, string]> = {
  game_over: [409, 'This game has ended.'],
  not_your_turn: [409, 'It’s not your turn.'],
  not_a_player: [403, 'You’re not playing in this game.'],
  wrong_move: [400, 'That move isn’t part of this game.'],
  bad_column: [400, 'Choose a column from 1 to 7.'],
  column_full: [400, 'That column is full. Choose another.'],
  bad_cell: [400, 'Choose a square on the board.'],
  cell_taken: [400, 'That square is taken. Choose another.'],
  not_four_letters: [400, 'Use a four-letter word.'],
  not_a_word: [400, 'That word isn’t in our word list.'],
  not_one_letter: [400, 'Change exactly one letter of the last word.'],
  word_used: [400, 'That word is already on the ladder.'],
  bad_square: [400, 'Choose squares on the board.'],
  not_your_piece: [400, 'Move one of your own pieces.'],
  illegal_move: [400, 'That move isn’t allowed.'],
  promotion_needed: [400, 'Choose what the pawn becomes.'],
  bad_promotion: [400, 'A pawn can become a queen, rook, bishop or knight, and only on the last rank.'],
  no_draw_offer: [409, 'There’s no draw offer to answer.'],
  draw_offered: [409, 'A draw offer is already waiting for an answer.'],
  draw_too_soon: [409, 'You can offer a draw again after your next move.'],
};
const moveError = (code: GameError) => new AppError(MOVE_ERRORS[code][0], code, MOVE_ERRORS[code][1]);
/** A chat with as many games going as it can have (all kinds, or this kind): see migration 0060. */
const gamesFull = () =>
  new AppError(409, 'games_full', `${GAME_ACTIVE_LIMIT} games are going in this chat. Finish or forfeit one to start another.`, {
    limit: GAME_ACTIVE_LIMIT,
  });
const kindFull = (kind: GameKind) =>
  new AppError(
    409,
    'game_kind_full',
    `${GAME_KIND_ACTIVE_LIMIT} games of ${GAME_NAMES[kind]} are going in this chat. Finish or forfeit one to start another.`,
    {
      limit: GAME_KIND_ACTIVE_LIMIT,
    },
  );

/**
 * Games in chats: Four up, Noughts, Word ladder and Chess, turn by turn, in one-to-one chats and groups.
 * A game is a message whose card shows the board; only people in the chat who are playing can
 * move, every move is checked with the shared rules (packages/shared/src/games), and the board goes
 * live to everyone in the chat. No pushes, no scores beyond a quiet tally in the chat.
 */
export function registerChatGames(app: FastifyInstance, ctx: AppContext, h: ChatHelpers) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };

  /**
   * Who plays, and whether they can. One-to-one: the two of you, with the same rules as a message
   * (blocks either way, minor safety, who can message whom). Groups: you and the people you chose,
   * all in the chat, and nobody among them blocked by another.
   */
  async function playersFor(u: AuthUser, conversationId: string, kind: GameKind, chosen: string[]): Promise<string[]> {
    const conv = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [conversationId])).rows[0];
    if (!conv) throw notFound('Conversation');
    if (conv.kind !== 'direct' && conv.kind !== 'group') throw new AppError(400, 'games_unavailable', 'Games are for one-to-one chats and groups.');
    const members = await h.memberIds(conversationId);
    const { min, max } = GAME_PLAYERS[kind];
    let players: string[];
    if (conv.kind === 'direct') {
      const other = members.find((m) => m !== u.id);
      if (!other) throw new AppError(400, 'nobody_to_play', 'There’s nobody else in this chat to play with.');
      await h.assertCanMessage(u.id, u.birthDate, other);
      players = [u.id, other];
    } else {
      const others = [...new Set(chosen.filter((id) => id !== u.id))];
      if (others.length < min - 1 || others.length > max - 1)
        throw new AppError(
          400,
          'choose_players',
          min === max ? `Choose one person to play ${GAME_NAMES[kind]} with.` : `Choose 1 to ${max - 1} people to play ${GAME_NAMES[kind]} with.`,
        );
      if (others.some((id) => !members.includes(id))) throw new AppError(400, 'not_in_chat', 'Everyone playing needs to be in this chat.');
      await h.assertGroupSafe([u.id], members);
      players = [u.id, ...others];
    }
    const blocks = await db.query(`SELECT 1 FROM blocks WHERE blocker_id = ANY($1::uuid[]) AND blocked_id = ANY($1::uuid[]) LIMIT 1`, [players]);
    if (blocks.rowCount) throw new AppError(403, 'game_blocked', 'These people can’t play together. Choose someone else.');
    return players;
  }

  /** In a one-to-one chat, nobody plays on with someone they blocked or who blocked them. */
  async function assertCanPlay(userId: string, conversationId: string) {
    const conv = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [conversationId])).rows[0];
    if (conv?.kind !== 'direct') return;
    const other = (await h.memberIds(conversationId)).find((m) => m !== userId);
    if (other && (await isBlockedEitherWay(db, userId, other))) throw forbidden("You can't message this person.");
  }

  /**
   * Start a game: its card goes in the chat as a message from `u`, and the board is new. A retry with
   * the same clientId returns the first one. Up to GAME_ACTIVE_LIMIT games go at once in a chat,
   * GAME_KIND_ACTIVE_LIMIT of the same kind.
   */
  async function startGame(
    u: AuthUser,
    conversationId: string,
    kind: GameKind,
    players: string[],
    clientId: string | undefined,
    options: { rematchOf?: string; white?: number } = {},
  ) {
    const { rematchOf } = options;
    await assertMessagePace(db, ctx.config, u.id);
    const conv = (await db.query(`SELECT disappearing_seconds FROM conversations WHERE id = $1`, [conversationId])).rows[0];
    const seconds: number | null = conv?.disappearing_seconds ?? null;
    const state = newGame(kind, players.length, randomInt(2 ** 31 - 1), { white: options.white ?? 0 });
    const messageId = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, body, client_id, kind, expires_at)
         VALUES ($1,$2,$3,$4,'message', now() + make_interval(secs => $5::int))
         ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
         RETURNING id, conversation_id, (xmax = 0) AS inserted`,
        [conversationId, u.id, GAME_NAMES[kind], clientId ?? null, seconds],
      );
      const r = rows[0] as { id: string; conversation_id: string; inserted: boolean };
      if (r.conversation_id !== conversationId) throw badRequest('That clientId was used in another chat.');
      // The same clientId again (a retry): the first one stands.
      if (!r.inserted) return { id: r.id, inserted: false };
      // The limits on games going at once are checked by the database as the game goes in, under a
      // lock per chat, so two starts at once can't both take the last place (migration 0060).
      const game = await c
        .query<{ id: string }>(
          `INSERT INTO chat_games (message_id, conversation_id, kind, created_by, players, state, rematch_of) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [r.id, conversationId, kind, u.id, players, state, rematchOf ?? null],
        )
        .catch((e: { code?: string; constraint?: string }) => {
          if (e.constraint === 'chat_games_active_limit') throw gamesFull();
          if (e.constraint === 'chat_games_kind_limit') throw kindFull(kind);
          // Two rematches at once: one wins, the other gets the same one.
          if (e.code === '23505' && e.constraint === 'chat_games_rematch_key') throw new AppError(409, 'rematch_exists', 'A rematch has already started.');
          throw e;
        });
      await scheduleIdleEnd(c, game.rows[0]!.id, 0);
      // A disappearing chat takes the game with the card.
      if (seconds) await enqueue(c, 'messages.expire', { messageId: r.id }, seconds + 1);
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
      await c.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [conversationId, u.id]);
      return { id: r.id, inserted: true };
    });
    const message = await h.loadMessage(messageId.id, u.id);
    if (!message) throw notFound('Message');
    if (messageId.inserted)
      await ctx.realtime.publish(await h.notBlocking(u.id, await h.memberIds(conversationId)), { type: 'message.created', data: message });
    return message;
  }

  /** A game you can see: you're in its chat, its card is still there, and you haven't blocked whoever started it. */
  async function visibleGame(gameId: string, userId: string): Promise<GameRow> {
    const g = (await db.query<GameRow>(`SELECT ${GAME_COLS} FROM chat_games g WHERE g.id = $1`, [gameId])).rows[0];
    if (!g) throw notFound('Game');
    const m = await h.messageFor(g.message_id, userId).catch(() => {
      throw notFound('Game');
    });
    if (m.deleted_at) throw notFound('Game');
    const b = await db.query(`SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [userId, g.created_by]);
    if (b.rowCount) throw notFound('Game');
    return g;
  }

  /** The game locked for a change, and the seat of `userId` in it. */
  async function lockGame(c: PoolClient, gameId: string, userId: string) {
    const g = (await c.query<GameRow>(`SELECT ${GAME_COLS} FROM chat_games g WHERE g.id = $1 FOR UPDATE`, [gameId])).rows[0];
    if (!g) throw notFound('Game');
    const seat = g.players.indexOf(userId);
    if (seat < 0) throw moveError('not_a_player');
    return { g, seat };
  }

  /** Save a new state after a move (or a forfeit), and the line in the chat if it ended the game. */
  async function saveMove(c: PoolClient, g: GameRow, userId: string, state: GameState, move: object, clientMoveId: string | null) {
    const number = g.move_number + 1;
    await c.query(`INSERT INTO chat_game_moves (game_id, number, player_id, move, client_move_id) VALUES ($1,$2,$3,$4,$5)`, [
      g.id,
      number,
      userId,
      move,
      clientMoveId,
    ]);
    const seat = winnerSeat(state);
    const status = !state.result ? 'active' : state.result.type === 'win' ? 'won' : state.result.type === 'draw' ? 'draw' : 'unfinished';
    await c.query(
      `UPDATE chat_games SET state = $2, move_number = $3, status = $4, winner_id = $5, last_move_at = now(), ended_at = CASE WHEN $4 = 'active' THEN NULL ELSE now() END
       WHERE id = $1`,
      [g.id, state, number, status, seat === null ? null : g.players[seat]],
    );
    if (status === 'active') await scheduleIdleEnd(c, g.id, number);
    return insertEndLine(c, g, state, userId);
  }

  app.post('/v1/conversations/:id/games', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(createChatGameSchema, req.body);
    await h.assertMember(id, u.id);
    const players = await playersFor(u, id, input.kind, input.playerIds);
    // Chess: whoever starts chooses a colour (seat 0 is them), or leaves it to chance.
    const white = input.color === 'black' ? 1 : input.color === 'random' ? randomInt(2) : 0;
    const message = await startGame(u, id, input.kind, players, input.clientId, { white });
    reply.code(201);
    return { message };
  });

  /** The games going in this chat (up to GAME_ACTIVE_LIMIT), as cards you can see, oldest first. */
  app.get('/v1/conversations/:id/games', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await h.assertMember(id, u.id);
    const { rows } = await db.query<GameRow>(
      `SELECT ${GAME_COLS} FROM chat_games g JOIN messages m ON m.id = g.message_id
       WHERE g.conversation_id = $1 AND g.status = 'active' AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = g.created_by)
       ORDER BY g.created_at`,
      [id, u.id],
    );
    return { items: await presentGames(db, rows) };
  });

  app.get('/v1/games/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await visibleGame(id, u.id);
    return { game: await gameById(db, id) };
  });

  /**
   * Play a move. It must be your turn and `moveNumber` must match the board (otherwise 409
   * `game_moved_on`: load it again). Sending the same `clientMoveId` again (a double tap, a retry)
   * plays nothing more and returns the board.
   */
  app.post('/v1/games/:id/moves', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(chatGameMoveSchema, req.body);
    const visible = await visibleGame(id, u.id);
    await assertCanPlay(u.id, visible.conversation_id);
    const done = await tx(db, async (c) => {
      const { g, seat } = await lockGame(c, id, u.id);
      const again = await c.query(`SELECT 1 FROM chat_game_moves WHERE game_id = $1 AND player_id = $2 AND client_move_id = $3`, [
        id,
        u.id,
        input.clientMoveId,
      ]);
      if (again.rowCount) return { duplicate: true as const };
      if (g.status !== 'active') throw moveError('game_over');
      if (g.move_number !== input.moveNumber)
        throw new AppError(409, 'game_moved_on', 'The board changed since you last saw it. Here it is now.', { moveNumber: g.move_number });
      const r = applyMove(g.state, seat, input.move);
      if (!r.ok) throw moveError(r.error);
      return { duplicate: false as const, line: await saveMove(c, g, u.id, r.state, input.move, input.clientMoveId) };
    });
    if (done.duplicate) return { game: await gameById(db, id), duplicate: true };
    const game = await publishGame(deps, id);
    if (done.line) await publishLine(deps, done.line);
    return { game };
  });

  /**
   * Chess draws: offer one, or accept or decline the other player's offer, on either player's turn.
   * An offer lapses after the offerer's next move; accepting ends the game in a draw. Each counts as
   * a move for the board's move number, so a move made against a board without the offer is refused.
   */
  app.post('/v1/games/:id/draw', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { action } = parse(chatGameDrawSchema, req.body);
    const visible = await visibleGame(id, u.id);
    await assertCanPlay(u.id, visible.conversation_id);
    const line = await tx(db, async (c) => {
      const { g, seat } = await lockGame(c, id, u.id);
      if (g.status !== 'active') throw moveError('game_over');
      const r = drawAction(g.state, seat, action);
      if (!r.ok) throw moveError(r.error);
      return saveMove(c, g, u.id, r.state, { draw: action }, null);
    });
    const game = await publishGame(deps, id);
    if (line) await publishLine(deps, line);
    return { game };
  });

  /** Give up (in chess, resign). With one player left they win; in a bigger Word ladder the others play on. */
  app.post('/v1/games/:id/forfeit', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await visibleGame(id, u.id);
    const line = await tx(db, async (c) => {
      const { g, seat } = await lockGame(c, id, u.id);
      if (g.status !== 'active') throw moveError('game_over');
      const r = forfeit(g.state, seat);
      if (!r.ok) throw moveError(r.error);
      return saveMove(c, g, u.id, r.state, { forfeit: true }, null);
    });
    const game = await publishGame(deps, id);
    if (line) await publishLine(deps, line);
    return { game };
  });

  /**
   * Play again with the same people who are still in the chat, the next one along going first. Any
   * player can ask once the game is over; asking again (or both at once) gets the same rematch.
   */
  app.post('/v1/games/:id/rematch', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const g = await visibleGame(id, u.id);
    if (!g.players.includes(u.id)) throw moveError('not_a_player');
    if (g.status === 'active') throw new AppError(409, 'game_active', 'This game is still going.');
    const existing = async () => {
      const r = (await db.query<{ message_id: string }>(`SELECT message_id FROM chat_games WHERE rematch_of = $1`, [id])).rows[0];
      return r ? await h.loadMessage(r.message_id, u.id) : null;
    };
    const first = await existing();
    if (first) return { message: first };
    const members = await h.memberIds(g.conversation_id);
    const stay = g.players.filter((p) => members.includes(p));
    if (stay.length < GAME_PLAYERS[g.kind].min || !stay.includes(u.id))
      throw new AppError(400, 'players_left', 'Not enough of the players are still in this chat for a rematch.');
    // The next one along goes first.
    const order = [...stay.slice(1), stay[0]!];
    const players = await playersFor(
      u,
      g.conversation_id,
      g.kind,
      order.filter((p) => p !== u.id),
    );
    const seats = order.filter((p) => players.includes(p));
    // Chess: colours swap, so whoever played black plays white.
    const black = g.state.kind === 'chess' ? g.players[1 - g.state.white] : undefined;
    const white = black ? Math.max(0, seats.indexOf(black)) : 0;
    let message: Message;
    try {
      message = await startGame(u, g.conversation_id, g.kind, seats, undefined, { rematchOf: id, white });
    } catch (e) {
      // Both asked at once: the other one's rematch went in first (and may have taken the chat's last place).
      const again = e instanceof AppError && ['rematch_exists', 'games_full', 'game_kind_full'].includes(e.code) ? await existing() : null;
      if (again) return { message: again };
      throw e;
    }
    reply.code(201);
    return { message };
  });
}
