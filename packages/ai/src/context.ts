import { estimateTokens } from './tokens.js';
import { wrapUntrusted } from './safety/injection.js';
import type { SourceRef } from './types.js';

/**
 * Bounded, provenance-tagged context. Every item records where it came from (`source`), whether it is trusted (only our own
 * system text is), and is truncated so a single huge post cannot crowd out everything else. The API's Context Engine only
 * ever adds items that the Permission Engine has already granted to the requesting user.
 */
export interface ContextItem {
  source: SourceRef;
  text: string;
  /** Default true: everything except the system's own text. */
  untrusted?: boolean;
  /** Higher = kept first when the budget is tight. */
  priority?: number;
}

export interface BuiltContext {
  items: Array<ContextItem & { truncated: boolean; tokens: number }>;
  dropped: SourceRef[];
  tokens: number;
  sources: SourceRef[];
}

export interface ContextLimits {
  maxTokens: number;
  maxItemTokens: number;
  maxItems: number;
}

export const DEFAULT_LIMITS: ContextLimits = { maxTokens: 3000, maxItemTokens: 600, maxItems: 40 };

export class ContextBundle {
  private readonly raw: ContextItem[] = [];
  constructor(private readonly limits: ContextLimits = DEFAULT_LIMITS) {}

  add(item: ContextItem): this {
    this.raw.push(item);
    return this;
  }

  get size(): number {
    return this.raw.length;
  }

  build(): BuiltContext {
    const seen = new Set<string>();
    const ordered = [...this.raw]
      .map((it, i) => ({ it, i }))
      .sort((a, b) => (b.it.priority ?? 0) - (a.it.priority ?? 0) || a.i - b.i)
      .map((x) => x.it);
    const items: BuiltContext['items'] = [];
    const dropped: SourceRef[] = [];
    let tokens = 0;
    for (const it of ordered) {
      const key = `${it.source.type}:${it.source.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (items.length >= this.limits.maxItems) {
        dropped.push(it.source);
        continue;
      }
      let text = it.text;
      let truncated = false;
      const maxChars = this.limits.maxItemTokens * 4;
      if (text.length > maxChars) {
        text = `${text.slice(0, maxChars).trimEnd()}…`;
        truncated = true;
      }
      const t = estimateTokens(text);
      if (tokens + t > this.limits.maxTokens) {
        dropped.push(it.source);
        continue;
      }
      tokens += t;
      items.push({ ...it, text, truncated, tokens: t });
    }
    return { items, dropped, tokens, sources: items.map((i) => i.source) };
  }
}

/** Render built context for a prompt: trusted text verbatim, everything else wrapped as inert data. */
export function renderContext(ctx: BuiltContext): string {
  return ctx.items
    .map((i) => (i.untrusted === false ? i.text : wrapUntrusted(i.source, i.text)))
    .join('\n\n');
}
