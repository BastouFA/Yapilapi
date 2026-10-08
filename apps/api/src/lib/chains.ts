import type { Pool, PoolClient } from 'pg';
import { CHAIN_RULES, extractMentions, type Chain, type ChainBlock, type ChainJoin, type ChainRef, type MediaItem } from '@yapilapi/shared';
import { AppError, badRequest, forbidden, notFound } from './errors.ts';
import { minorRuleSql } from './collabs.ts';
import { mentionAllowedSql } from './interactions.ts';
import { notBlockedSql, postVisibleSql } from './visibility.ts';
import { plusCol, publicUserFrom, usernameInListSql } from './users.ts';
import { mediaSizesSql, withSmallVariants } from './data-saver.ts';
import { soundUsableSql } from './sounds.ts';
import { notify } from './services.ts';
import { analyzeText } from './moderation.ts';
import type { RealtimeHub } from './realtime.ts';

type Q = Pool | PoolClient;

/**
 * Pass the Mic: reels made together, one after another (docs/product/pass-the-mic.md).
 *
 * A chain is a prompt its starter gives with one of their reels. Whoever may take the mic posts
 * the next reel (posts.create with `chainId`), and the reels play in the order they joined. Who
 * may take it is the starter's choice (everyone who can see the chain, people they follow, or
 * nobody: closed); whatever it says, blocks either way with the starter hide the chain, an adult
 * and someone under 18 can only be in each other's chains once they're friends, and one person
 * adds at most CHAIN_RULES.linksPerPersonPerChain reels to a chain and CHAIN_RULES.linksPerDay a day.
 *
 * Each reel stays its author's: it's on their profile and in feeds as usual, and only reaches
 * the people it's shared with. A reel that is deleted, taken down, held or from a suspended
 * account drops out of the chain (liveLinkSql) and comes back if it's restored. Counts include
 * every reel up in the chain, also ones a viewer can't see, which are never shown to them.
 */

/** Link `l` (reel_chain_links) counts: its reel is up for the people it's shared with. */
export const liveLinkSql = (l = 'l') =>
  `EXISTS (SELECT 1 FROM posts lp JOIN users lu ON lu.id = lp.author_id
           WHERE lp.id = ${l}.post_id AND lp.deleted_at IS NULL AND lp.status = 'published' AND lp.moderation_status = 'normal' AND lu.status = 'active')`;

/** Chain `ch` is there for viewer `v`: its starter's account is active and neither blocked the other. */
export const chainSeenSql = (v: string, ch = 'ch') =>
  `(EXISTS (SELECT 1 FROM users su WHERE su.id = ${ch}.starter_id AND su.status = 'active') AND ${notBlockedSql(`${ch}.starter_id`, v)})`;

/** Why viewer `v` can't take the mic on chain `ch` now (a ChainBlock), or NULL when they can. The chain is seen (chainSeenSql). */
export const chainBlockSql = (v: string, ch = 'ch') =>
  `(CASE WHEN ${v}::uuid IS NULL THEN 'signed_out'
         WHEN ${ch}.who_can_join = 'nobody' THEN 'closed'
         WHEN ${ch}.starter_id = ${v} THEN NULL
         WHEN ${ch}.who_can_join = 'following' AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${ch}.starter_id AND f.followee_id = ${v}) THEN 'following'
         WHEN NOT ${minorRuleSql(v, `${ch}.starter_id`)} THEN 'not_allowed'
         WHEN (SELECT count(*) FROM reel_chain_links x WHERE x.chain_id = ${ch}.id AND x.author_id = ${v}) >= ${CHAIN_RULES.linksPerPersonPerChain} THEN 'limit'
         ELSE NULL END)`;

/** The counts of chain `ch`: live reels, different people, countries they said they're in. */
const countsSql = (ch = 'ch') => `
  (SELECT count(*) FROM reel_chain_links x WHERE x.chain_id = ${ch}.id AND ${liveLinkSql('x')})::int AS links,
  (SELECT count(DISTINCT x.author_id) FROM reel_chain_links x WHERE x.chain_id = ${ch}.id AND ${liveLinkSql('x')})::int AS people,
  (SELECT count(DISTINCT xp.country) FROM reel_chain_links x JOIN profiles xp ON xp.user_id = x.author_id
   WHERE x.chain_id = ${ch}.id AND xp.country IS NOT NULL AND ${liveLinkSql('x')})::int AS countries`;

/** The default for a starter who didn't choose: everyone, or people they follow for private and under-18 accounts. */
export async function defaultChainJoin(db: Q, userId: string): Promise<ChainJoin> {
  const { rows } = await db.query<{ closed: boolean }>(
    `SELECT pr.is_private OR coalesce(u.birth_date > current_date - interval '18 years', false) AS closed
     FROM users u JOIN profiles pr ON pr.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  return rows[0]?.closed ? 'following' : 'everyone';
}

const REFUSED: Record<Exclude<ChainBlock, 'signed_out'>, () => AppError> = {
  closed: () => new AppError(403, 'chain_closed', 'This chain is closed.'),
  following: () => new AppError(403, 'chain_not_allowed', 'Only people the starter follows can take the mic on this chain.'),
  not_allowed: () => new AppError(403, 'chain_not_allowed', 'You can’t take the mic on this chain.'),
  limit: () => {
    const max = CHAIN_RULES.linksPerPersonPerChain;
    return new AppError(429, 'chain_limit', `You can add up to ${max} reels to one chain.`);
  },
};

/** A prompt is shown to everyone who sees the chain: words that may put someone at risk are refused, as in a post. */
export function assertPromptOk(prompt: string): void {
  if (analyzeText(prompt).risk === 'escalate')
    throw new AppError(
      422,
      'content_blocked',
      "This post can't be published because it may put someone at risk. If you or someone else is in danger, contact local emergency services.",
    );
}

/** The shape a reel must have to start or join a chain, with the message when it hasn't. */
function assertChainable(p: { format: string; visibility: string; community_id: string | null }) {
  if (p.format !== 'reel') throw badRequest('Chains are made of reels posted right away.');
  if (p.community_id || !['public', 'followers', 'friends'].includes(p.visibility))
    throw badRequest('Only reels shared publicly, with followers or with friends can be in a chain.');
}

/** What joining told the people to tell: the chain, its starter, and the author of the reel before. */
export interface ChainJoined {
  chainId: string;
  starterId: string;
  previousAuthorId: string | null;
}

/**
 * Add the reel `postId` (just written by `userId`, inside the publishing transaction) to a chain
 * as its next link, after checking they may take the mic. Hidden chains are "not found".
 */
export async function joinChain(c: PoolClient, userId: string, chainId: string, postId: string): Promise<ChainJoined> {
  const { rows } = await c.query<{ starter_id: string; block: ChainBlock | null }>(
    `SELECT ch.starter_id, ${chainBlockSql('$1')} AS block FROM reel_chains ch WHERE ch.id = $2 AND ${chainSeenSql('$1')} FOR UPDATE`,
    [userId, chainId],
  );
  const ch = rows[0];
  if (!ch) throw notFound('That chain');
  if (ch.block && ch.block !== 'signed_out') throw REFUSED[ch.block]();
  const today = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM reel_chain_links WHERE author_id = $1 AND created_at > now() - interval '1 day'`, [
    userId,
  ]);
  if (today.rows[0]!.n >= CHAIN_RULES.linksPerDay) throw new AppError(429, 'chain_limit', 'You’ve added a lot of reels to chains today. Try again tomorrow.');
  const p = (await c.query(`SELECT format, visibility, community_id FROM posts WHERE id = $1`, [postId])).rows[0];
  assertChainable(p);
  const prev = await c.query<{ author_id: string }>(
    `SELECT l.author_id FROM reel_chain_links l WHERE l.chain_id = $1 AND ${liveLinkSql()} ORDER BY l.position DESC LIMIT 1`,
    [chainId],
  );
  await c.query(
    `WITH ch AS (UPDATE reel_chains SET next_position = next_position + 1, last_link_at = now(), updated_at = now() WHERE id = $1 RETURNING next_position - 1 AS pos)
     INSERT INTO reel_chain_links (post_id, chain_id, author_id, position) SELECT $2, $1, $3, pos FROM ch`,
    [chainId, postId, userId],
  );
  return { chainId, starterId: ch.starter_id, previousAuthorId: prev.rows[0]?.author_id ?? null };
}

/**
 * Start a chain with one of `userId`'s reels (published, theirs, not in a chain yet). Its sound is
 * offered to the next people. Returns the chain's id.
 */
export async function startChain(c: Q, userId: string, postId: string, prompt: string, whoCanJoin?: ChainJoin): Promise<string> {
  const p = (
    await c.query(
      `SELECT p.format, p.visibility, p.community_id, p.sound_id, EXISTS (SELECT 1 FROM reel_chain_links l WHERE l.post_id = p.id) AS chained
       FROM posts p WHERE p.id = $1 AND p.author_id = $2 AND p.deleted_at IS NULL AND p.status = 'published'`,
      [postId, userId],
    )
  ).rows[0];
  if (!p) throw notFound('That reel');
  assertChainable(p);
  if (p.chained) throw new AppError(409, 'conflict', 'That reel is already in a chain.');
  assertPromptOk(prompt);
  const join = whoCanJoin ?? (await defaultChainJoin(c, userId));
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO reel_chains (starter_id, first_post_id, prompt, sound_id, who_can_join, next_position) VALUES ($1, $2, $3, $4, $5, 2) RETURNING id`,
    [userId, postId, prompt, p.sound_id ?? null, join],
  );
  await c.query(`INSERT INTO reel_chain_links (post_id, chain_id, author_id, position) VALUES ($1, $2, $3, 1)`, [postId, rows[0]!.id, userId]);
  return rows[0]!.id;
}

/**
 * Tell the starter that someone took the mic (batched per chain: "Ada and 3 others took the mic on
 * your chain"), and the author of the reel before, batched the same way. Only people who can see
 * the new reel are told; a reel held for review tells nobody.
 */
export async function announceChainLink(db: Q, realtime: RealtimeHub, j: ChainJoined & { postId: string; authorId: string }): Promise<void> {
  const told = new Set<string>([j.authorId]);
  const sees = async (userId: string) =>
    (
      await db.query(
        `SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
         WHERE p.id = $2 AND p.moderation_status = 'normal' AND ${postVisibleSql('$1')}`,
        [userId, j.postId],
      )
    ).rowCount;
  for (const [userId, type] of [
    [j.starterId, 'chain_link'],
    [j.previousAuthorId, 'chain_next'],
  ] as const) {
    if (!userId || told.has(userId)) continue;
    told.add(userId);
    if (!(await sees(userId))) continue;
    await notify(db, realtime, {
      userId,
      category: 'creators',
      type,
      actorId: j.authorId,
      entityType: 'post',
      entityId: j.postId,
      data: { chainId: j.chainId },
      group: j.chainId,
    });
  }
}

/**
 * Person `t` (users) may be passed the mic on chain `ch` by `from`: someone `from` follows or is
 * friends with, active, not blocked either way, across the minor line only as friends, who may
 * take the mic (they see the chain, the starter allows them). passedSql: `from` passed it to them already.
 */
const passableSql = (from: string, t = 't', ch = 'ch') =>
  `(${t}.id <> ${from} AND ${t}.status = 'active'
    AND (EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${from} AND f.followee_id = ${t}.id)
         OR EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${from} AND fr.user_b = ${t}.id) OR (fr.user_b = ${from} AND fr.user_a = ${t}.id)))
    AND ${notBlockedSql(`${t}.id`, from)} AND ${minorRuleSql(from, `${t}.id`)}
    AND ${chainSeenSql(`${t}.id`, ch)} AND ${chainBlockSql(`${t}.id`, ch)} IS NULL)`;
const passedSql = (from: string, t = 't', ch = 'ch') =>
  `EXISTS (SELECT 1 FROM reel_chain_passes x WHERE x.chain_id = ${ch}.id AND x.from_id = ${from} AND x.to_id = ${t}.id)`;

/** Record the passes and tell each person once ("Ada passed you the mic: …"). Returns who was passed it. */
async function sendPasses(db: Q, realtime: RealtimeHub, chainId: string, fromId: string, prompt: string, toIds: string[]): Promise<string[]> {
  const passed: string[] = [];
  for (const to of toIds) {
    const r = await db.query(`INSERT INTO reel_chain_passes (chain_id, from_id, to_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [chainId, fromId, to]);
    if (!r.rowCount) continue;
    passed.push(to);
    await notify(db, realtime, {
      userId: to,
      category: 'creators',
      type: 'chain_pass',
      actorId: fromId,
      entityType: 'chain',
      entityId: chainId,
      data: { chainId, prompt },
    });
  }
  return passed;
}

/**
 * Pass the mic on a chain `fromId` sees to some of `userIds` (the picker): only the ones who may be
 * passed it (passableSql); others are skipped without saying why. The caller checks the limits.
 */
export async function passTheMic(db: Q, realtime: RealtimeHub, p: { chainId: string; fromId: string; userIds: string[]; prompt: string }): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id FROM users t CROSS JOIN reel_chains ch WHERE ch.id = $2 AND t.id = ANY($3::uuid[]) AND ${passableSql('$1')} AND NOT ${passedSql('$1')}`,
    [p.fromId, p.chainId, p.userIds],
  );
  return sendPasses(
    db,
    realtime,
    p.chainId,
    p.fromId,
    p.prompt,
    rows.map((r) => r.id),
  );
}

/**
 * People @mentioned in a chain reel's caption, as it's posted, are passed the mic: the picker's
 * rules (and their mention setting), the first CHAIN_RULES.passesAtOnce of them in the caption's
 * order, within CHAIN_RULES.passesPerChain for the chain. Returns who holds the mic from the
 * author now (just passed, or earlier with the picker): they hear about the chain once, instead of
 * the mention. Editing the caption never passes it again.
 */
export async function passTheMicByMention(db: Q, realtime: RealtimeHub, m: { postId: string; authorId: string; text: string }): Promise<string[]> {
  const names = extractMentions(m.text);
  if (!names.length) return [];
  const { rows: chains } = await db.query<{ id: string; prompt: string; sent: number }>(
    `SELECT ch.id, ch.prompt, (SELECT count(*) FROM reel_chain_passes x WHERE x.chain_id = ch.id AND x.from_id = $2)::int AS sent
     FROM reel_chain_links l JOIN reel_chains ch ON ch.id = l.chain_id WHERE l.post_id = $1 AND ${chainSeenSql('$2')}`,
    [m.postId, m.authorId],
  );
  const ch = chains[0];
  if (!ch) return [];
  const { rows } = await db.query<{ id: string; passed: boolean }>(
    `SELECT t.id, ${passedSql('$1')} AS passed FROM profiles pr JOIN users t ON t.id = pr.user_id CROSS JOIN reel_chains ch
     WHERE ch.id = $2 AND ${usernameInListSql('pr', '$3::text[]')} AND ${passableSql('$1')} AND ${mentionAllowedSql('$1', 't.id')}
     ORDER BY coalesce(array_position($3::text[], lower(pr.username)), 99), t.id`,
    [m.authorId, ch.id, names],
  );
  const room = Math.max(0, Math.min(CHAIN_RULES.passesAtOnce, CHAIN_RULES.passesPerChain - ch.sent));
  const fresh = rows.filter((r) => !r.passed).slice(0, room);
  const passed = await sendPasses(
    db,
    realtime,
    ch.id,
    m.authorId,
    ch.prompt,
    fresh.map((r) => r.id),
  );
  return [...rows.filter((r) => r.passed).map((r) => r.id), ...passed];
}

/** Chains on reels (Post.chain) for a viewer, by post id: only chains the viewer can see. */
export async function chainRefs(db: Q, postIds: string[], viewer: string | null): Promise<Map<string, ChainRef>> {
  if (!postIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT l.post_id, ch.id, ch.prompt, ch.who_can_join, (ch.starter_id IS NOT DISTINCT FROM $2) AS is_starter, ${chainBlockSql('$2')} AS block,
            (SELECT count(*) FROM reel_chain_links x WHERE x.chain_id = ch.id AND x.position <= l.position AND ${liveLinkSql('x')})::int AS position,
            ${countsSql()},
            sp.user_id AS s_id, sp.username AS s_username, sp.display_name AS s_display_name, sp.avatar_url AS s_avatar_url, sp.mode AS s_mode, ${plusCol('s_', 'sp')}
     FROM reel_chain_links l JOIN reel_chains ch ON ch.id = l.chain_id JOIN profiles sp ON sp.user_id = ch.starter_id
     WHERE l.post_id = ANY($1::uuid[]) AND ${chainSeenSql('$2')}`,
    [postIds, viewer],
  );
  return new Map(
    rows.map((r) => [
      r.post_id as string,
      {
        id: r.id,
        prompt: r.prompt,
        position: Math.max(1, r.position),
        total: Math.max(r.links, r.position),
        people: r.people,
        countries: r.countries,
        starter: publicUserFrom(r, 's_'),
        canJoin: !r.block,
        isStarter: r.is_starter,
        closed: r.who_can_join === 'nobody',
      } satisfies ChainRef,
    ]),
  );
}

/** Links of chain `ch` the viewer may see (`$1`), with `sensitive` ($sensitive) saying whether sensitive reels may be shown. */
export const visibleLinkSql = (sensitiveParam: string) =>
  `${liveLinkSql()} AND EXISTS (SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
          WHERE p.id = l.post_id AND ${postVisibleSql('$1')}
            AND (${sensitiveParam} OR NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation = 'sensitive')))`;

/** Chains for a viewer, in the order of `ids`: what the chain page and the Chains shelf show. Hidden ones are left out. */
export async function chainsById(db: Q, ids: string[], viewer: string | null, sensitiveOk: boolean): Promise<Chain[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT ch.id, ch.prompt, ch.who_can_join, ch.created_at, ch.last_link_at, (ch.starter_id IS NOT DISTINCT FROM $1) AS is_starter, ${chainBlockSql('$1')} AS block,
            ${countsSql()},
            CASE WHEN ${soundUsableSql('$1')} THEN json_build_object('id', s.id, 'title', s.title) END AS sound,
            first.post_id AS first_post_id,
            (SELECT json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height, 'variants', m.variants,
                                      'sizes', ${mediaSizesSql()}, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash)
               FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = first.post_id AND m.moderation NOT IN ('blocked', 'sensitive')
               ORDER BY pm.position LIMIT 1) AS cover,
            sp.user_id AS s_id, sp.username AS s_username, sp.display_name AS s_display_name, sp.avatar_url AS s_avatar_url, sp.mode AS s_mode, ${plusCol('s_', 'sp')}
     FROM reel_chains ch JOIN profiles sp ON sp.user_id = ch.starter_id
     LEFT JOIN sounds s ON s.id = ch.sound_id
     LEFT JOIN LATERAL (SELECT l.post_id FROM reel_chain_links l WHERE l.chain_id = ch.id AND ${visibleLinkSql('$3')} ORDER BY l.position LIMIT 1) first ON true
     WHERE ch.id = ANY($2::uuid[]) AND ${chainSeenSql('$1')}`,
    [viewer, ids, sensitiveOk],
  );
  const byId = new Map(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id,
        prompt: r.prompt,
        starter: publicUserFrom(r, 's_'),
        whoCanJoin: r.who_can_join,
        closed: r.who_can_join === 'nobody',
        createdAt: r.created_at.toISOString(),
        lastLinkAt: r.last_link_at.toISOString(),
        counts: { links: r.links, people: r.people, countries: r.countries },
        sound: r.sound ?? null,
        cover: r.cover ? withSmallVariants(r.cover as MediaItem) : null,
        firstPostId: r.first_post_id ?? null,
        viewer: { canJoin: !r.block, isStarter: r.is_starter, why: r.block ?? null },
      } satisfies Chain,
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((x): x is Chain => !!x);
}

/** The chain's starter, or a 403 for anyone else (a hidden chain is "not found"). */
export async function assertStarter(db: Q, chainId: string, userId: string): Promise<void> {
  const { rows } = await db.query(`SELECT ch.starter_id FROM reel_chains ch WHERE ch.id = $2 AND ${chainSeenSql('$1')}`, [userId, chainId]);
  if (!rows[0]) throw notFound('That chain');
  if (rows[0].starter_id !== userId) throw forbidden();
}
