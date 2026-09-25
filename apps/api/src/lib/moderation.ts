/**
 * Automated analysis for the trust & safety pipeline:
 *   Content → Automated analysis → Risk classification → normal / review / restrict / escalate
 * Heuristic and fast; a classifier service can replace analyzeText behind the same interface.
 */
export type Risk = 'normal' | 'review' | 'restrict' | 'escalate';

export interface Analysis {
  risk: Risk;
  signals: string[];
}

// Deliberately small, high-precision lists. Extend per region/locale (regional moderation).
const ESCALATE = [/\b(kill|hurt) (yourself|urself)\b/i, /\bsend (me )?nudes?\b.*\b(age|years? old|\d{1,2} ?yo)\b/i];
const RESTRICT = [/\b(buy|cheap) (followers|likes)\b/i, /\bfree (crypto|bitcoin|iphone)\b/i, /\bclick (this|the) link to (claim|win)\b/i];
const REVIEW = [/\b(idiot|stupid|loser)\b/i, /\bdm me for (prices|deals)\b/i];

export function analyzeText(text: string): Analysis {
  const signals: string[] = [];
  if (!text) return { risk: 'normal', signals };
  if (ESCALATE.some((r) => r.test(text))) signals.push('severe_harm');
  if (RESTRICT.some((r) => r.test(text))) signals.push('spam_scam');
  if (REVIEW.some((r) => r.test(text))) signals.push('possible_harassment');
  const links = text.match(/https?:\/\//g)?.length ?? 0;
  if (links > 4) signals.push('many_links');
  if (/(.)\1{14,}/.test(text)) signals.push('repeated_characters');
  const upper = text.replace(/[^A-Z]/g, '').length;
  if (text.length > 40 && upper / text.length > 0.7) signals.push('shouting');

  const risk: Risk = signals.includes('severe_harm')
    ? 'escalate'
    : signals.includes('spam_scam') || signals.includes('many_links')
      ? 'restrict'
      : signals.length
        ? 'review'
        : 'normal';
  return { risk, signals };
}

/** Map risk to the stored moderation status of a post or comment. */
export function statusForRisk(risk: Risk): 'normal' | 'review' | 'restricted' {
  return risk === 'normal' ? 'normal' : risk === 'review' ? 'review' : 'restricted';
}
