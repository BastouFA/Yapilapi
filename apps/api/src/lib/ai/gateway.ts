import type { Pool } from 'pg';
import {
  languageName,
  needsTranslation,
  protectForTranslation,
  restoreTranslation,
  worthTranslating,
  type TranslatableKind,
  type Translation,
  type TranslationBatch,
} from '@yapilapi/shared';
import { messageVisibleSql } from '../chat.ts';
import { analyzeText } from '../moderation.ts';
import { AppError, forbidden, notFound } from '../errors.ts';
import {
  autoTranslationsLastHour,
  cachedTranslation,
  cachedTranslations,
  contentHash,
  loadTranslatable,
  loadTranslatables,
  storeTranslation,
  takeTranslationBudget,
  type TranslatableItem,
} from '../translation.ts';
import { parseSearchIntent } from './intent.ts';
import { postUnlockedSql, postVisibleSql } from '../visibility.ts';
import type { AiProvider } from './providers.ts';
import { runAgent, type AgentKind } from './agents.ts';
import { AiAssists } from './assists.ts';
import type { MediaStorage } from '../storage.ts';

export type AiTask = 'caption' | 'summarize_conversation' | 'summarize_community' | 'search_intent' | 'plan_from_message' | 'translate' | 'memory_recap';

export interface AiRequest {
  userId: string;
  task: AiTask;
  input: string;
  conversationId?: string;
  communityId?: string;
  memoryId?: string;
  targetLanguage?: string;
  /** translate: the language of the text, when known (it helps the model with short texts). */
  sourceLanguage?: string;
  /** translate: a post, comment, story or message, read (after the permission check) instead of `input`. */
  item?: { kind: TranslatableKind; id: string };
  /** translate: made for automatic translation (logged with the scope "auto", counted against its limits). */
  auto?: boolean;
}

/** Translations being made right now, by item, target and version of the text: readers asking at the same moment share one. */
const making = new Map<string, Promise<Translation | null>>();

/** How long POST /v1/translations waits for new translations before answering with the rest as pending. */
const BATCH_WAIT_MS = 3500;
/** New translations made at the same time for one batch. */
const BATCH_PARALLEL = 4;
/** Caption lines per model request. */
const CAPTION_CHUNK = 50;

export interface GatewayOptions {
  /** The model for translations (AI_TRANSLATE_MODEL); the main provider when not given. */
  translator?: AiProvider;
  /**
   * Production: the offline stand-in never answers "See translation" or translates captions
   * (its pseudo-translations must not reach people as if they were real).
   */
  realTranslationsOnly?: boolean;
}

export interface AiResponse {
  task: AiTask;
  output: unknown;
  provider: string;
  model: string;
  /** Data the model was allowed to read for this request. */
  contextScopes: string[];
  notice?: string;
}

/**
 * AI Gateway → Permission Engine → Context Engine → Model Router → Safety Layer → Response.
 *
 * Authorization happens BEFORE any context is loaded, and context only ever
 * contains data the requesting user can already see. Every call is logged to
 * ai_tool_calls (task, scopes, provider, status) without storing content.
 */
export class AiGateway {
  /** Catch me up, suggested replies, photo descriptions and caption ideas (see assists.ts). */
  readonly assists: AiAssists;
  private translator: AiProvider;
  private realTranslationsOnly: boolean;

  constructor(
    private db: Pool,
    private provider: AiProvider,
    storage: MediaStorage | null = null,
    opts: GatewayOptions = {},
  ) {
    this.assists = new AiAssists(db, provider, storage);
    this.translator = opts.translator ?? provider;
    this.realTranslationsOnly = !!opts.realTranslationsOnly;
  }

  get providerName() {
    return this.provider.name;
  }

  /**
   * Whether translations are made by a real model. With the offline stand-in, automatic
   * translation stays off (and translated caption tracks aren't offered); it turns on by
   * itself once a model is configured.
   */
  get machineTranslation() {
    return this.translator.name !== 'dev';
  }

  private standInRefused() {
    if (this.realTranslationsOnly && !this.machineTranslation)
      throw new AppError(503, 'translation_unavailable', 'Translation isn’t available right now. Try again later.');
  }

  /** Multi-step assistants (Discover, trips, shopping, business). See agents.ts for how their tools stay within the person's permissions. */
  agent(userId: string, kind: AgentKind, prompt: string, opts: { businessId?: string } = {}) {
    return runAgent(this.db, this.provider, userId, kind, prompt, opts);
  }

  async run(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    // Translations have a model of their own (AI_TRANSLATE_MODEL).
    const provider = this.providerFor(req.task);
    let scopes: string[] = [];
    try {
      // 1. Permission engine + 2. context engine
      const ctx = await this.loadContext(req);
      scopes = ctx.scopes;

      // Input safety: refuse to process content that is itself high-risk (for a translation, the text being translated).
      if (analyzeText(req.task === 'translate' ? ctx.text : req.input).risk === 'escalate') throw forbidden('This request can’t be processed.');

      // 3. Model router + 4. task execution
      const output = await this.execute(req, ctx.text);

      // 5. Output safety layer
      const flat = typeof output === 'string' ? output : JSON.stringify(output);
      if (analyzeText(flat).risk === 'escalate' || analyzeText(flat).risk === 'restrict') {
        await this.log(req, scopes, 'blocked', started);
        return {
          task: req.task,
          output: null,
          provider: provider.name,
          model: provider.model,
          contextScopes: scopes,
          notice: 'The result was withheld by safety filters.',
        };
      }
      await this.log(req, scopes, 'ok', started);
      return {
        task: req.task,
        output,
        provider: provider.name,
        model: provider.model,
        contextScopes: scopes,
        notice:
          provider.name !== 'dev'
            ? undefined
            : req.task === 'translate'
              ? 'Pseudo-translation from the local development provider (no model).'
              : 'Generated by the local development provider (rule-based, no model).',
      };
    } catch (err) {
      const code = (err as { status?: number }).status;
      const status = code === 403 || code === 404 ? 'denied' : 'error';
      await this.log(req, scopes, status, started);
      throw err;
    }
  }

  /**
   * "See translation" for a post, comment, story or message, into `target`. The
   * permission check comes first (the item must be one the person can see right
   * now), then the cache for this version of the text, then the model. Every
   * request is logged to ai_tool_calls, cached answers included (scope "cache").
   */
  async translateItem(req: { userId: string; kind: TranslatableKind; id: string; target: string }): Promise<Translation> {
    this.standInRefused();
    const started = Date.now();
    const scopes = [`${req.kind}:${req.id}`];
    const logReq: AiRequest = { userId: req.userId, task: 'translate', input: '' };
    let item;
    try {
      item = await loadTranslatable(this.db, req.userId, req.kind, req.id);
    } catch (err) {
      await this.log(logReq, scopes, 'denied', started);
      throw err;
    }
    if (!item.text.trim()) throw new AppError(400, 'nothing_to_translate', 'There’s no text to translate.');
    if (item.lang === req.target) throw new AppError(400, 'same_language', 'This is already in that language.');
    const hit = await cachedTranslation(this.db, item, req.target, { standIn: !this.machineTranslation });
    if (hit) {
      await this.log(logReq, [...scopes, 'cache'], 'ok', started, hit);
      return toTranslation(item, req.target, hit.body, hit.sourceLanguage, hit.provider, true);
    }
    const made = await this.make(item, req.target, req.userId, false);
    if ('error' in made) throw made.error;
    return made.translation;
  }

  /**
   * Translate one item with the model and keep it for everyone (the cache). The model call
   * reads the item again through the permission check (loadContext).
   */
  private async make(item: TranslatableItem, target: string, userId: string, auto: boolean): Promise<{ translation: Translation } | { error: unknown }> {
    let res: AiResponse;
    try {
      res = await this.run({
        userId,
        task: 'translate',
        input: '',
        item: { kind: item.kind, id: item.id },
        targetLanguage: target,
        sourceLanguage: item.lang ?? undefined,
        auto,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status < 500) return { error: err };
      return { error: new AppError(503, 'translation_unavailable', 'Translation isn’t available right now. Try again later.') };
    }
    const out = res.output as { original?: string; translated?: string | null } | null;
    if (!out?.translated)
      return { error: new AppError(503, 'translation_unavailable', res.notice ?? 'This couldn’t be translated right now. Try again later.') };
    const sourceLanguage = item.lang ?? 'und';
    // Cached against the text that was actually translated.
    await storeTranslation(this.db, {
      kind: item.kind,
      id: item.id,
      text: out.original ?? item.text,
      target,
      sourceLanguage,
      body: out.translated,
      provider: res.provider,
      model: res.model,
    });
    return { translation: toTranslation(item, target, out.translated, sourceLanguage, res.provider, false) };
  }

  /**
   * Automatic translation of what's on a reader's screen (POST /v1/translations). Every item
   * goes through the same permission check as "See translation" (one query per kind); items
   * the reader can't see, in a language they understand (`understood`), without enough words,
   * or in a language that couldn't be told are left out silently. Cached translations come
   * back at once, whoever they were made for. New ones are made a few at a time, within the
   * reader's hourly limit and the day's budget for everyone, and only by a real model; any not
   * ready after a few seconds are `pending`, to ask about again. Cache hits are logged as one
   * audit entry per batch, each new translation as its own (both with the scope "auto").
   */
  async translateMany(req: {
    userId: string;
    target: string;
    items: { kind: TranslatableKind; id: string }[];
    understood: string[];
    perHour: number;
    dailyLimit: number;
    waitMs?: number;
  }): Promise<TranslationBatch> {
    const started = Date.now();
    const byKind = new Map<TranslatableKind, Set<string>>();
    for (const i of req.items) byKind.set(i.kind, (byKind.get(i.kind) ?? new Set()).add(i.id));
    const visible = (await Promise.all([...byKind].map(([kind, ids]) => loadTranslatables(this.db, req.userId, kind, [...ids], { auto: true })))).flat();
    // Text in a language the reader understands is never translated (the target is their app's language).
    // In the order asked (the order on screen), so the first ones are made first.
    const order = new Map(req.items.map((i, n) => [`${i.kind}:${i.id}`, n]));
    const wanted = visible
      .filter((i) => worthTranslating(i.text) && needsTranslation(i.lang, req.target, req.understood))
      .sort((a, b) => order.get(`${a.kind}:${a.id}`)! - order.get(`${b.kind}:${b.id}`)!);

    // Pseudo-translations from the offline stand-in are never shown as automatic ones.
    const hits = await cachedTranslations(this.db, wanted, req.target);
    const items: Translation[] = [];
    const misses: TranslatableItem[] = [];
    for (const i of wanted) {
      const hit = hits.get(`${i.kind}:${i.id}`);
      if (hit) items.push(toTranslation(i, req.target, hit.body, hit.sourceLanguage, hit.provider, true));
      else misses.push(i);
    }
    if (items.length)
      await this.log({ userId: req.userId, task: 'translate', input: '' }, ['auto', 'cache', ...items.map((t) => `${t.kind}:${t.id}`)], 'ok', started);
    if (!misses.length) return { items, pending: [], auto: true };
    // The offline stand-in never translates automatically.
    if (!this.machineTranslation) return { items, pending: [], auto: false };

    let auto = true;
    const asked: { item: TranslatableItem; promise: Promise<Translation | null> }[] = [];
    const mine: { item: TranslatableItem; key: string; settle: (t: Translation | null) => void }[] = [];
    // Claimed before anything is awaited, so a reader asking at the same moment waits for this one.
    for (const item of misses) {
      const key = `${item.kind}:${item.id}:${req.target}:${contentHash(item.text)}`;
      const running = making.get(key);
      if (running) {
        // Another reader's screen asked a moment ago: wait for that one.
        asked.push({ item, promise: running });
        continue;
      }
      let settle!: (t: Translation | null) => void;
      const promise = new Promise<Translation | null>((r) => (settle = r)).finally(() => making.delete(key));
      making.set(key, promise);
      mine.push({ item, key, settle });
    }
    let allowance = req.perHour - (await autoTranslationsLastHour(this.db, req.userId));
    for (const m of mine) {
      if (!auto || allowance <= 0 || !(await takeTranslationBudget(this.db, 1, req.dailyLimit))) {
        // Past a limit: this one isn't made now, and keeps "See translation".
        auto = false;
        m.settle(null);
        continue;
      }
      allowance--;
      asked.push({ item: m.item, promise: making.get(m.key)! });
      this.oneAtATime(() => this.make(m.item, req.target, req.userId, true))
        .then((r) => m.settle('translation' in r ? r.translation : null))
        .catch(() => m.settle(null));
    }

    const done = new Map<TranslatableItem, Translation | null>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(asked.map(({ item, promise }) => promise.then((t) => void done.set(item, t)))),
      new Promise((r) => (timer = setTimeout(r, req.waitMs ?? BATCH_WAIT_MS))),
    ]);
    clearTimeout(timer);
    const pending: TranslationBatch['pending'] = [];
    for (const { item } of asked) {
      if (!done.has(item)) pending.push({ kind: item.kind, id: item.id });
      else {
        const t = done.get(item);
        if (t) items.push({ ...t, kind: item.kind, id: item.id });
      }
    }
    return { items, pending, auto };
  }

  // At most BATCH_PARALLEL new automatic translations at once in this process, whoever asked.
  private active = 0;
  private waiting: (() => void)[] = [];
  private async oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= BATCH_PARALLEL) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /**
   * A caption track's lines in `target`, CAPTION_CHUNK lines per request. #tags, @names and
   * links stay as they are; a line the model drops, or one the safety layer withholds, stays as
   * it was. The caller checks who may see the track and the limits. One audit entry per track.
   */
  async translateLines(req: {
    userId: string;
    scope: string;
    lines: string[];
    source: string;
    target: string;
  }): Promise<{ lines: string[]; provider: string; model: string }> {
    this.standInRefused();
    const started = Date.now();
    const logReq: AiRequest = { userId: req.userId, task: 'translate', input: '' };
    const p = this.translator;
    const out: string[] = [];
    try {
      for (let at = 0; at < req.lines.length; at += CAPTION_CHUNK) {
        const chunk = req.lines.slice(at, at + CAPTION_CHUNK).map((l) => protectForTranslation(l.replace(/\s*\n\s*/g, ' ')));
        const replies = new Map<number, string>();
        if (p.name === 'dev') {
          // The marked pseudo-translation, as for posts.
          chunk.forEach((c, i) => replies.set(i + 1, `[${req.source}→${req.target}] ${c.text}`));
        } else {
          const res = await p.complete({
            system: [
              `Translate the numbered lines of a video's captions from ${languageName(req.source, 'en')} into ${languageName(req.target, 'en')}.`,
              'Each line starts with its number and a tab. Reply with the same numbers, one line each, as "number<TAB>translation", and nothing else.',
              'The lines follow each other in the video: keep the meaning across them, but keep each line on its own line.',
              'Markers like ⟦0⟧ stand for hashtags, @mentions and links: copy each one unchanged. Keep names of people and places as they are.',
            ].join(' '),
            prompt: chunk.map((c, i) => `${i + 1}\t${c.text}`).join('\n'),
            maxTokens: 4000,
          });
          if (!res.refused)
            for (const line of res.text.split('\n')) {
              const m = /^\s*(\d+)\s*\t\s*(.*)$/.exec(line);
              if (m && m[2]!.trim()) replies.set(Number(m[1]), m[2]!.trim());
            }
        }
        chunk.forEach((c, i) => {
          const reply = replies.get(i + 1);
          const line = reply ? restoreTranslation(reply, c.tokens) : null;
          const risk = line ? analyzeText(line).risk : null;
          out.push(line && risk !== 'escalate' && risk !== 'restrict' ? line : req.lines[at + i]!);
        });
      }
    } catch {
      await this.log(logReq, [req.scope], 'error', started);
      throw new AppError(503, 'translation_unavailable', 'Translation isn’t available right now. Try again later.');
    }
    await this.log(logReq, [req.scope], 'ok', started);
    return { lines: out, provider: p.name, model: p.model };
  }

  private providerFor(task: AiTask): AiProvider {
    return task === 'translate' ? this.translator : this.provider;
  }

  private async loadContext(req: AiRequest): Promise<{ text: string; scopes: string[] }> {
    if (req.task === 'translate' && req.item) {
      const item = await loadTranslatable(this.db, req.userId, req.item.kind, req.item.id);
      return { text: item.text, scopes: [`${req.item.kind}:${req.item.id}`, ...(req.auto ? ['auto'] : [])] };
    }
    if (req.task === 'summarize_conversation') {
      if (!req.conversationId) throw notFound('Conversation');
      const member = await this.db.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [
        req.conversationId,
        req.userId,
      ]);
      if (!member.rowCount) throw notFound('Conversation');
      // Only what this member sees in the chat: no messages held for review or blocked, none from
      // people they blocked, none they deleted for themselves or that have disappeared, and no
      // view-once messages or lines the app wrote.
      const { rows } = await this.db.query<{ name: string; body: string }>(
        `SELECT p.display_name AS name, m.body FROM messages m JOIN profiles p ON p.user_id = m.sender_id
         WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND m.kind <> 'system' AND NOT m.view_once AND m.body <> ''
           AND ${messageVisibleSql('$2')}
           -- Shared locations are left out: a summary never mentions where anyone is.
           AND NOT EXISTS (SELECT 1 FROM location_shares ls WHERE ls.message_id = m.id)
         ORDER BY m.created_at DESC LIMIT 200`,
        [req.conversationId, req.userId],
      );
      return {
        text: rows
          .reverse()
          .map((r) => `${r.name}: ${r.body}`)
          .join('\n'),
        scopes: [`conversation:${req.conversationId}`],
      };
    }
    if (req.task === 'summarize_community') {
      if (!req.communityId) throw notFound('Community');
      const c = await this.db.query<{ visibility: string; role: string | null }>(
        `SELECT c.visibility, cm.role FROM communities c
         LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = $2 AND cm.status = 'active'
         WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [req.communityId, req.userId],
      );
      const row = c.rows[0];
      if (!row || (row.visibility === 'private' && !row.role)) throw notFound('Community');
      // Only posts this person could see themselves: blocks, regional rules, private audiences and subscriptions apply.
      const { rows } = await this.db.query<{ name: string; body: string }>(
        `SELECT ap.display_name AS name, p.body FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
         WHERE p.community_id = $1 AND p.moderation_status = 'normal' AND ${postVisibleSql('$2')} AND ${postUnlockedSql('$2')}
         ORDER BY p.created_at DESC LIMIT 100`,
        [req.communityId, req.userId],
      );
      return { text: rows.map((r) => `${r.name}: ${r.body}`).join('\n'), scopes: [`community:${req.communityId}`] };
    }
    if (req.task === 'memory_recap') {
      if (!req.memoryId) throw notFound('Memory');
      const own = await this.db.query(`SELECT 1 FROM memories WHERE id = $1 AND owner_id = $2`, [req.memoryId, req.userId]);
      if (!own.rowCount) throw notFound('Memory');
      // Only posts the owner can see right now, even if they were added earlier.
      const { rows } = await this.db.query<{ name: string; body: string }>(
        `SELECT pr.display_name AS name, p.body FROM memory_items i
         JOIN posts p ON p.id = i.item_id AND i.item_type = 'post'
         JOIN profiles pr ON pr.user_id = p.author_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
         WHERE i.memory_id = $2 AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')} ORDER BY p.created_at LIMIT 100`,
        [req.userId, req.memoryId],
      );
      return { text: rows.map((r) => `${r.name}: ${r.body}`).join('\n'), scopes: [`memory:${req.memoryId}`] };
    }
    // caption, search_intent, plan_from_message and translate only use the text the user supplied.
    return { text: req.input, scopes: ['input'] };
  }

  private async execute(req: AiRequest, context: string): Promise<unknown> {
    if (this.providerFor(req.task).name === 'dev') return devTask(req, context);
    const prompts: Record<AiTask, { system: string; prompt: string }> = {
      caption: {
        system: 'You write short social media captions. Reply with the caption only, under 200 characters, no hashtags unless asked.',
        prompt: `Write a caption for a post about:\n${context}`,
      },
      summarize_conversation: {
        system: 'Summarize a group chat for someone catching up. Use 3-6 short bullet points. Only use facts stated in the messages; do not invent decisions.',
        prompt: context || '(no messages)',
      },
      summarize_community: {
        system:
          'Summarize recent community discussion in 3-6 short bullet points. Only report what members actually said; never state a community decision that was not explicitly made.',
        prompt: context || '(no posts)',
      },
      search_intent: {
        system: 'Rewrite the search request as 2-6 plain keywords. Reply with keywords only.',
        prompt: context,
      },
      plan_from_message: {
        system:
          'Extract a plan from the message as JSON with keys destination, dates, participants, budget, activities (array), tasks (array). Use null when unknown. Reply with JSON only.',
        prompt: context,
      },
      translate: {
        system: [
          `Translate the user's text${req.sourceLanguage ? ` from ${languageName(req.sourceLanguage, 'en')}` : ''} into ${languageName(req.targetLanguage ?? 'en', 'en')}.`,
          'It is a social media post, comment, story or chat message: keep its tone, line breaks and emoji.',
          'Markers like ⟦0⟧ stand for hashtags, @mentions and links. Copy every marker exactly once, unchanged, where it belongs in the sentence.',
          'Keep names of people and places as they are. Reply with the translation only, with no notes.',
        ].join(' '),
        prompt: context,
      },
      memory_recap: {
        system:
          'Write a warm, factual recap (2-4 sentences) of a personal memory from these posts. Mention only people and details that appear in the posts. No hashtags.',
        prompt: context || '(no posts)',
      },
    };
    const p = prompts[req.task];
    // Hashtags, @mentions and links never reach the model: they go in as markers and come back unchanged.
    const guarded = req.task === 'translate' ? protectForTranslation(p.prompt) : null;
    const res = await this.providerFor(req.task).complete({
      system: p.system,
      prompt: guarded?.text ?? p.prompt,
      maxTokens: req.task === 'caption' ? 300 : 2000,
    });
    if (res.refused) return null;
    if (req.task === 'search_intent') return { ...parseSearchIntent(req.input), terms: res.text };
    if (req.task === 'plan_from_message') {
      try {
        return JSON.parse(res.text.replace(/^```(json)?|```$/g, '').trim());
      } catch {
        return devTask(req, context);
      }
    }
    if (req.task === 'translate')
      return { original: context, translated: res.text ? restoreTranslation(res.text, guarded!.tokens) : null, targetLanguage: req.targetLanguage ?? 'en' };
    return res.text;
  }

  private async log(req: AiRequest, scopes: string[], status: string, started: number, by?: { provider: string; model: string }) {
    await this.db
      .query(`INSERT INTO ai_tool_calls (user_id, task, provider, model, context_scopes, status, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        req.userId,
        req.task,
        by?.provider ?? this.providerFor(req.task).name,
        by?.model ?? this.providerFor(req.task).model,
        scopes,
        status,
        Date.now() - started,
      ])
      .catch(() => {});
  }
}

function toTranslation(
  item: { kind: TranslatableKind; id: string },
  target: string,
  text: string,
  sourceLanguage: string,
  provider: string,
  cached: boolean,
): Translation {
  return { kind: item.kind, id: item.id, sourceLanguage, targetLanguage: target, text, machine: true, provider, cached };
}

/** Rule-based implementations used by the dev provider. Deterministic and offline. */
function devTask(req: AiRequest, context: string): unknown {
  switch (req.task) {
    case 'caption': {
      const first = context.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
      return first.length > 140 ? `${first.slice(0, 137)}…` : first;
    }
    case 'memory_recap': {
      const lines = context.split('\n').filter(Boolean);
      if (!lines.length) return '';
      const people = [...new Set(lines.map((l) => l.split(':')[0]))];
      return `${req.input}: ${lines.length} moment${lines.length > 1 ? 's' : ''} shared by ${people.join(', ')}. ${lines[0]!.split(': ').slice(1).join(': ')}`;
    }
    case 'summarize_conversation':
    case 'summarize_community': {
      const lines = context.split('\n').filter(Boolean);
      if (!lines.length) return 'Nothing to summarize yet.';
      const people = [...new Set(lines.map((l) => l.split(':')[0]))];
      const longest = [...lines].sort((a, b) => b.length - a.length).slice(0, 3);
      return [`${lines.length} messages from ${people.join(', ')}.`, ...longest.map((l) => `• ${l}`)].join('\n');
    }
    case 'search_intent':
      return parseSearchIntent(req.input);
    case 'plan_from_message': {
      const dest = context.match(/\b(?:to|in|visit)\s+([A-Z][\p{L}-]+(?:\s[A-Z][\p{L}-]+)?)/u)?.[1] ?? null;
      const dates = context.match(/\b(tonight|tomorrow|this weekend|next (?:week|month|year)|on \w+day|in \w+)\b/i)?.[1] ?? null;
      return {
        destination: dest,
        dates,
        participants: [],
        budget: null,
        transport: null,
        accommodation: null,
        activities: [],
        tasks: dest ? [`Book travel to ${dest}`] : [],
      };
    }
    case 'translate': {
      // A pseudo-translation, marked as such, so translation works offline in development and tests.
      // It goes through the same marker round trip as a real one, so #tags, @names and links come back unchanged.
      const target = req.targetLanguage ?? 'en';
      const { text, tokens } = protectForTranslation(context);
      return { original: context, translated: restoreTranslation(`[${req.sourceLanguage ?? '?'}→${target}] ${text}`, tokens), targetLanguage: target };
    }
  }
}
