/**
 * Contact matching ("friends already on YAPILAPI"). Apps never send addresses or numbers:
 * each identifier is normalized, then hashed on the device as hex SHA-256 of the string
 * returned by contactHashInput, with the salt from GET /v1/contacts/salt. The server keeps
 * the same hash of each verified email and compares.
 */
export type ContactKind = 'email' | 'phone';

/** Trimmed and in lower case; null when it doesn't look like an email address. */
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(e) && e.length <= 254 ? e : null;
}

/** Every email address in a pasted block of text (a list, a CSV, an address book export), normalized and without repeats. */
export function emailsIn(text: string): string[] {
  const found = text.match(/[^\s@<>(),;:"'\[\]]+@[^\s@<>(),;:"'\[\]]+\.[^\s@<>(),;:"'\[\]]+/g) ?? [];
  return [...new Set(found.map((e) => normalizeEmail(e.replace(/[.]+$/, ''))).filter((e): e is string => !!e))];
}

/** The exact string to hash. `value` must already be normalized (lower-case email, E.164 phone number). */
export function contactHashInput(salt: string, kind: ContactKind, value: string): string {
  return `${salt}:${kind}:${value}`;
}
