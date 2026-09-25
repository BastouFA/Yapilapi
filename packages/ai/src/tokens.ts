import type { Usage } from './types.js';

/** Rough, provider-independent estimate (about four characters per token). Used for budgets before a call is made. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Static USD price table, dollars per million tokens (input, output). Approximate: budgets, not invoices. */
const PRICES: Array<{ match: RegExp; inPerM: number; outPerM: number }> = [
  { match: /^claude-.*opus/i, inPerM: 15, outPerM: 75 },
  { match: /^claude-.*sonnet/i, inPerM: 3, outPerM: 15 },
  { match: /^claude-.*haiku/i, inPerM: 1, outPerM: 5 },
  { match: /^gpt-4o-mini/i, inPerM: 0.15, outPerM: 0.6 },
  { match: /^gpt-4o/i, inPerM: 2.5, outPerM: 10 },
  { match: /^text-embedding/i, inPerM: 0.02, outPerM: 0 },
];

/** Estimated cost in millionths of a USD. The dev provider and unknown models cost 0. */
export function estimateCostMicros(provider: string, model: string, usage: Usage): number {
  if (provider === 'dev') return 0;
  const p = PRICES.find((x) => x.match.test(model));
  if (!p) return 0;
  return Math.round(usage.inputTokens * p.inPerM + usage.outputTokens * p.outPerM);
}
