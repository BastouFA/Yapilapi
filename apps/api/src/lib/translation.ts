import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { detectLanguage, type TranslatableKind } from '@yapilapi/shared';
import { notFound } from './errors.ts';
import { messageVisibleSql } from './chat.ts';
import { storyVisibleSql } from './stories.ts';
import { commentVisibleSql } from './comments.ts';
import { postUnlockedSql, postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * "See translation". The language of text is detected when it's written
 * (`detectLanguage`, stored in a `lang` column); translations are made through
 * the AI gateway (AiGateway.translateItem) and kept per item, target language
 * and version of the text, so an edit never shows an old translation.
 */

/** The language to store for a piece of text, or null when it can't be told. */
export const langOf = (text: string | null | undefined): string | null => detectLanguage(text);

export interface TranslatableItem {
  kind: TranslatableKind;
  id: string;
  text: string;
  /** Stored language, or detected now for text written before detection existed. */
  lang: string | null;
}

const WHAT: Record<TranslatableKind, string> = { post: 'That post', comment: 'That comment', story: 'That story', message: 'Message' };

/**
 * The text of an item, only when `viewer` can see it right now: posts they can see
 * and open (audience, blocks, regional rules, subscriptions), comments on those
 * posts that they'd be shown, stories they can open, and messages in chats they're
 * still a member of. Anyone else gets "not found", which reveals nothing.
 */
export async function loadTranslatable(db: Q, viewer: string, kind: TranslatableKind, id: string): Promise<TranslatableItem> {
  const sql: Record<TranslatableKind, string> = {
    post: `SELECT p.body, p.lang FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
           WHERE p.id = $2 AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')}`,
    comment: `SELECT cm.body, cm.lang FROM comments cm
              JOIN posts p ON p.id = cm.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
              WHERE cm.id = $2 AND ${commentVisibleSql('$1')} AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')}`,
    story: `SELECT m.body, m.lang FROM moments m JOIN users au ON au.id = m.author_id WHERE m.id = $2 AND ${storyVisibleSql('$1', { open: true })}`,
    message: `SELECT m.body, m.lang FROM messages m
              JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.left_at IS NULL
              WHERE m.id = $2 AND m.kind <> 'system' AND m.deleted_at IS NULL AND m.unsent_at IS NULL AND ${messageVisibleSql('$1')}`,
  };
  const { rows } = await db.query<{ body: string | null; lang: string | null }>(sql[kind], [viewer, id]);
  const row = rows[0];
  if (!row) throw notFound(WHAT[kind]);
  const text = row.body ?? '';
  return { kind, id, text, lang: row.lang ?? langOf(text) };
}

/** Identifies one version of a text: a new text (an edit) gets a new cache entry. */
export const contentHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface CachedTranslation {
  body: string;
  sourceLanguage: string;
  provider: string;
  model: string;
}

export async function cachedTranslation(db: Q, item: TranslatableItem, target: string): Promise<CachedTranslation | null> {
  const { rows } = await db.query<CachedTranslation>(
    `SELECT body, source_lang AS "sourceLanguage", provider, model FROM translations WHERE kind = $1 AND item_id = $2 AND target = $3 AND content_hash = $4`,
    [item.kind, item.id, target, contentHash(item.text)],
  );
  return rows[0] ?? null;
}

/** Keep a translation of this version of the text; translations of earlier versions go. */
export async function storeTranslation(
  db: Q,
  t: { kind: TranslatableKind; id: string; text: string; target: string; sourceLanguage: string; body: string; provider: string; model: string },
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

/** Translations this person asked for in the last hour (from the AI audit log), for the per-person limit. */
export async function translationsLastHour(db: Q, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_tool_calls WHERE user_id = $1 AND task = 'translate' AND created_at > now() - interval '1 hour'`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/** A reader's translation settings as stored. */
export async function translationSettings(db: Q, userId: string): Promise<{ languages: string[]; auto: boolean }> {
  const { rows } = await db.query<{ languages: string[]; auto_translate: boolean }>(
    `SELECT languages, auto_translate FROM user_preferences WHERE user_id = $1`,
    [userId],
  );
  return { languages: rows[0]?.languages ?? [], auto: !!rows[0]?.auto_translate };
}
