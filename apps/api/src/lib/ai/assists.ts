import type { Pool } from 'pg';
import sharp from 'sharp';
import {
  baseLanguage,
  detectLanguage,
  extractHashtags,
  languageName,
  normalizeTag,
  type AltTextSuggestion,
  type CaptionIdeas,
  type CatchUp,
  type CatchUpLine,
  type CatchUpOffer,
  type CatchUpSection,
  type ConversationSmartReplies,
  type SmartReplies,
} from '@yapilapi/shared';
import { messageVisibleSql } from '../chat.ts';
import { AppError, forbidden, notFound } from '../errors.ts';
import { analyzeText } from '../moderation.ts';
import { personalizationAllowed, track } from '../services.ts';
import type { MediaStorage } from '../storage.ts';
import { eventVisibleSql, postUnlockedSql, postVisibleSql, PUBLIC_POST_SQL } from '../visibility.ts';
import type { AiProvider, CompletionRequest } from './providers.ts';

/**
 * The AI helpers around posting and reading: Catch me up on Pulse, suggested replies in
 * chats, photo descriptions, and caption and hashtag ideas.
 *
 * Each call follows the gateway's order: permission first (nothing is read for someone
 * who may not see it), then context built only from what the person can see right now
 * (postVisibleSql and postUnlockedSql for posts, chat membership and messageVisibleSql
 * for messages, their own uploads for photos), then the model (or the offline dev
 * provider, whose output is rule-based and marked), then the safety filter, then a row
 * in ai_tool_calls (task, scopes, provider, status; never content). Nothing here posts
 * or sends anything: the apps show the result, labelled, for the person to use or not.
 */

/** Pulse offers "Catch me up" when you come back after this long. */
export const CATCH_UP_AWAY_HOURS = 12;
/** …for this long after you came back (the "visit window"). */
export const CATCH_UP_WINDOW_HOURS = 6;
/** A catch-up covers at most the last week, however long you were away. */
const CATCH_UP_MAX_DAYS = 7;
const CATCH_UP_MAX_POSTS = 60;
const LINES_PER_SECTION = 3;

/** Per-person limits on new (not cached) results, on top of the per-minute route limits. */
export const AI_LIMITS = {
  catch_up: { max: 20, window: '1 day' },
  smart_replies: { max: 150, window: '1 hour' },
  alt_text: { max: 100, window: '1 day' },
  caption_ideas: { max: 100, window: '1 day' },
} as const;
export type AssistTask = keyof typeof AI_LIMITS;

const DEV_NOTICE = 'Made by the local development provider (rule-based, no model).';
const HELD_NOTICE = 'Some of it was held back by safety filters.';

/** Public, unflagged posts: where hashtag ideas come from (the same rule as trending). */
const PUBLIC_POST = PUBLIC_POST_SQL;

/** Moments that shouldn't get a quick canned answer. */
const SENSITIVE_TOPIC =
  /\b(passed away|died|funeral|condolences|rip|suicide|self[- ]harm|diagnos\w*|cancer|hospital|miscarriage|divorce|laid off|lost (my|her|his|their) job|décédé|décès|funérailles|hôpital|falleci\w*|funeral|hospital|faleceu|morreu|amefariki|msiba|hospitali)\b/iu;
const PLANS =
  /\b(tonight|tomorrow|this weekend|next week|party|meet ?up|dinner|lunch|brunch|trip|concert|festival|join us|rsvp|event|ce soir|demain|fiesta|mañana|amanhã|festa|kesho|leo usiku)\b/iu;
const MOMENTS =
  /\b(birthday|graduat\w*|engaged|married|wedding|baby|new job|promot\w*|moved to|new home|anniversary|won|first day|anniversaire|mariage|bébé|cumpleaños|boda|aniversário|casamento|harusi|kuzaliwa)\b/iu;

type Status = 'ok' | 'denied' | 'blocked' | 'error';

/** One row in the AI audit log. Never the content: the task, what it was allowed to read, who answered, and how it went. */
export async function logAiCall(
  db: Pool,
  c: { userId: string; task: string; provider: string; model: string; scopes: string[]; status: Status; started: number },
): Promise<void> {
  await db
    .query(`INSERT INTO ai_tool_calls (user_id, task, provider, model, context_scopes, status, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      c.userId,
      c.task,
      c.provider,
      c.model,
      c.scopes,
      c.status,
      Date.now() - c.started,
    ])
    .catch(() => {});
}

/**
 * Suggested replies in one chat for one person. Everywhere: their switch in Settings (on
 * by default, off by default under 18). In this chat: their choice, or by default on in
 * one-to-one chats and off in groups and community chats.
 */
export function smartRepliesState(kind: string, setting: boolean | null, everywhere: boolean, flag: boolean): ConversationSmartReplies {
  const defaultOn = kind === 'direct';
  return { on: flag && everywhere && (setting ?? defaultOn), setting, defaultOn, everywhere };
}

/** SQL for "suggested replies everywhere" of user $v: their choice, or on for adults. */
export const smartRepliesEverywhereSql = (v: string) =>
  `coalesce((SELECT up.smart_replies FROM user_preferences up WHERE up.user_id = ${v}),
            coalesce((SELECT uu.birth_date <= current_date - interval '18 years' FROM users uu WHERE uu.id = ${v}), false))`;

interface WindowPost {
  id: string;
  kind: string;
  body: string;
  like_count: number;
  comment_count: number;
  created_at: Date;
  name: string;
  username: string;
  author_id: string;
  friend: boolean;
  event_title: string | null;
  media_count: number;
}

const firstSentence = (s: string, max = 110) => {
  const clean = s
    .replace(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const one = clean.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

const safe = (s: string) => {
  const r = analyzeText(s).risk;
  return r !== 'escalate' && r !== 'restrict';
};

/** JSON from a model reply: structured output is plain JSON, but tolerate a fenced block. */
function parseJson(text: string): any {
  try {
    return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch {
    return null;
  }
}

export class AiAssists {
  constructor(
    private db: Pool,
    private provider: AiProvider,
    private storage: MediaStorage | null,
  ) {}

  private get dev() {
    return this.provider.name === 'dev';
  }

  private log(userId: string, task: AssistTask, scopes: string[], status: Status, started: number, by?: { provider: string; model: string }) {
    return logAiCall(this.db, {
      userId,
      task,
      provider: by?.provider ?? this.provider.name,
      model: by?.model ?? this.provider.model,
      scopes,
      status,
      started,
    });
  }

  /** New results in the limit's window (cached answers don't count). */
  private async checkLimit(userId: string, task: AssistTask) {
    const { max, window } = AI_LIMITS[task];
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_tool_calls
       WHERE user_id = $1 AND task = $2 AND status = 'ok' AND NOT ('cache' = ANY(context_scopes)) AND created_at > now() - $3::interval`,
      [userId, task, window],
    );
    if ((rows[0]?.n ?? 0) >= max) throw new AppError(429, 'ai_limit', 'You’ve used this a lot recently. Try again later.');
  }

  private async locale(userId: string): Promise<string> {
    const { rows } = await this.db.query<{ locale: string }>(`SELECT locale FROM profiles WHERE user_id = $1`, [userId]);
    return baseLanguage(rows[0]?.locale) || 'en';
  }

  private async complete(req: CompletionRequest) {
    const res = await this.provider.complete(req);
    return res.refused ? null : res;
  }

  /** Runs one assist: logs the result (denied for 403/404, error otherwise) and rethrows failures. */
  private async audited<T>(
    userId: string,
    task: AssistTask,
    fn: (scopes: string[]) => Promise<{ value: T; status?: Status; cache?: boolean; quiet?: boolean }>,
  ): Promise<T> {
    const started = Date.now();
    const scopes: string[] = [];
    try {
      const r = await fn(scopes);
      // Answered without reading anything new (turned off, nothing to answer): nothing to log.
      if (r.quiet) return r.value;
      await this.log(userId, task, r.cache ? [...scopes, 'cache'] : scopes, r.status ?? 'ok', started);
      return r.value;
    } catch (err) {
      const code = (err as { status?: number }).status;
      // Limits and bad input aren't calls; only log what reached the permission check.
      if (code !== 429 && code !== 400) await this.log(userId, task, scopes, code === 403 || code === 404 ? 'denied' : 'error', started);
      throw err;
    }
  }

  // ─── Catch me up ────────────────────────────────────────────────────────

  /**
   * Opening Pulse: remember the visit, and start a new visit window when the last one was
   * CATCH_UP_AWAY_HOURS or more ago. Offers the catch-up while the window is open, not
   * dismissed, and there's something from your people to catch up on.
   */
  async visit(userId: string): Promise<CatchUpOffer> {
    const { rows } = await this.db.query<{ away_since: Date | null; back_at: Date | null; dismissed: boolean; open: boolean }>(
      `INSERT INTO pulse_visits (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET
         away_since = CASE WHEN pulse_visits.last_seen_at < now() - make_interval(hours => $2) THEN pulse_visits.last_seen_at ELSE pulse_visits.away_since END,
         back_at    = CASE WHEN pulse_visits.last_seen_at < now() - make_interval(hours => $2) THEN now() ELSE pulse_visits.back_at END,
         dismissed  = CASE WHEN pulse_visits.last_seen_at < now() - make_interval(hours => $2) THEN false ELSE pulse_visits.dismissed END,
         last_seen_at = now()
       RETURNING away_since, back_at, dismissed, coalesce(back_at > now() - make_interval(hours => $3), false) AS open`,
      [userId, CATCH_UP_AWAY_HOURS, CATCH_UP_WINDOW_HOURS],
    );
    const w = rows[0];
    if (!w?.away_since || !w.back_at || !w.open || w.dismissed) return { offer: false };
    const since = this.windowStart(w.away_since, w.back_at);
    const posts = await this.windowPosts(userId, since, w.back_at, false);
    if (!posts.length) return { offer: false };
    return { offer: true, since: since.toISOString(), until: w.back_at.toISOString(), postCount: posts.length };
  }

  /** "Not now": hide the card until the next time you come back. */
  async dismissCatchUp(userId: string): Promise<void> {
    await this.db.query(`UPDATE pulse_visits SET dismissed = true WHERE user_id = $1`, [userId]);
  }

  private windowStart(awaySince: Date, backAt: Date): Date {
    const floor = new Date(backAt.getTime() - CATCH_UP_MAX_DAYS * 86_400_000);
    return awaySince > floor ? awaySince : floor;
  }

  /**
   * Posts your friends and the people you follow shared in the window, as you'd see them in
   * Following: only posts you can see and open (audience, blocks, regional rules, subscriptions,
   * moderation), minus muted people and posts you said you're not interested in. Posts waiting
   * for review never go in, whatever your age.
   */
  private async windowPosts(userId: string, since: Date, until: Date, friendsFirst: boolean): Promise<WindowPost[]> {
    const { rows } = await this.db.query<WindowPost>(
      `SELECT p.id, p.kind, p.body, p.like_count, p.comment_count, p.created_at, p.author_id, ap.display_name AS name, ap.username,
              EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST($1::uuid, p.author_id) AND fr.user_b = GREATEST($1::uuid, p.author_id)) AS friend,
              (SELECT e.title FROM events e WHERE e.id = p.event_id AND ${eventVisibleSql('$1')}) AS event_title,
              (SELECT count(*)::int FROM post_media pm WHERE pm.post_id = p.id) AS media_count
       FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.author_id <> $1 AND p.community_id IS NULL AND p.created_at > $2 AND p.created_at <= $3
         AND p.moderation_status = 'normal'
         AND (EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)
              OR EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST($1::uuid, p.author_id) AND fr.user_b = GREATEST($1::uuid, p.author_id)))
         AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')}
         AND NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = $1 AND mu.muted_id = p.author_id)
         AND NOT EXISTS (SELECT 1 FROM feed_feedback ff WHERE ff.user_id = $1 AND (
               (ff.signal = 'not_interested' AND ff.post_id = p.id) OR (ff.signal = 'mute_creator' AND ff.author_id = p.author_id)))
       ORDER BY ${friendsFirst ? 'friend DESC,' : ''} (p.like_count + 2 * p.comment_count) DESC, p.created_at DESC
       LIMIT ${CATCH_UP_MAX_POSTS}`,
      [userId, since, until],
    );
    return rows;
  }

  /** Of these posts, the ones the person can still see and open now. */
  private async stillVisible(userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.id = ANY($2::uuid[]) AND p.moderation_status = 'normal' AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')}
         AND NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = $1 AND mu.muted_id = p.author_id)`,
      [userId, ids],
    );
    return new Set(rows.map((r) => r.id));
  }

  /**
   * The catch-up for the current visit window, made once and cached for it. A cached one is
   * checked again against what the person can see now: lines about posts that were deleted,
   * hidden or blocked since are left out.
   */
  async catchUp(userId: string): Promise<CatchUp> {
    return this.audited<CatchUp>(userId, 'catch_up', async (scopes) => {
      scopes.push('pulse:people');
      const w = (
        await this.db.query<{ away_since: Date | null; back_at: Date | null }>(
          `SELECT away_since, back_at FROM pulse_visits WHERE user_id = $1 AND back_at > now() - make_interval(hours => $2)`,
          [userId, CATCH_UP_WINDOW_HOURS],
        )
      ).rows[0];
      if (!w?.away_since || !w.back_at) throw new AppError(404, 'nothing_to_catch_up', 'There’s nothing to catch up on right now.');
      const since = this.windowStart(w.away_since, w.back_at);

      const hit = (
        await this.db.query<{ output: Omit<CatchUp, 'cached' | 'since' | 'until'> }>(
          `SELECT output FROM ai_catchups WHERE user_id = $1 AND away_since = $2 AND back_at = $3`,
          [userId, w.away_since, w.back_at],
        )
      ).rows[0];
      if (hit) {
        const ids = hit.output.sections.flatMap((s) => s.lines.flatMap((l) => l.posts.map((p) => p.id)));
        const visible = await this.stillVisible(userId, ids);
        const sections = hit.output.sections
          .map((s) => ({
            ...s,
            lines: s.lines.map((l) => ({ ...l, posts: l.posts.filter((p) => visible.has(p.id)) })).filter((l) => l.posts.length),
          }))
          .filter((s) => s.lines.length);
        return {
          cache: true,
          value: { ...hit.output, sections, since: since.toISOString(), until: w.back_at.toISOString(), cached: true },
        };
      }

      await this.checkLimit(userId, 'catch_up');
      const posts = await this.windowPosts(userId, since, w.back_at, await personalizationAllowed(this.db, userId));
      scopes.push(`posts:${posts.length}`);
      let sections: CatchUpSection[] = [];
      let notice: string | undefined = this.dev ? DEV_NOTICE : undefined;
      if (posts.length) {
        const made = this.dev ? devCatchUp(posts) : await this.modelCatchUp(posts, await this.locale(userId));
        if (made === null) notice = 'A summary couldn’t be made this time.';
        else {
          const kept = made.map((s) => ({ ...s, lines: s.lines.filter((l) => safe(l.text)) }));
          if (kept.some((s, i) => s.lines.length < made[i]!.lines.length)) notice = [notice, HELD_NOTICE].filter(Boolean).join(' ');
          sections = kept.filter((s) => s.lines.length);
        }
      }
      const output = {
        sections,
        postCount: posts.length,
        peopleCount: new Set(posts.map((p) => p.author_id)).size,
        provider: this.provider.name,
        ...(notice ? { notice } : {}),
      };
      await this.db.query(`INSERT INTO ai_catchups (user_id, away_since, back_at, output, provider, model) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [
        userId,
        w.away_since,
        w.back_at,
        output,
        this.provider.name,
        this.provider.model,
      ]);
      void track(this.db, userId, 'ai_catch_up', { posts: posts.length });
      return { value: { ...output, since: since.toISOString(), until: w.back_at.toISOString(), cached: false } };
    });
  }

  private async modelCatchUp(posts: WindowPost[], lang: string): Promise<CatchUpSection[] | null> {
    const line = {
      type: 'object',
      properties: { text: { type: 'string' }, posts: { type: 'array', items: { type: 'integer' } } },
      required: ['text', 'posts'],
      additionalProperties: false,
    };
    const list = { type: 'array', items: line };
    const res = await this.complete({
      system: [
        'You write a short catch-up for someone coming back to a social app, about what their friends and the people they follow shared while they were away.',
        'Sort it into three kinds: moments (personal news such as birthdays, new jobs, moves, graduations, babies, trips), plans (events, meetups, invitations, things happening soon) and popular (the posts with the most likes and comments).',
        `Up to ${LINES_PER_SECTION} lines per kind. Each line is one short, plain sentence under 140 characters that says who and what, written in ${languageName(lang, 'en')}.`,
        'Only state what the posts say. Never guess feelings, relationships, ages or details that are not written. Leave a kind empty when nothing fits, and put each post in one kind at most.',
        'Each line lists the numbers of the posts it is about.',
      ].join(' '),
      prompt: posts
        .map(
          (p, i) =>
            `[${i + 1}] ${p.name}${p.friend ? ' (friend)' : ''} · ${p.like_count} likes · ${p.comment_count} comments${p.media_count ? ` · ${p.media_count} photo or video` : ''}${p.event_title ? ` · event: ${p.event_title}` : ''}\n${p.body.slice(0, 600) || '(no text)'}`,
        )
        .join('\n\n'),
      maxTokens: 1500,
      schema: {
        type: 'object',
        properties: { moments: list, plans: list, popular: list },
        required: ['moments', 'plans', 'popular'],
        additionalProperties: false,
      },
    });
    if (!res) return null;
    const json = parseJson(res.text);
    if (!json || typeof json !== 'object') return null;
    const used = new Set<number>();
    return (['moments', 'plans', 'popular'] as const).map((kind) => ({
      kind,
      lines: (Array.isArray(json[kind]) ? json[kind] : [])
        .map((l: { text?: unknown; posts?: unknown }): CatchUpLine | null => {
          const text = typeof l?.text === 'string' ? l.text.trim().slice(0, 200) : '';
          // Only posts that were given to the model, so a line can't point anywhere else.
          const idx = (Array.isArray(l?.posts) ? l.posts : []).filter(
            (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= posts.length,
          );
          const refs = [...new Set<number>(idx)].slice(0, 4);
          if (!text || !refs.length) return null;
          refs.forEach((n) => used.add(n));
          return { text, posts: refs.map((n) => linkOf(posts[n - 1]!)) };
        })
        .filter((l: CatchUpLine | null): l is CatchUpLine => !!l)
        .slice(0, LINES_PER_SECTION),
    }));
  }

  // ─── Smart replies ──────────────────────────────────────────────────────

  /**
   * Up to three short replies to the last message the person received in this chat, in the
   * chat's language. Only for members, only from messages they can see, never for view-once
   * messages, voice messages (there's no transcript) or sensitive messages. Cached per message.
   */
  async smartReplies(userId: string, conversationId: string, flag: boolean): Promise<SmartReplies> {
    return this.audited<SmartReplies>(userId, 'smart_replies', async (scopes) => {
      const member = (
        await this.db.query<{ kind: string; setting: boolean | null; everywhere: boolean }>(
          `SELECT c.kind, cm.smart_replies AS setting, ${smartRepliesEverywhereSql('$2')} AS everywhere
           FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
           WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
          [conversationId, userId],
        )
      ).rows[0];
      if (!member) throw notFound('Conversation');
      scopes.push(`conversation:${conversationId}`);
      const none = (reason: SmartReplies['reason'], messageId: string | null = null): { value: SmartReplies; quiet: true } => ({
        value: { messageId, suggestions: [], language: null, reason },
        quiet: true,
      });
      if (!smartRepliesState(member.kind, member.setting, member.everywhere, flag).on) return none('off');

      const { rows } = await this.db.query<{
        id: string;
        sender_id: string;
        name: string;
        body: string;
        lang: string | null;
        kind: string;
        view_once: boolean;
        attachments: { kind?: string; mediaId?: string }[] | null;
        moderation_status: string;
        rich: boolean;
      }>(
        `SELECT m.id, m.sender_id, pr.display_name AS name, m.body, m.lang, m.kind, m.view_once, m.attachments, m.moderation_status,
                EXISTS (SELECT 1 FROM chat_polls cp WHERE cp.message_id = m.id) OR EXISTS (SELECT 1 FROM chat_lists cl WHERE cl.message_id = m.id)
                  OR EXISTS (SELECT 1 FROM chat_games cg WHERE cg.message_id = m.id) OR (m.meta ? 'mixId')
                  OR EXISTS (SELECT 1 FROM location_shares ls WHERE ls.message_id = m.id) AS rich
         FROM messages m JOIN profiles pr ON pr.user_id = m.sender_id
         WHERE m.conversation_id = $1 AND ${messageVisibleSql('$2')} AND m.deleted_at IS NULL AND m.unsent_at IS NULL AND m.kind <> 'system'
         ORDER BY m.created_at DESC, m.id DESC LIMIT 12`,
        [conversationId, userId],
      );
      const last = rows[0];
      if (!last || last.sender_id === userId) return none('none');
      const attachments = last.attachments ?? [];
      if (last.view_once) return none('view_once', last.id);
      if (last.kind === 'yap' || attachments.some((a) => a.kind === 'audio')) return none('voice', last.id);
      if (!last.body.trim() || last.rich) return none('no_text', last.id);
      const mediaIds = attachments.map((a) => a.mediaId).filter((x): x is string => !!x);
      const flagged = mediaIds.length
        ? (await this.db.query(`SELECT 1 FROM media WHERE id = ANY($1::uuid[]) AND moderation IN ('sensitive', 'blocked')`, [mediaIds])).rowCount
        : 0;
      if (last.moderation_status !== 'normal' || analyzeText(last.body).risk !== 'normal' || SENSITIVE_TOPIC.test(last.body) || flagged)
        return none('sensitive', last.id);

      const hit = (
        await this.db.query<{ suggestions: string[]; lang: string | null; provider: string }>(
          `SELECT suggestions, lang, provider FROM ai_reply_suggestions WHERE user_id = $1 AND message_id = $2 AND created_at > now() - interval '1 day'`,
          [userId, last.id],
        )
      ).rows[0];
      if (hit)
        return {
          cache: true,
          value: { messageId: last.id, suggestions: hit.suggestions, language: hit.lang, provider: hit.provider, ...(this.dev ? { notice: DEV_NOTICE } : {}) },
        };

      await this.checkLimit(userId, 'smart_replies');
      const lang = baseLanguage(last.lang ?? detectLanguage(last.body) ?? (await this.locale(userId))) || 'en';
      let suggestions: string[];
      if (this.dev) suggestions = devReplies(last.body, lang);
      else {
        const transcript = [...rows]
          .reverse()
          .map((m) => `${m.sender_id === userId ? 'Me' : m.name}: ${m.view_once ? '[view-once photo]' : m.body.trim() ? m.body.slice(0, 500) : '[attachment]'}`)
          .join('\n');
        const res = await this.complete({
          system: [
            `Suggest up to 3 short replies that "Me" could send to the last message in this chat, written in ${languageName(lang, 'en')} and matching the chat's tone.`,
            'Each reply is under 8 words, natural and kind, with no emoji and no hashtags. Make them different from each other (for example yes, no, and a question back).',
            'Never agree to meet a stranger, share personal details or send money, and never make a promise beyond a simple yes or no.',
          ].join(' '),
          prompt: transcript,
          maxTokens: 300,
          schema: { type: 'object', properties: { replies: { type: 'array', items: { type: 'string' } } }, required: ['replies'], additionalProperties: false },
        });
        const json = res ? parseJson(res.text) : null;
        suggestions = Array.isArray(json?.replies) ? json.replies.filter((x: unknown): x is string => typeof x === 'string') : [];
      }
      const seen = new Set<string>();
      const clean = suggestions
        .map((s) =>
          s
            .trim()
            .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
            .slice(0, 80),
        )
        .filter((s) => {
          const k = s.toLocaleLowerCase();
          if (!s || seen.has(k) || analyzeText(s).risk !== 'normal') return false;
          seen.add(k);
          return true;
        })
        .slice(0, 3);
      await this.db.query(
        `INSERT INTO ai_reply_suggestions (user_id, message_id, suggestions, lang, provider, model) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, message_id) DO UPDATE SET suggestions = EXCLUDED.suggestions, lang = EXCLUDED.lang, created_at = now()`,
        [userId, last.id, JSON.stringify(clean), lang, this.provider.name, this.provider.model],
      );
      void track(this.db, userId, 'ai_smart_replies', { count: clean.length });
      return {
        value: { messageId: last.id, suggestions: clean, language: lang, provider: this.provider.name, ...(this.dev ? { notice: DEV_NOTICE } : {}) },
      };
    });
  }

  // ─── Photo descriptions ─────────────────────────────────────────────────

  /**
   * "Suggest a description" for one of your own photos (in the composer or when editing a
   * post). The photo goes to the model; the description comes back for you to edit.
   */
  async altText(userId: string, mediaId: string): Promise<AltTextSuggestion> {
    return this.audited<AltTextSuggestion>(userId, 'alt_text', async (scopes) => {
      const m = (
        await this.db.query<{ id: string; kind: string; storage_key: string | null; width: number | null; height: number | null }>(
          `SELECT id, kind, storage_key, width, height FROM media
           WHERE id = $1 AND owner_id = $2 AND NOT private AND deleted_at IS NULL AND moderation <> 'blocked'`,
          [mediaId, userId],
        )
      ).rows[0];
      if (!m) throw notFound('Photo');
      scopes.push(`media:${mediaId}`);
      if (m.kind !== 'image') throw new AppError(400, 'not_a_photo', 'Descriptions can be suggested for photos only.');
      await this.checkLimit(userId, 'alt_text');
      let text: string;
      if (this.dev) {
        const size = m.width && m.height ? ` (${m.width} × ${m.height})` : '';
        text = `[Placeholder] Photo${size}. Written by the development provider without looking at it: say what the photo shows.`;
      } else {
        const image = await this.imageFor(m.storage_key, 1024);
        const lang = await this.locale(userId);
        const res = await this.complete({
          system: [
            `Write alt text for a photo someone is about to post on a social app, for people who use screen readers, in ${languageName(lang, 'en')}.`,
            'One or two plain sentences, under 250 characters. Say what is visible: the setting, what is happening, and any important text.',
            'Describe people by what they are doing and wearing; never guess who they are, their age, ethnicity, health or other personal traits.',
            'Do not start with "Image of" or "Photo of". Reply with the description only.',
          ].join(' '),
          prompt: 'Describe this photo.',
          images: [image],
          maxTokens: 300,
        });
        text = (res?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
      }
      if (!text || !safe(text)) return { value: { mediaId, text: '', provider: this.provider.name, notice: HELD_NOTICE }, status: text ? 'blocked' : 'ok' };
      void track(this.db, userId, 'ai_alt_text', {});
      return { value: { mediaId, text, provider: this.provider.name, ...(this.dev ? { notice: DEV_NOTICE } : {}) } };
    });
  }

  /** A photo as the model sees it: at most `size` pixels on its longer side, as JPEG. */
  private async imageFor(key: string | null, size: number): Promise<{ mime: 'image/jpeg'; base64: string }> {
    if (!key || !this.storage) throw new AppError(503, 'ai_unavailable', 'This isn’t available right now. Try again later.');
    const original = await this.storage.read(key);
    const jpeg = await sharp(original).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { mime: 'image/jpeg', base64: jpeg.toString('base64') };
  }

  // ─── Caption and hashtag ideas ──────────────────────────────────────────

  /**
   * Three caption ideas in the person's voice (from what they've written so far, their
   * photos and, with Personalization on, their own recent posts), and hashtags people
   * already use on YAPILAPI that fit, trending ones first. Nothing is added to the post.
   */
  async captionIdeas(userId: string, input: { text: string; mediaIds: string[]; format: 'post' | 'reel' }): Promise<CaptionIdeas> {
    return this.audited<CaptionIdeas>(userId, 'caption_ideas', async (scopes) => {
      const ids = [...new Set(input.mediaIds)];
      const media = ids.length
        ? (
            await this.db.query<{ id: string; kind: string; storage_key: string | null; alt_text: string | null }>(
              `SELECT id, kind, storage_key, alt_text FROM media
               WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND NOT private AND deleted_at IS NULL AND moderation <> 'blocked'`,
              [ids, userId],
            )
          ).rows
        : [];
      if (media.length !== ids.length) throw notFound('Photo');
      scopes.push('input', ...ids.map((id) => `media:${id}`));
      if (analyzeText(input.text).risk === 'escalate') throw forbidden('This request can’t be processed.');
      await this.checkLimit(userId, 'caption_ideas');

      const personalized = await personalizationAllowed(this.db, userId);
      const voice = personalized
        ? (
            await this.db.query<{ body: string }>(
              `SELECT body FROM posts WHERE author_id = $1 AND deleted_at IS NULL AND status = 'published' AND body <> '' ORDER BY created_at DESC LIMIT 8`,
              [userId],
            )
          ).rows.map((r) => r.body.slice(0, 300))
        : [];
      if (voice.length) scopes.push('own_posts');
      const described = [input.text, ...media.map((m) => m.alt_text ?? '')].join(' ');
      const tags = await this.hashtagCandidates(userId, described, personalized);
      scopes.push('hashtags');
      const already = new Set(extractHashtags(input.text, 30));

      let captions: string[];
      let hashtags: string[];
      if (this.dev) {
        captions = devCaptions(
          input.text,
          media.map((m) => m.alt_text ?? ''),
        );
        hashtags = tags.relevant.slice(0, 5);
      } else {
        const images = await Promise.all(media.filter((m) => m.kind === 'image').map((m) => this.imageFor(m.storage_key, 768)));
        const lang = detectLanguage(input.text) ?? (await this.locale(userId));
        const candidates = [...new Set([...tags.relevant.slice(0, 30), ...tags.trending.slice(0, 20)])];
        const res = await this.complete({
          system: [
            `Suggest 3 different captions for a ${input.format === 'reel' ? 'short video' : 'post'} on a social app, in ${languageName(lang, 'en')}.`,
            'Write them in the person’s own voice: match the tone, length and style of their earlier posts when given, and keep what they already wrote.',
            'Each caption is under 200 characters, plain and specific to the photos and text; no hashtags inside the captions, no emoji unless their earlier posts use them.',
            'Then pick up to 5 hashtags from the candidate list only (without "#"), the most relevant first; pick none if none fit.',
          ].join(' '),
          prompt: [
            `What they wrote so far: ${input.text.trim() || '(nothing yet)'}`,
            voice.length ? `Their earlier posts:\n${voice.map((v) => `- ${v}`).join('\n')}` : '',
            `Candidate hashtags: ${candidates.join(', ') || '(none)'}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
          images,
          maxTokens: 800,
          schema: {
            type: 'object',
            properties: { captions: { type: 'array', items: { type: 'string' } }, hashtags: { type: 'array', items: { type: 'string' } } },
            required: ['captions', 'hashtags'],
            additionalProperties: false,
          },
        });
        const json = res ? parseJson(res.text) : null;
        captions = Array.isArray(json?.captions) ? json.captions.filter((x: unknown): x is string => typeof x === 'string') : [];
        const allowed = new Set(candidates);
        // Only tags people already use here, whatever the model says.
        hashtags = (Array.isArray(json?.hashtags) ? json.hashtags : [])
          .filter((x: unknown): x is string => typeof x === 'string')
          .map((x: string) => normalizeTag(x))
          .filter((x: string) => allowed.has(x));
      }
      const seen = new Set<string>();
      const cleanCaptions = captions
        .map((c) =>
          c
            .replace(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu, '$1')
            .replace(/[ \t]+/g, ' ')
            .trim()
            .slice(0, 2200),
        )
        .filter((c) => {
          if (!c || seen.has(c) || !safe(c)) return false;
          seen.add(c);
          return true;
        })
        .slice(0, 3);
      const cleanTags = [...new Set(hashtags)].filter((t) => !already.has(t)).slice(0, 5);
      void track(this.db, userId, 'ai_caption_ideas', { captions: cleanCaptions.length, hashtags: cleanTags.length });
      return {
        value: {
          captions: cleanCaptions,
          hashtags: cleanTags,
          provider: this.provider.name,
          ...(this.dev ? { notice: DEV_NOTICE } : cleanCaptions.length < captions.length ? { notice: HELD_NOTICE } : {}),
        },
      };
    });
  }

  /**
   * Hashtags already used on YAPILAPI: in public, unflagged posts of the last 90 days (and,
   * with Personalization on, the person's own). `relevant` match a word of the text (whole
   * word, or the start of one), most-used and trending first; `trending` are the most used
   * this week whatever the text.
   */
  private async hashtagCandidates(userId: string, text: string, own: boolean): Promise<{ relevant: string[]; trending: string[] }> {
    const { rows } = await this.db.query<{ tag: string; people: number; week: number; mine: boolean }>(
      `WITH uses AS (
         SELECT t, p.author_id, p.created_at FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id, unnest(p.topics) t
         WHERE p.created_at > now() - interval '90 days' AND ${PUBLIC_POST}
         UNION ALL
         SELECT t, p.author_id, p.created_at FROM posts p, unnest(p.topics) t
         WHERE $2 AND p.author_id = $1 AND p.deleted_at IS NULL AND p.status = 'published' AND p.moderation_status = 'normal'
       )
       SELECT t AS tag, count(DISTINCT author_id)::int AS people,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
              bool_or(author_id = $1) AS mine
       FROM uses GROUP BY t
       ORDER BY count(DISTINCT author_id) * 3 + count(*) FILTER (WHERE created_at > now() - interval '7 days') * 2 DESC, t
       LIMIT 500`,
      [userId, own],
    );
    const words = new Set(
      (
        text
          .toLocaleLowerCase('und')
          .normalize('NFC')
          .match(/[\p{L}\p{M}\p{N}_]{3,40}/gu) ?? []
      ).map((w) => w.replace(/^#/, '')),
    );
    const score = (tag: string) => {
      if (words.has(tag)) return 10;
      for (const w of words) if ((w.length >= 4 && tag.startsWith(w)) || (tag.length >= 4 && w.startsWith(tag))) return 5;
      return 0;
    };
    const popularity = (r: { people: number; week: number; mine: boolean }) => Math.min(r.people, 20) / 4 + (r.week > 0 ? 2 : 0) + (r.mine ? 1 : 0);
    const relevant = rows
      .map((r) => ({ tag: r.tag, s: score(r.tag), p: popularity(r) }))
      .filter((r) => r.s > 0 && /^[\p{L}\p{M}\p{N}_]{2,40}$/u.test(r.tag))
      .sort((a, b) => b.s + b.p - (a.s + a.p) || a.tag.localeCompare(b.tag))
      .map((r) => r.tag);
    return { relevant, trending: rows.filter((r) => r.week > 0).map((r) => r.tag) };
  }
}

const linkOf = (p: WindowPost) => ({ id: p.id, authorName: p.name, authorUsername: p.username });

/** The dev provider's catch-up: plans and big moments by keywords, then the posts with the most likes and comments. */
function devCatchUp(posts: WindowPost[]): CatchUpSection[] {
  const taken = new Set<string>();
  const pick = (test: (p: WindowPost) => boolean) =>
    posts
      .filter((p) => !taken.has(p.id) && test(p))
      .slice(0, LINES_PER_SECTION)
      .map((p) => {
        taken.add(p.id);
        return { text: `${p.name}: ${firstSentence(p.body) || p.event_title || p.kind}`, posts: [linkOf(p)] };
      });
  const plans = pick((p) => !!p.event_title || PLANS.test(p.body));
  const moments = pick((p) => MOMENTS.test(p.body));
  const popular = pick(() => true);
  return [
    { kind: 'moments' as const, lines: moments },
    { kind: 'plans' as const, lines: plans },
    { kind: 'popular' as const, lines: popular },
  ].filter((s) => s.lines.length);
}

const DEV_REPLIES: Record<string, { question: string[]; other: string[] }> = {
  en: { question: ['Yes', 'Not sure yet', 'Let me check'], other: ['Sounds good', 'Thanks', 'Talk soon'] },
  fr: { question: ['Oui', 'Je ne sais pas encore', 'Je vérifie'], other: ['Ça marche', 'Merci', 'À bientôt'] },
  es: { question: ['Sí', 'Aún no lo sé', 'Déjame ver'], other: ['Suena bien', 'Gracias', 'Hablamos pronto'] },
  pt: { question: ['Sim', 'Ainda não sei', 'Vou ver'], other: ['Combinado', 'Obrigado', 'Até logo'] },
  sw: { question: ['Ndiyo', 'Sijui bado', 'Nitaangalia'], other: ['Sawa', 'Asante', 'Tutaongea'] },
  ar: { question: ['نعم', 'لست متأكدًا بعد', 'سأتحقق'], other: ['يبدو جيدًا', 'شكرًا', 'نتحدث قريبًا'] },
  yo: { question: ['Bẹ́ẹ̀ni', 'Mi ò tíì mọ̀', 'Jẹ́ kí n wò ó'], other: ['Ó dáa', 'Ẹ ṣé', 'A ó sọ̀rọ̀'] },
  ha: { question: ['Eh', 'Ban sani ba tukuna', 'Bari in duba'], other: ['Yayi kyau', 'Na gode', 'Sai an jima'] },
};

/** The dev provider's replies: fixed ones per language, for a question or anything else. */
export function devReplies(body: string, lang: string): string[] {
  const set = DEV_REPLIES[lang] ?? DEV_REPLIES.en!;
  return /[?؟]\s*$/.test(body.trim()) ? set.question : set.other;
}

/** The dev provider's captions: three fixed shapes around what was written (or the photo's description). */
export function devCaptions(text: string, alts: string[]): string[] {
  const base = firstSentence(text, 140) || firstSentence(alts.find((a) => a.trim()) ?? '', 140) || 'A new post';
  const plain = base.replace(/[.!?…]+$/, '');
  return [base, `${plain}. More soon.`, `Today: ${plain.charAt(0).toLocaleLowerCase()}${plain.slice(1)}`];
}
