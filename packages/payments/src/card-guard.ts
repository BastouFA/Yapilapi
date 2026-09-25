/**
 * Defence in depth: raw card data must never reach our servers. The client SDK exchanges card details for an opaque token /
 * payment-method id; anything that looks like a card number in request data is rejected before it can be stored or logged.
 */

/** Luhn checksum over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const PAN_CANDIDATE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;

/** True if the text contains a digit run (optionally space/dash separated) of 13-19 digits that passes the Luhn check. */
export function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(PAN_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

/** Deep scan of any JSON-like value. Keys are scanned too. */
export function containsCardNumberDeep(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === 'string') return containsCardNumber(value);
  if (typeof value === 'number') return containsCardNumber(String(value));
  if (Array.isArray(value)) return value.some((v) => containsCardNumberDeep(v, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => containsCardNumber(k) || containsCardNumberDeep(v, depth + 1),
    );
  }
  return false;
}

/** An opaque provider reference: `tok_`/`pm_`/`src_` prefix, limited charset, and never a card number. */
export const PAYMENT_METHOD_REF = /^(tok|pm|src)_[A-Za-z0-9_:=.-]{2,120}$/;
export function isPaymentMethodRef(value: string): boolean {
  return PAYMENT_METHOD_REF.test(value) && !containsCardNumber(value);
}
