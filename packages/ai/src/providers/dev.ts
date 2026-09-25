import { classifyText } from '@yapilapi/moderation';
import { contentWords, extractiveAnswer, rankKnowledge, type KnowledgeItem } from '../knowledge.js';
import { languageFromName, languageName, phrasebookTranslate } from '../language.js';
import { extractPlan, type PlanMessage } from '../plan-extract.js';
import { extractiveSummary } from '../summarize.js';
import { estimateTokens } from '../tokens.js';
import {
  ProviderError,
  type CallOptions,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type EmbedResponse,
  type ModelProvider,
  type TaskKind,
  type ToolCall,
} from '../types.js';

/**
 * DEV provider: a deterministic, rule-based responder that works fully offline. It exists so the platform (permissions, tools,
 * drafts, safety, evals) is exercisable without any API key. It is NOT a language model and every response says so
 * (`provider: 'dev'`, model `dev-rules-1`); the API adds a visible notice. It only ever reads the user's own message to decide
 * what to do (retrieved content arrives wrapped in <untrusted_data> and is treated purely as data to summarise).
 */
export const DEV_MODEL = 'dev-rules-1';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const hashtags = (topic: string, n = 3) =>
  contentWords(topic)
    .filter((w) => w.length > 3)
    .slice(0, n)
    .map((w) => `#${w.replace(/[^\p{L}\p{N}]/gu, '')}`)
    .join(' ');
const trimTopic = (t: string) => t.trim().replace(/[.!?]+$/, '');

function untrustedBlocks(content: string): string[] {
  return [...content.matchAll(/<untrusted_data[^>]*>\n?([\s\S]*?)\n?<\/untrusted_data>/g)].map(
    (m) => m[1]!,
  );
}

type Args = Record<string, unknown>;
const call = (name: string, args: Args, seed: string): ToolCall => ({
  id: `call_${hash(name + seed)}`,
  name,
  arguments: args,
});

const WHEN: Array<[RegExp, string]> = [
  [/\bnext weekend\b/i, 'next weekend'],
  [/\bthis weekend\b|\bweekend\b/i, 'this weekend'],
  [/\btomorrow\b/i, 'tomorrow'],
  [/\btoday\b|\btonight\b/i, 'today'],
  [/\bnext week\b/i, 'next week'],
  [/\bthis week\b/i, 'this week'],
];

function stripLead(msg: string): string {
  return msg
    .replace(
      /^\s*(?:please\s+|can you\s+|could you\s+|hey\s+)?(?:search|find|look up|look for|show me|get me)(?:\s+me)?(?:\s+(?:for|some|any|posts?|events?|about|content|people|communities|places))*\s*/i,
      '',
    )
    .replace(/[?!.]+$/g, '')
    .trim();
}

/** What would the dev responder do with this message? Returns tool calls, or null for a plain reply. */
function decide(
  message: string,
  tools: Set<string>,
  req: ChatRequest,
): { calls: ToolCall[] } | { reply: string } {
  const m = message.trim();
  const lower = m.toLowerCase();
  const id = UUID.exec(m)?.[0] ?? null;
  const attached = req.hints?.attachedConversationIds?.[0] ?? null;
  const focus = req.hints?.focus ?? null;
  const need = (name: string) => tools.has(name);
  const unavailable = (what: string) => ({
    reply: `I can't ${what} with this assistant. Try a different assistant from the list, or ask me something else.`,
  });

  // translate
  let t = /\btranslate\b/i.test(lower);
  if (t) {
    const quoted = /["“'‘](.+?)["”'’]\s*(?:to|into)\s+([\p{L}-]+)/iu.exec(m) ?? null;
    const colon = /translate\s+(?:this\s+)?(?:to|into)\s+([\p{L}-]+)\s*[:-]\s*([\s\S]+)/iu.exec(m);
    const plain = /translate\s+([\s\S]+?)\s+(?:to|into)\s+([\p{L}-]+)\s*[.?!]?$/iu.exec(m);
    let text: string | undefined;
    let lang: string | undefined;
    if (quoted) {
      text = quoted[1];
      lang = quoted[2];
    } else if (colon) {
      lang = colon[1];
      text = colon[2];
    } else if (plain) {
      text = plain[1];
      lang = plain[2];
    }
    const code = lang ? languageFromName(lang) : null;
    if (text && code)
      return need('translate')
        ? { calls: [call('translate', { text: text.trim(), targetLanguage: code }, m)] }
        : unavailable('translate text');
    t = false;
  }
  if (/summari[sz]e/.test(lower) && /(thread|comments?|post)/.test(lower)) {
    const postId =
      id ?? (focus && (focus.type === 'post' || focus.type === 'comment') ? focus.id : null);
    if (!postId)
      return {
        reply: 'Tell me which post to summarise (open it and ask again, or include its id).',
      };
    return need('summarize_thread')
      ? { calls: [call('summarize_thread', { postId }, m)] }
      : unavailable('summarise threads');
  }
  if (/summari[sz]e/.test(lower) && /(conversation|chat|messages?|dm|group)/.test(lower)) {
    const conversationId = id ?? attached ?? (focus?.type === 'conversation' ? focus.id : null);
    if (!conversationId)
      return {
        reply:
          'To summarise a conversation, attach it to this request first. I never read your private messages unless you attach one.',
      };
    return need('summarize_conversation')
      ? { calls: [call('summarize_conversation', { conversationId }, m)] }
      : unavailable('summarise conversations');
  }
  if (
    /\bplan\b/.test(lower) &&
    /(trip|weekend|holiday|vacation|getaway|travel|our|the chat|conversation)/.test(lower)
  ) {
    const conversationId = id ?? attached;
    if (!conversationId)
      return {
        reply:
          'To build a plan from a chat, attach that conversation to this request. I never read your private messages unless you attach one.',
      };
    return need('plan_from_conversation')
      ? { calls: [call('plan_from_conversation', { conversationId }, m)] }
      : unavailable('build plans from conversations');
  }
  if (
    /(create|draft|make|set up|host|plan)\b.*\bevent\b/.test(lower) &&
    !/find|search/.test(lower.split('event')[0] ?? '')
  ) {
    const title =
      /(?:called|named|titled)\s+["“]?([^"”]+?)["”]?(?:\s+(?:on|at|for|from)\b|[.?!]|$)/i.exec(
        m,
      )?.[1] ??
      /event\s+(?:for|about)\s+(.+?)(?:\s+(?:on|at)\b|[.?!]|$)/i.exec(m)?.[1] ??
      'New event';
    const dm = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(m);
    const args: Args = { title: cap(title.trim()).slice(0, 160) };
    if (dm)
      args.startsAt = `${dm[1]}T${String(dm[2] ?? '18').padStart(2, '0')}:${dm[3] ?? '00'}:00Z`;
    const loc = /\bat\s+(?:the\s+)?([A-Z][\p{L}' ]{2,60}?)(?:\s+on\b|[.?!]|$)/u.exec(m)?.[1];
    if (loc && !/^\d/.test(loc)) args.locationText = loc.trim();
    return need('create_event_draft')
      ? { calls: [call('create_event_draft', args, m)] }
      : unavailable('draft events');
  }
  if (/\bcaptions?\b/.test(lower)) {
    const desc = /(?:for|of|about)\s+(.+?)[.?!]*$/i.exec(m)?.[1] ?? m;
    return need('draft_caption')
      ? { calls: [call('draft_caption', { description: desc.slice(0, 500) }, m)] }
      : unavailable('draft captions');
  }
  if (/\b(thumbnail)s?\b/.test(lower)) {
    const topic = /(?:for|about|of)\s+(.+?)[.?!]*$/i.exec(m)?.[1] ?? m;
    return need('thumbnail_concepts')
      ? { calls: [call('thumbnail_concepts', { topic: topic.slice(0, 500) }, m)] }
      : unavailable('suggest thumbnails');
  }
  if (/\b(titles?|headlines?)\b/.test(lower)) {
    const topic = /(?:for|about|of)\s+(.+?)[.?!]*$/i.exec(m)?.[1] ?? m;
    return need('suggest_titles')
      ? { calls: [call('suggest_titles', { topic: topic.slice(0, 500) }, m)] }
      : unavailable('suggest titles');
  }
  if (/\b(description)\b/.test(lower) && /\b(write|draft|make)\b/.test(lower)) {
    const notes = /(?:for|about|of)\s+(.+?)[.?!]*$/i.exec(m)?.[1] ?? m;
    return need('draft_description')
      ? { calls: [call('draft_description', { notes: notes.slice(0, 1500) }, m)] }
      : unavailable('draft descriptions');
  }
  if (/\breply\b/.test(lower) && /\b(draft|write|compose|help)\b|\breply to\b/.test(lower)) {
    const targetId = id ?? focus?.id ?? attached;
    const targetType =
      focus?.type === 'comment'
        ? 'comment'
        : focus?.type === 'conversation' || (attached && !id)
          ? 'conversation'
          : 'post';
    if (!targetId)
      return {
        reply:
          'Tell me what to reply to (open the post and ask again, or attach the conversation).',
      };
    return need('draft_reply')
      ? { calls: [call('draft_reply', { targetType, targetId, guidance: m.slice(0, 300) }, m)] }
      : unavailable('draft replies');
  }
  if (/\b(draft|write|compose)\b.*\bpost\b|\bpost about\b/.test(lower)) {
    const topic = /(?:about|on|regarding)\s+(.+?)[.?!]*$/i.exec(m)?.[1] ?? m;
    return need('draft_post')
      ? { calls: [call('draft_post', { topic: topic.slice(0, 400) }, m)] }
      : unavailable('draft posts');
  }
  if (/\b(rules?|faq|guidelines)\b/.test(lower) && id && /community|group/.test(lower)) {
    return need('community_faq_answer')
      ? { calls: [call('community_faq_answer', { communityId: id, question: m.slice(0, 500) }, m)] }
      : unavailable('answer community questions');
  }
  if (id && /\b(business|shop|store|opening hours|open)\b/.test(lower)) {
    return need('business_assistant_answer')
      ? {
          calls: [
            call('business_assistant_answer', { businessId: id, question: m.slice(0, 500) }, m),
          ],
        }
      : unavailable('answer business questions');
  }
  if (/\b(events?|what'?s on|what is on|happening|things to do)\b/.test(lower)) {
    const when = WHEN.find(([re]) => re.test(m))?.[1];
    const q = stripLead(m)
      .replace(
        /\b(events?|what'?s on|what is on|happening|things to do|this weekend|next weekend|tomorrow|today|tonight|this week|next week|are|is|there|any|on|in|near|me)\b/gi,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim();
    const args: Args = {};
    if (when) args.when = when;
    if (q.length >= 2) args.query = q.slice(0, 120);
    return need('find_events')
      ? { calls: [call('find_events', args, m)] }
      : unavailable('look up events');
  }
  if (
    /^\s*(?:please\s+|can you\s+|could you\s+)?(?:search|find|look up|look for|show me|get me)\b/.test(
      lower,
    )
  ) {
    const types: string[] = [];
    if (/\b(people|users?|accounts?|profiles?)\b/.test(lower)) types.push('people');
    if (/\b(communit(?:y|ies)|groups?)\b/.test(lower)) types.push('communities');
    if (/\b(places?|restaurants?|cafes?|parks?)\b/.test(lower)) types.push('places');
    if (/\b(businesses|business|shops?|stores?|bakeries|bakery)\b/.test(lower))
      types.push('businesses');
    if (/\bposts?\b/.test(lower)) types.push('posts');
    const query = stripLead(m);
    if (query.length < 2) return { reply: 'What would you like me to search for?' };
    const args: Args = { query: query.slice(0, 200) };
    if (types.length) args.types = types;
    return need('search_content')
      ? { calls: [call('search_content', args, m)] }
      : unavailable('search');
  }
  if (
    /\bwhat do you (?:remember|know) about me\b|\bmy memories\b|\bwhat have i told you\b/.test(
      lower,
    )
  ) {
    const mem = (Array.isArray(req.input?.memories) ? req.input.memories : []) as string[];
    return {
      reply: mem.length
        ? `Here is what I have saved because you asked me to remember it:\n${mem.map((x) => `- ${x}`).join('\n')}`
        : "I don't have any saved memories for you (memory needs your consent, and nothing is saved unless you approve it).",
    };
  }
  if (/^\s*(hi|hello|hey|good (morning|afternoon|evening)|yo)\b/.test(lower) || lower.length < 3) {
    return {
      reply:
        "Hello! I'm the built-in offline demo assistant (provider: dev), not a real AI model. I can search what you can see, find events, summarise threads, and prepare drafts for you to review. What would you like to do?",
    };
  }
  return {
    reply:
      "I'm the built-in offline demo assistant (provider: dev): a small rule-based responder, not a real AI model, so I can't hold an open-ended conversation. " +
      'I can search ("find posts about ..."), look up events ("events this weekend"), summarise a thread or an attached chat, and draft posts, captions, titles, replies or events for you to review. ' +
      'Connect a real model provider for free-form answers.',
  };
}

function composeFromTools(msgs: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of msgs) {
    let p: { ok?: boolean; error?: { message?: string }; result?: { display?: string } } = {};
    try {
      p = JSON.parse(m.content);
    } catch {
      /* not JSON: use as is */
    }
    if (p.ok === false)
      parts.push(`I couldn't do that: ${p.error?.message ?? 'the request was not allowed'}.`);
    else parts.push(p.result?.display ?? 'Done.');
  }
  return parts.join('\n\n');
}

function draftJson(schema: string, input: Args): string {
  const topic = trimTopic(String(input.topic ?? input.description ?? input.notes ?? ''));
  const tone = String(input.tone ?? 'friendly');
  const count = Math.max(
    1,
    Math.min(8, Number(input.count ?? (schema === 'suggest_titles' ? 5 : 3))),
  );
  const tags = hashtags(topic);
  const lead: Record<string, string> = {
    friendly: "Something I've been excited to share:",
    professional: 'A quick update:',
    playful: 'Okay, hear me out:',
    concise: 'Note:',
    inspiring: 'Every big thing starts small:',
  };
  switch (schema) {
    case 'draft_post':
      return JSON.stringify({
        body: `${lead[tone] ?? lead.friendly} ${topic}. What do you think? ${tags}`.trim(),
        topics: [],
      });
    case 'draft_caption': {
      const opts = [
        `${cap(topic)} ${tags}`.trim(),
        `Moments like this: ${topic}. ${tags}`.trim(),
        `${cap(topic)}. Tell me your favourite part.`,
        `Still thinking about ${topic}.`,
        `${cap(topic)}, captured.`,
      ];
      return JSON.stringify({ options: opts.slice(0, count) });
    }
    case 'suggest_titles': {
      const t = cap(topic);
      const opts = [
        t,
        `${t}: what I learned`,
        `A closer look at ${topic}`,
        `${t} in five minutes`,
        `How to get started with ${topic}`,
        `${t}: the honest version`,
        `Everything about ${topic}`,
        `Why ${topic} matters`,
      ];
      return JSON.stringify({ titles: opts.slice(0, count) });
    }
    case 'draft_description': {
      const notes =
        extractiveSummary(String(input.notes ?? ''), { maxSentences: 3, maxChars: 600 }) || topic;
      return JSON.stringify({ description: `${notes}\n\nThanks for being here.` });
    }
    case 'thumbnail_concepts': {
      const styles = [
        'bold, high-contrast, one large subject',
        'clean flat background with a short headline',
        'candid close-up with a surprised expression',
      ];
      return JSON.stringify({
        concepts: styles.slice(0, Math.min(count, 3)).map((s) => ({
          prompt: `Thumbnail about ${topic}: ${s}, readable at small size, no more than four words of text.`,
          style: s,
        })),
      });
    }
    case 'draft_reply': {
      const g = trimTopic(String(input.guidance ?? '')).replace(
        /^(?:please\s+)?(?:draft|write|compose|help me)\b[^,.]*?(?:reply|response)\s*(?:to [^,.]+)?[,:.-]?\s*/i,
        '',
      );
      return JSON.stringify({
        body:
          g.length > 3
            ? `Thanks for sharing this! ${cap(g)}.`
            : 'Thanks for sharing this! Really appreciate it, let me know if I can help.',
      });
    }
    default:
      return JSON.stringify({ text: topic });
  }
}

export class DevProvider implements ModelProvider {
  readonly name = 'dev';
  readonly isDev = true;
  readonly model = DEV_MODEL;
  supports(_task: TaskKind): boolean {
    return true;
  }

  async chat(req: ChatRequest, opts: CallOptions = {}): Promise<ChatResponse> {
    if (opts.signal?.aborted) throw new ProviderError('timeout', 'aborted', this.name);
    let content = '';
    let toolCalls: ToolCall[] = [];
    switch (req.task) {
      case 'summarise':
        content = this.summarise(req);
        break;
      case 'translate':
        content = this.translate(req);
        break;
      case 'classify': {
        const c = classifyText(lastUser(req));
        content = JSON.stringify({ status: c.status, risk: c.risk, categories: c.categories });
        break;
      }
      case 'embed':
        throw new ProviderError('unsupported', 'use embed()', this.name);
      default: {
        if (req.responseFormat?.schemaName === 'plan') {
          content = this.plan(req);
          break;
        }
        if (req.responseFormat?.schemaName === 'grounded_answer') {
          content = this.grounded(req);
          break;
        }
        if (req.responseFormat) {
          content = draftJson(req.responseFormat.schemaName, req.input ?? {});
          break;
        }
        const lastUserIdx = findLastIndex(req.messages, (m) => m.role === 'user');
        const after = req.messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool');
        if (after.length) {
          content = composeFromTools(after);
          break;
        }
        const d = decide(lastUser(req), new Set((req.tools ?? []).map((t) => t.name)), req);
        if ('calls' in d) toolCalls = d.calls;
        else content = d.reply;
      }
    }
    const inputTokens = estimateTokens(req.messages.map((m) => m.content).join('\n'));
    return {
      content,
      toolCalls,
      provider: this.name,
      model: this.model,
      usage: { inputTokens, outputTokens: estimateTokens(content) + toolCalls.length * 12 },
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    };
  }

  private summarise(req: ChatRequest): string {
    const user = req.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    const blocks = untrustedBlocks(user);
    const text = blocks.length ? blocks.join('\n') : user;
    return (
      extractiveSummary(text, { maxSentences: 3, maxChars: 800 }) ||
      'There is nothing to summarise.'
    );
  }

  /** Grounded answering: quotes the best-matching approved entries; says so when none match. */
  private grounded(req: ChatRequest): string {
    const items = (Array.isArray(req.input?.items) ? req.input.items : []) as KnowledgeItem[];
    const scope = req.input?.scope === 'business' ? 'business' : 'community';
    const ranked = rankKnowledge(String(req.input?.question ?? ''), items);
    return JSON.stringify({
      answer: extractiveAnswer(ranked, scope),
      used: ranked.map((r) => r.item.id),
    });
  }

  private plan(req: ChatRequest): string {
    const user = req.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    const block = untrustedBlocks(user)[0] ?? '[]';
    let msgs: PlanMessage[] = [];
    try {
      msgs = JSON.parse(block) as PlanMessage[];
    } catch {
      /* leave empty */
    }
    return JSON.stringify(
      extractPlan(msgs, {
        now: new Date(),
        conversationTitle:
          typeof req.input?.conversationTitle === 'string' ? req.input.conversationTitle : null,
      }),
    );
  }

  private translate(req: ChatRequest): string {
    const text = String(req.input?.text ?? lastUser(req));
    const target = String(req.input?.targetLanguage ?? req.hints?.targetLanguage ?? '');
    const source = req.input?.sourceLanguage ? String(req.input.sourceLanguage) : null;
    const out = phrasebookTranslate(text, source, target);
    if (!out) {
      throw new ProviderError(
        'unsupported',
        `The built-in dev provider can only translate a few demo phrases (not "${text.slice(0, 40)}" into ${languageName(target)}). Configure a real provider for real translation.`,
        this.name,
      );
    }
    return out;
  }

  async embed(texts: string[]): Promise<EmbedResponse> {
    const DIM = 64;
    const vectors = texts.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      for (const w of contentWords(t)) {
        const h = parseInt(hash(w), 36);
        v[h % DIM] = (v[h % DIM] ?? 0) + (h % 2 === 0 ? 1 : -1);
      }
      const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
      return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
    });
    return {
      vectors,
      usage: { inputTokens: estimateTokens(texts.join(' ')), outputTokens: 0 },
      provider: this.name,
      model: 'dev-hash-embed-64',
    };
  }
}

function lastUser(req: ChatRequest): string {
  const i = findLastIndex(req.messages, (m) => m.role === 'user');
  return i >= 0 ? req.messages[i]!.content : '';
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}
