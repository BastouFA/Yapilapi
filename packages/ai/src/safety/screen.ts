import { classifyText, type Category } from '@yapilapi/moderation';

/** ------------------------------------------------------------------ input screening (the user's own prompt) */

export type RequestCategory =
  | 'self_harm'
  | 'prompt_extraction'
  | 'weapons'
  | 'malware'
  | 'child_safety'
  | 'doxxing'
  | 'fraud'
  | 'harassment'
  | 'sexual_content'
  | 'teen_restricted';

export type RequestVerdict =
  | { action: 'allow'; userInjectionAttempt: boolean }
  | { action: 'support'; category: 'self_harm' }
  | { action: 'refuse'; category: RequestCategory; message: string };

const REFUSALS: Record<Exclude<RequestCategory, 'self_harm'>, string> = {
  prompt_extraction:
    "I can't share my configuration or instructions, but I'm happy to help with what you're trying to do.",
  weapons: "I can't help with making weapons or hurting people.",
  malware:
    "I can't help create malware, phishing kits or ways to break into other people's accounts.",
  child_safety: "I can't help with anything that sexualises or endangers children.",
  doxxing:
    "I can't help find or expose private information about people, such as home addresses or private accounts.",
  fraud: "I can't help with scams, impersonation or deceiving people out of money.",
  harassment: "I can't help write content meant to harass, threaten or demean people.",
  sexual_content: "I can't help with explicit sexual content.",
  teen_restricted: "That's not something I can help with on a teen account.",
};

const SELF_HARM =
  /\b(kill myself|killing myself|end my life|ending my life|want to die|wanna die|suicid(?:e|al)|hurt myself|harm myself|self[- ]?harm|cut myself|don'?t want to (?:be alive|live)|better off dead|no reason to live)\b/i;
const EXTRACTION =
  /\b(reveal|show|print|repeat|display|tell me|output|dump|leak|paste|recite|what(?:'s| is| are)|give me|copy)\b[^.?\n]{0,40}\b(system prompt|initial prompt|hidden prompt|your (?:system |initial |original |hidden |secret )?(?:instructions|prompt|rules|guidelines|configuration)|instructions (?:above|before)|everything (?:above|before) this)\b/i;
const RULES_BY_CATEGORY: Array<{
  category: Exclude<RequestCategory, 'self_harm' | 'prompt_extraction' | 'teen_restricted'>;
  re: RegExp;
}> = [
  {
    category: 'child_safety',
    re: /\b(sexual|nude|naked|explicit|erotic)\b[^.\n]{0,40}\b(child|children|minor|minors|kid|kids|underage|under-?age|teen(?:ager)?s?|\d{1,2}[- ]?year[- ]old)\b|\b(child|minor|underage|kid)s?\b[^.\n]{0,40}\b(sexual|nude|naked|porn|erotic)\b/i,
  },
  {
    category: 'weapons',
    re: /\b(how (?:do|can|to)\b[^.\n]{0,30}\b(?:make|build|assemble|construct|synthesi[sz]e|3d[- ]?print)\b[^.\n]{0,30}\b(?:bomb|explosive|pipe bomb|molotov|nerve agent|ghost gun|napalm|ricin|meth(?:amphetamine)?)|(?:make|build|create)\s+(?:a\s+)?(?:bomb|pipe bomb|molotov|explosive device))\b/i,
  },
  {
    category: 'malware',
    re: /\b(write|create|build|generate|code|make)\b[^.\n]{0,30}\b(ransomware|keylogger|malware|computer virus|botnet|phishing (?:page|site|kit|email)|credential (?:stealer|harvester)|stealer)\b|\b(hack|break into|take over|steal)\b[^.\n]{0,30}\b(account|password|instagram|whatsapp|wifi|phone|email)\b/i,
  },
  {
    category: 'doxxing',
    re: /\b(find|get|look up|dig up|track|locate)\b[^.\n]{0,40}\b(home address|where (?:\w+ ){0,3}lives|phone number|real name|private (?:account|info|information)|ip address|location of)\b[^.\n]{0,40}\b(of|for|belonging to)?\b/i,
  },
  {
    category: 'fraud',
    re: /\b(write|create|draft|make|generate)\b[^.\n]{0,30}\b(fake (?:id|review|reviews|invoice|receipt|passport|document)|scam (?:message|email|text)|romance scam|phishing|counterfeit|forged)\b|\b(pretend to be|impersonate)\b[^.\n]{0,30}\b(bank|support agent|police|customer service|my (?:boss|ceo))\b/i,
  },
  {
    category: 'harassment',
    re: /\b(?:write|draft|compose|send|create|generate|help me|i want to|i need to|let'?s)\b[^.\n]{0,40}\b(?:harass|threaten|bully|intimidate|stalk|humiliate)\w*\b[^.\n]{0,40}\b(?:my|a|the|him|her|them|someone|somebody|classmate|coworker|neighbou?r|ex)\b/i,
  },
  {
    category: 'harassment',
    re: /\b(write|draft|compose|generate)\b[^.\n]{0,30}\b(insults?|threat(?:s|ening)?|hate (?:speech|post|message)|harassing|abusive|bully(?:ing)?)\b[^.\n]{0,40}\b(about|to|for|against|at)\b/i,
  },
  {
    category: 'sexual_content',
    re: /\b(write|create|generate|describe)\b[^.\n]{0,30}\b(explicit|erotic|pornographic|sexually explicit|nsfw)\b/i,
  },
];
const TEEN_EXTRA: RegExp[] = [
  /\b(where|how)\b[^.\n]{0,30}\b(buy|get|order)\b[^.\n]{0,30}\b(alcohol|vape|vapes|cigarettes|weed|cannabis|drugs|gambling|betting)\b/i,
  /\b(dating|hookup|hook up|sugar (?:daddy|mommy|baby))\b[^.\n]{0,30}\b(adult|older (?:man|woman|guy|girl)|stranger)\b/i,
];

export function screenRequest(
  text: string,
  opts: { ageBand?: 'teen' | 'adult' } = {},
): RequestVerdict {
  const t = text.normalize('NFKC');
  if (SELF_HARM.test(t)) return { action: 'support', category: 'self_harm' };
  if (EXTRACTION.test(t))
    return { action: 'refuse', category: 'prompt_extraction', message: REFUSALS.prompt_extraction };
  for (const r of RULES_BY_CATEGORY)
    if (r.re.test(t))
      return { action: 'refuse', category: r.category, message: REFUSALS[r.category] };
  if (opts.ageBand === 'teen' && TEEN_EXTRA.some((re) => re.test(t)))
    return { action: 'refuse', category: 'teen_restricted', message: REFUSALS.teen_restricted };
  const injectionish =
    /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|all|your)\b[^.\n]{0,20}\b(instructions?|rules?|prompt)\b|\bdeveloper mode\b|\bjailbreak\b/i.test(
      t,
    );
  return { action: 'allow', userInjectionAttempt: injectionish };
}

export const SUPPORT_MESSAGE =
  "I'm really sorry you're going through this. You don't have to face it alone. If you might act on these thoughts or you're in immediate danger, please contact your local emergency number now. " +
  "You can also reach a crisis line: I've listed support resources for your region below. Talking to someone you trust (a friend, family member or a professional) can help too, and I'm here to keep talking if you want to.";

/** ------------------------------------------------------------------ output screening */

export interface OutputScreenOptions {
  /** Random token embedded in the system prompt; if it ever appears in output the prompt leaked. */
  canary?: string;
  /** The system prompt text, to detect verbatim leakage. */
  systemPrompt?: string;
  /** Literal strings that may appear verbatim (user's own message, approved knowledge): contact details inside are kept. */
  allowLiterals?: string[];
  /** Hosts whose links may be kept (our own web/API origins). */
  allowedHosts?: string[];
  /** URLs that appeared verbatim in trusted context. */
  knownUrls?: string[];
  /** A retrieved source looked hostile this turn: drop every link we cannot vouch for. */
  injectionSuspected?: boolean;
}

export interface OutputScreenResult {
  text: string;
  verdict: 'ok' | 'redacted' | 'blocked';
  reasons: string[];
  categories: Category[];
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'private_key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'stripe_key', re: /\b(?:sk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{16,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    name: 'password_assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"']{6,}/gi,
  },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE =
  /(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]?\d{3,4}(?![\w.])/g;

/** Secrets and payment/identity numbers: always redacted, everywhere (outputs, audit inputs, memory candidates). */
export function redactSecrets(text: string): { text: string; redactions: string[] } {
  const found: string[] = [];
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, () => {
      found.push(p.name);
      return `[redacted ${p.name.replace(/_/g, ' ')}]`;
    });
  }
  out = out.replace(CARD, (m) => {
    const d = m.replace(/[ -]/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d)) {
      found.push('card_number');
      return '[redacted card number]';
    }
    return m;
  });
  out = out.replace(SSN, () => {
    found.push('national_id');
    return '[redacted id number]';
  });
  return { text: out, redactions: found };
}

export const containsSecret = (text: string): boolean => redactSecrets(text).redactions.length > 0;

function redactContactInfo(text: string, allow: string[]): { text: string; redactions: string[] } {
  const found: string[] = [];
  const allowed = (s: string) => allow.some((a) => a.includes(s));
  let out = text.replace(EMAIL, (m) =>
    allowed(m) ? m : (found.push('email'), '[redacted email]'),
  );
  out = out.replace(PHONE, (m) =>
    allowed(m.trim()) || m.replace(/\D/g, '').length < 8
      ? m
      : (found.push('phone'), '[redacted phone number]'),
  );
  return { text: out, redactions: found };
}

const SELF_HARM_ENCOURAGEMENT =
  /\byou (?:should|ought to|could|must|need to|might as well|had better)\b[^.\n]{0,25}\b(?:kill yourself|end (?:it all|your life)|hurt yourself|cut yourself|commit suicide|take your own life|die)\b|\bkill yourself\b|\b(?:nobody|no one) would (?:miss|care about) you\b|\bthe world (?:is|would be) better (?:off )?without you\b/i;
const URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+/gi;
const IMG_RE = /!\[[^\]]*\]\([^)]*\)/g;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Shingles of `n` consecutive words, lower-cased, for verbatim-leak detection. */
function shingles(text: string, n: number): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export const LEAK_REFUSAL = "I can't share my configuration or instructions.";
export const MODERATION_REFUSAL =
  "I can't provide that response. If you were asking about something else, try rephrasing.";

export function screenOutput(raw: string, opts: OutputScreenOptions = {}): OutputScreenResult {
  const reasons: string[] = [];

  // 1. system prompt leakage
  if (opts.canary && raw.includes(opts.canary))
    return {
      text: LEAK_REFUSAL,
      verdict: 'blocked',
      reasons: ['system_prompt_canary'],
      categories: [],
    };
  if (opts.systemPrompt) {
    const sp = shingles(opts.systemPrompt, 8);
    let hits = 0;
    for (const s of shingles(raw, 8)) if (sp.has(s) && ++hits >= 2) break;
    if (hits >= 2)
      return {
        text: LEAK_REFUSAL,
        verdict: 'blocked',
        reasons: ['system_prompt_verbatim'],
        categories: [],
      };
  }

  let text = raw;

  // 2. secrets and contact details
  const s = redactSecrets(text);
  text = s.text;
  reasons.push(...s.redactions.map((r) => `redacted:${r}`));
  const c = redactContactInfo(text, opts.allowLiterals ?? []);
  text = c.text;
  reasons.push(...c.redactions.map((r) => `redacted:${r}`));

  // 3. exfiltration channels: images always, unvouched links when a source looked hostile (or always for unknown hosts with query strings)
  const beforeImg = text;
  text = text.replace(IMG_RE, '[image removed]');
  if (text !== beforeImg) reasons.push('removed:image');
  const hosts = new Set((opts.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const known = new Set(opts.knownUrls ?? []);
  text = text.replace(URL_RE, (u) => {
    if (known.has(u)) return u;
    const h = hostOf(u);
    if (h && hosts.has(h)) return u;
    const hasQuery = /[?&][^=\s]+=/.test(u);
    if (opts.injectionSuspected || hasQuery) {
      reasons.push('removed:link');
      return '[link removed]';
    }
    return u;
  });

  // 3b. encouraging self-harm is never shown, whatever the model was asked (the gateway replaces it with support resources)
  if (SELF_HARM_ENCOURAGEMENT.test(text)) {
    return {
      text: MODERATION_REFUSAL,
      verdict: 'blocked',
      reasons: [...reasons, 'self_harm_encouragement'],
      categories: ['self_harm'],
    };
  }

  // 4. moderation classifier on the final text (same rules that screen posts)
  const cls = classifyText(text);
  if (cls.status !== 'approved') {
    return {
      text: MODERATION_REFUSAL,
      verdict: 'blocked',
      reasons: [...reasons, ...cls.signals.map((x) => `moderation:${x.rule}`)],
      categories: cls.categories,
    };
  }
  return { text, verdict: reasons.length ? 'redacted' : 'ok', reasons, categories: [] };
}

/** For audit/log payloads: truncate long strings and redact secrets. */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return redactSecrets(value.length > 300 ? `${value.slice(0, 300)}…` : value).text;
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactForAudit(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = redactForAudit(v, depth + 1);
  return out;
}
