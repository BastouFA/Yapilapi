import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { detectLanguage, understoodLanguages, type TranslatableKind } from '@yapilapi/shared';
import { getFlags } from './services.ts';
import { seesSensitiveSql } from './interactions.ts';
import { notFound } from './errors.ts';
import { messageVisibleSql } from './chat.ts';
import { storyVisibleSql } from './stories.ts';
import { commentVisibleSql } from './comments.ts';
import { postUnlockedSql, postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * "See translation" and automatic translation (docs/product/speak-any-language.md). The
 * language of text is detected when it's written (`detectLanguage`, stored in a `lang`
 * column); translations are made through the AI gateway (AiGateway.translateItem and
 * translateMany) and kept per item, target language and version of the text, so an edit
 * never shows an old translation and everyone who reads the same text shares one.
 */

/** The language to store for a piece of text, or null when it can't be told. */
export const langOf = (text: string | null | undefined): string | null => detectLanguage(text);

/** What can be cached: the four kinds people read, and caption tracks (their WebVTT). */
export type CachedKind = TranslatableKind | 'caption';

export interface TranslatableItem {
  kind: TranslatableKind;
  id: string;
  text: string;
  /** Stored language, or detected now for text written before detection existed. */
  lang: string | null;
}

const WHAT: Record<TranslatableKind, string> = { post: 'That post', comment: 'That comment', story: 'That story', message: 'Message', transcript: 'Message' };

/**
 * Which of `ids` `viewer` can see right now, with their text: posts they can see and open
 * (audience, blocks, regional rules, subscriptions), comments on those posts that they'd be
 * shown, stories they can open, and messages in chats they're still a member of. With `auto`,
 * view-once messages are left out too: their words are never copied without a tap. A transcript
 * (by its message's id) is a voice message's words, as the message's reader sees it (its voice
 * clip not taken down, or sensitive for someone who doesn't see sensitive media), while
 * VOICE_TRANSCRIPTS and VOICE_TRANSLATION are on; view-once and disappearing messages never have one.
 */
export async function loadTranslatables(
  db: Q,
  viewer: string,
  kind: TranslatableKind,
  ids: string[],
  opts: { auto?: boolean } = {},
): Promise<TranslatableItem[]> {
  if (!ids.length) return [];
  const sql: Record<TranslatableKind, string> = {
    post: `SELECT p.id, p.body, p.lang FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
           WHERE p.id = ANY($2::uuid[]) AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')}`,
    comment: `SELECT cm.id, cm.body, cm.lang FROM comments cm
              JOIN posts p ON p.id = cm.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
              WHERE cm.id = ANY($2::uuid[]) AND ${commentVisibleSql('$1')} AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')}`,
    story: `SELECT m.id, m.body, m.lang FROM moments m JOIN users au ON au.id = m.author_id WHERE m.id = ANY($2::uuid[]) AND ${storyVisibleSql('$1', { open: true })}`,
    message: `SELECT m.id, m.body, m.lang FROM messages m
              JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.left_at IS NULL
              WHERE m.id = ANY($2::uuid[]) AND m.kind <> 'system' AND m.deleted_at IS NULL AND m.unsent_at IS NULL AND ${messageVisibleSql('$1')}
                ${opts.auto ? 'AND NOT m.view_once' : ''}`,
    transcript: `SELECT m.id, t.body, t.lang FROM message_transcripts t JOIN messages m ON m.id = t.message_id
              JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.left_at IS NULL
              LEFT JOIN media md ON md.id = (m.attachments->0->>'mediaId')::uuid
              WHERE m.id = ANY($2::uuid[]) AND t.status = 'ready' AND m.deleted_at IS NULL AND NOT m.view_once AND m.expires_at IS NULL
                AND ${messageVisibleSql('$1')}
                AND md.id IS NOT NULL AND md.moderation <> 'blocked' AND (md.moderation <> 'sensitive' OR ${seesSensitiveSql('$1')})`,
  };
  if (kind === 'transcript') {
    const flags = await getFlags(db);
    if (!flags.VOICE_TRANSCRIPTS || !flags.VOICE_TRANSLATION) return [];
  }
  const { rows } = await db.query<{ id: string; body: string | null; lang: string | null }>(sql[kind], [viewer, ids]);
  return rows.map((r) => ({ kind, id: r.id, text: r.body ?? '', lang: r.lang ?? langOf(r.body ?? '') }));
}

/** One item, only when `viewer` can see it right now (loadTranslatables). Anyone else gets "not found", which reveals nothing. */
export async function loadTranslatable(db: Q, viewer: string, kind: TranslatableKind, id: string): Promise<TranslatableItem> {
  const [item] = await loadTranslatables(db, viewer, kind, [id]);
  if (!item) throw notFound(WHAT[kind]);
  return item;
}

/** Identifies one version of a text: a new text (an edit) gets a new cache entry. */
export const contentHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface CachedTranslation {
  body: string;
  sourceLanguage: string;
  provider: string;
  model: string;
}

/**
 * The cached translation of this version of an item's text. Pseudo-translations from the
 * offline stand-in ('dev') only count while the stand-in is the translator.
 */
export async function cachedTranslation(
  db: Q,
  item: { kind: CachedKind; id: string; text: string },
  target: string,
  opts: { standIn?: boolean } = {},
): Promise<CachedTranslation | null> {
  const { rows } = await db.query<CachedTranslation>(
    `SELECT body, source_lang AS "sourceLanguage", provider, model FROM translations
     WHERE kind = $1 AND item_id = $2 AND target = $3 AND content_hash = $4 AND (provider <> 'dev' OR $5)`,
    [item.kind, item.id, target, contentHash(item.text), !!opts.standIn],
  );
  return rows[0] ?? null;
}

/** cachedTranslation for many items at once, by `kind:id`. */
export async function cachedTranslations(
  db: Q,
  items: TranslatableItem[],
  target: string,
  opts: { standIn?: boolean } = {},
): Promise<Map<string, CachedTranslation>> {
  const out = new Map<string, CachedTranslation>();
  if (!items.length) return out;
  const { rows } = await db.query<CachedTranslation & { kind: string; id: string }>(
    `SELECT t.kind, t.item_id AS id, t.body, t.source_lang AS "sourceLanguage", t.provider, t.model
     FROM unnest($1::text[], $2::uuid[], $3::text[]) AS x(kind, id, hash)
     JOIN translations t ON t.kind = x.kind AND t.item_id = x.id AND t.content_hash = x.hash AND t.target = $4
     WHERE t.provider <> 'dev' OR $5`,
    [items.map((i) => i.kind), items.map((i) => i.id), items.map((i) => contentHash(i.text)), target, !!opts.standIn],
  );
  for (const r of rows) out.set(`${r.kind}:${r.id}`, { body: r.body, sourceLanguage: r.sourceLanguage, provider: r.provider, model: r.model });
  return out;
}

/** Keep a translation of this version of the text; translations of earlier versions go. */
export async function storeTranslation(
  db: Q,
  t: { kind: CachedKind; id: string; text: string; target: string; sourceLanguage: string; body: string; provider: string; model: string },
): Promise<void> {
  const hash = contentHash(t.text);
  await db.query(`DELETE FROM translations WHERE kind = $1 AND item_id = $2 AND content_hash <> $3`, [t.kind, t.id, hash]);
  await db.query(
    `INSERT INTO translations (kind, item_id, target, content_hash, source_lang, body, provider, model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (kind, item_id, target, content_hash) DO UPDATE SET body = EXCLUDED.body, source_lang = EXCLUDED.source_lang,
       provider = EXCLUDED.provider, model = EXCLUDED.model, created_at = now()`,
    [t.kind, t.id, t.target, hash, t.sourceLanguage, t.body, t.provider, t.model],
  );
}

/**
 * Translations this person asked for in the last hour (from the AI audit log), for the
 * per-person limit on "See translation" and caption tracks. Automatic ones count separately.
 */
export async function translationsLastHour(db: Q, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_tool_calls
     WHERE user_id = $1 AND task = 'translate' AND created_at > now() - interval '1 hour' AND NOT ('auto' = ANY(context_scopes))`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/** New automatic translations this person's screens caused in the last hour (cached ones are free). */
export async function autoTranslationsLastHour(db: Q, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_tool_calls
     WHERE user_id = $1 AND task = 'translate' AND created_at > now() - interval '1 hour'
       AND 'auto' = ANY(context_scopes) AND NOT ('cache' = ANY(context_scopes)) AND status <> 'denied'`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Take `n` slots of today's (UTC) budget of new automatic translations, all or none: false
 * once AUTO_TRANSLATE_DAILY_LIMIT would be passed. Taken before the model is asked, so
 * requests at the same moment can't go over between them.
 */
export async function takeTranslationBudget(db: Q, n: number, limit: number): Promise<boolean> {
  if (n <= 0) return true;
  if (n > limit) return false;
  const { rowCount } = await db.query(
    `INSERT INTO translation_budget AS b (day, used) VALUES ((now() AT TIME ZONE 'utc')::date, $1)
     ON CONFLICT (day) DO UPDATE SET used = b.used + $1 WHERE b.used + $1 <= $2`,
    [n, limit],
  );
  return !!rowCount;
}

/**
 * For the recommender: the languages a reader understands (their app's language and the
 * ones they listed), and whether text in other languages reaches them translated without a
 * tap (their switch, both flags, and a real translation model).
 */
export async function readerLanguages(db: Q, userId: string, machineTranslation: boolean): Promise<{ understood: string[]; translated: boolean }> {
  const [{ rows }, flags] = await Promise.all([
    db.query<{ locale: string | null; languages: string[] | null; auto_translate: boolean | null }>(
      `SELECT pr.locale, up.languages, up.auto_translate FROM profiles pr LEFT JOIN user_preferences up ON up.user_id = pr.user_id WHERE pr.user_id = $1`,
      [userId],
    ),
    getFlags(db),
  ]);
  const r = rows[0];
  return {
    understood: understoodLanguages(r?.locale ?? 'en', r?.languages),
    translated: machineTranslation && flags.AI_TRANSLATION && flags.AUTO_TRANSLATE && (r?.auto_translate ?? true),
  };
}

/** A reader's translation settings as stored ("Translate automatically" is on until they turn it off). */
export async function translationSettings(db: Q, userId: string): Promise<{ languages: string[]; auto: boolean }> {
  const { rows } = await db.query<{ languages: string[]; auto_translate: boolean }>(
    `SELECT languages, auto_translate FROM user_preferences WHERE user_id = $1`,
    [userId],
  );
  return { languages: rows[0]?.languages ?? [], auto: rows[0]?.auto_translate ?? true };
}
