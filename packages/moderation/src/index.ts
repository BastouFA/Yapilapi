/**
 * Moderation pipeline: Content -> Analysis -> Risk classification -> Normal / Review / Restrict / Escalate.
 * (Appeal and Final decision are handled by the API's safety module using the case records.)
 *
 * This baseline is a transparent rule-based classifier. It is intentionally conservative about
 * auto-removal: only unambiguous, high-confidence patterns restrict content automatically; everything
 * uncertain goes to human review. It exposes the same interface an ML classifier would implement
 * (`TextClassifier`), so a model can be plugged in without touching callers.
 */

export type Risk = 'low' | 'medium' | 'high' | 'critical';
export type Action = 'normal' | 'review' | 'restrict' | 'escalate';
export type Category =
  | 'spam'
  | 'scam'
  | 'threat'
  | 'self_harm'
  | 'hate'
  | 'sexual_content'
  | 'harassment'
  | 'minor_safety'
  | 'malware'
  | 'personal_data';

export interface Signal {
  category: Category;
  rule: string;
  weight: number;
}

export interface Classification {
  action: Action;
  risk: Risk;
  categories: Category[];
  signals: Signal[];
  /** Maps to posts.moderation_status. */
  status: 'approved' | 'pending_review' | 'restricted' | 'escalated';
}

export interface TextClassifier {
  classify(text: string): Classification;
}

interface Rule {
  category: Category;
  name: string;
  re: RegExp;
  weight: number;
}

const RULES: Rule[] = [
  {
    category: 'scam',
    name: 'crypto_giveaway',
    re: /\b(send|deposit)\s+\d*\.?\d*\s*(btc|eth|usdt|bitcoin)\b.*\b(double|receive|get back)\b/i,
    weight: 8,
  },
  {
    category: 'scam',
    name: 'advance_fee',
    re: /\b(guaranteed|risk[- ]free)\s+(profit|returns?|income)\b/i,
    weight: 5,
  },
  {
    category: 'scam',
    name: 'seed_phrase_request',
    re: /\b(seed phrase|recovery phrase|private key)\b.*\b(send|share|dm|enter)\b/i,
    weight: 9,
  },
  {
    category: 'scam',
    name: 'gift_card_payment',
    re: /\bpay(ment)?\b.*\bgift ?cards?\b/i,
    weight: 5,
  },
  { category: 'spam', name: 'many_links', re: /(https?:\/\/\S+[\s\S]*){5,}/i, weight: 4 },
  { category: 'spam', name: 'repeated_char_run', re: /(.)\1{14,}/, weight: 2 },
  {
    category: 'spam',
    name: 'follow_for_follow',
    re: /\b(f4f|follow ?back|follow for follow|sub4sub)\b/i,
    weight: 2,
  },
  {
    category: 'threat',
    name: 'direct_threat',
    re: /\b(i('| a)?m going to|i will|gonna)\s+(kill|hurt|shoot|stab|murder)\s+(you|him|her|them)\b/i,
    weight: 9,
  },
  {
    category: 'self_harm',
    name: 'self_harm_intent',
    re: /\b(i want to|going to|plan to)\s+(kill myself|end my life|hurt myself)\b/i,
    weight: 7,
  },
  {
    category: 'malware',
    name: 'executable_link',
    re: /https?:\/\/\S+\.(exe|scr|bat|apk)\b/i,
    weight: 6,
  },
  { category: 'personal_data', name: 'card_number', re: /\b(?:\d[ -]?){15,16}\b/, weight: 6 },
  {
    category: 'minor_safety',
    name: 'adult_to_minor_secrecy',
    re: /\b(don'?t tell your (parents|mom|dad)|our (little )?secret)\b/i,
    weight: 8,
  },
];

const riskFor = (score: number): Risk =>
  score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';

export const ruleBasedClassifier: TextClassifier = {
  classify(text: string): Classification {
    const signals: Signal[] = [];
    for (const r of RULES)
      if (r.re.test(text)) signals.push({ category: r.category, rule: r.name, weight: r.weight });
    const score =
      signals.reduce((m, s) => Math.max(m, s.weight), 0) +
      Math.min(signals.length - 1, 2) * (signals.length > 1 ? 1 : 0);
    const risk = riskFor(score);
    const categories = [...new Set(signals.map((s) => s.category))];
    let action: Action = 'normal';
    let status: Classification['status'] = 'approved';
    if (risk === 'critical') {
      action = 'escalate';
      status = 'escalated';
    } else if (risk === 'high') {
      action = 'restrict';
      status = 'restricted';
    } else if (risk === 'medium') {
      action = 'review';
      status = 'pending_review';
    }
    // Self-harm content is never auto-restricted for the author; it is routed to review and the client shows support resources.
    if (categories.includes('self_harm') && risk !== 'critical') {
      action = 'review';
      status = 'pending_review';
    }
    return { action, risk, categories, signals, status };
  },
};

export const classifyText = (text: string): Classification => ruleBasedClassifier.classify(text);

export * from './strikes.js';
export * from './spam.js';
export * from './impersonation.js';
export * from './pipeline.js';
