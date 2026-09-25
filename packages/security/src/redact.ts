import { createHash } from 'node:crypto';

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|card|cvv|cvc|(^|[_-])pan($|[_-])|iban|otp|recovery|signature/i;

/** Deep-redact sensitive keys so passwords, tokens and payment data never reach logs. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out as T;
}

export const hashIp = (ip: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
