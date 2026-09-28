import type { FastifyRequest } from 'fastify';
import { ERROR_MESSAGES } from '@yapilapi/shared/error-messages';

/**
 * Error messages in the reader's language. Code throws errors in English, as it always has
 * (`badRequest('Add a title.')`, `` tooMany(`Wait ${n} seconds.`) ``); the error handler puts the
 * message, and each message in `details.fields`, into the reader's language on the way out.
 *
 * The tables (packages/shared/src/locales/errors/<lang>.ts) are keyed by the English. A message
 * made from values is keyed by its template, with a `{name}` slot for each value (`Wait {n}
 * seconds.`); it matches the English message with the values in place, and the translation gets
 * the same values. A value that is itself a message in the table is translated too. A message
 * with no entry stays in English.
 */

/** The reader's language: a signed-in person's own setting, else what the app or browser asks for. */
export function requestLocale(req: FastifyRequest): string {
  const own = req.user?.locale;
  if (own) return supported(own) ?? 'en';
  const asked = req.headers['x-locale'];
  const fromApp = typeof asked === 'string' ? supported(asked) : undefined;
  if (fromApp) return fromApp;
  const accept = req.headers['accept-language'];
  return (typeof accept === 'string' && fromAcceptLanguage(accept)) || 'en';
}

/** The language a tag uses, when there is a table for it or it is English (fr-CA → fr). */
function supported(tag: string): string | undefined {
  const lang = tag.trim().split(/[-_]/)[0]!.toLowerCase();
  return lang === 'en' || lang in ERROR_MESSAGES ? lang : undefined;
}

/** The first language in an Accept-Language header we have, by preference ("fr-CA,fr;q=0.9,en;q=0.8"). */
export function fromAcceptLanguage(header: string): string | undefined {
  const ranked = header
    .split(',')
    .slice(0, 20)
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag, q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    const lang = supported(tag);
    if (lang) return lang;
  }
  return undefined;
}

interface Pattern {
  re: RegExp;
  names: string[];
  to: string;
  /** Fixed text in the template: longer is more specific, so it is tried first. */
  weight: number;
}
interface Compiled {
  exact: Map<string, string>;
  patterns: Pattern[];
}

const SLOT = /\{([A-Za-z_$][\w$]*)\}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new Map<string, Compiled>();

function compile(lang: string): Compiled | undefined {
  const cached = compiled.get(lang);
  if (cached) return cached;
  const table = ERROR_MESSAGES[lang];
  if (!table) return undefined;
  const exact = new Map<string, string>();
  const patterns: Pattern[] = [];
  for (const [english, to] of Object.entries(table)) {
    exact.set(english, to);
    const names = [...english.matchAll(SLOT)].map((m) => m[1]!);
    if (!names.length) continue;
    const fixed = english.split(SLOT).filter((_, i) => i % 2 === 0);
    const re = new RegExp(`^${fixed.map(escapeRe).join('([\\s\\S]+?)')}$`);
    patterns.push({ re, names, to, weight: fixed.join('').length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
  const c = { exact, patterns };
  compiled.set(lang, c);
  return c;
}

/** One message in a language, or the English as it is when there is no translation. */
export function translateMessage(message: string, locale: string): string {
  if (!message) return message;
  const c = compile(supported(locale) ?? 'en');
  if (!c) return message;
  const hit = c.exact.get(message);
  if (hit !== undefined) return hit;
  for (const p of c.patterns) {
    const m = p.re.exec(message);
    if (!m) continue;
    const values = new Map(p.names.map((name, i) => [name, m[i + 1]!]));
    return p.to.replace(SLOT, (slot, name: string) => {
      const v = values.get(name);
      return v === undefined ? slot : (c.exact.get(v) ?? v);
    });
  }
  return message;
}

/** An error's `details` with each message in `fields` translated; anything else as it was. */
export function translateDetails(details: unknown, locale: string): unknown {
  if (!details || typeof details !== 'object' || !('fields' in details)) return details;
  const fields = (details as { fields?: unknown }).fields;
  if (!fields || typeof fields !== 'object') return details;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = typeof v === 'string' ? translateMessage(v, locale) : v;
  return { ...details, fields: out };
}
