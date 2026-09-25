/**
 * Money helpers. All amounts are INTEGERS in the currency's minor unit (cents for USD, whole yen for JPY).
 * Floating point is never used for money; conversions parse/format decimal strings.
 */

/** ISO 4217 currencies without a minor unit (amount 1 = one whole unit). */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
/** ISO 4217 currencies with three decimal places. */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);

/** Largest amount we accept anywhere (well inside Number.MAX_SAFE_INTEGER and Postgres bigint). */
export const MAX_MINOR_AMOUNT = 100_000_000_000; // 1e11 minor units

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const CODE_RE = /^[A-Z]{3}$/;

let supported: Set<string> | null = null;
function supportedCurrencies(): Set<string> {
  if (!supported) {
    try {
      supported = new Set(
        (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
          'currency',
        ),
      );
    } catch {
      supported = new Set();
    }
  }
  return supported;
}

/** Upper-cases and validates an ISO 4217 code. */
export function normalizeCurrency(input: string): string {
  const c = input.trim().toUpperCase();
  if (!CODE_RE.test(c)) throw new MoneyError(`Invalid currency code: ${input}`);
  const s = supportedCurrencies();
  if (s.size && !s.has(c)) throw new MoneyError(`Unsupported currency: ${c}`);
  return c;
}

export function currencyExponent(currency: string): 0 | 2 | 3 {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 3;
  return 2;
}

export function assertMinorAmount(amount: number, what = 'amount'): number {
  if (!Number.isSafeInteger(amount))
    throw new MoneyError(`${what} must be an integer number of minor units`);
  if (amount < 0) throw new MoneyError(`${what} must not be negative`);
  if (amount > MAX_MINOR_AMOUNT) throw new MoneyError(`${what} is too large`);
  return amount;
}

/** Parse a decimal string ("12.5", "12.50", "1200") into minor units. Rejects more decimals than the currency has. */
export function parseMoney(value: string, currency: string): number {
  const exp = currencyExponent(currency);
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new MoneyError(`Invalid amount: ${value}`);
  const frac = m[2] ?? '';
  if (frac.length > exp)
    throw new MoneyError(`${currency.toUpperCase()} amounts have at most ${exp} decimal places`);
  const minor = BigInt(m[1]! + frac.padEnd(exp, '0'));
  if (minor > BigInt(MAX_MINOR_AMOUNT)) throw new MoneyError('amount is too large');
  return Number(minor);
}

/** Format minor units as a plain decimal string without symbols ("12.34", "1200" for JPY). */
export function formatMoney(minor: number, currency: string): string {
  assertMinorAmount(Math.abs(minor));
  const exp = currencyExponent(currency);
  const neg = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (exp === 0) return `${neg}${abs}`;
  const s = String(abs).padStart(exp + 1, '0');
  return `${neg}${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

/** Safe integer addition (throws instead of silently losing precision). */
export function addMinor(...parts: number[]): number {
  let total = 0;
  for (const p of parts) {
    if (!Number.isSafeInteger(p)) throw new MoneyError('non-integer amount');
    total += p;
    if (!Number.isSafeInteger(total)) throw new MoneyError('amount overflow');
  }
  return total;
}

/** Multiply an integer amount by an integer quantity (safe). */
export function mulMinor(unit: number, quantity: number): number {
  if (!Number.isSafeInteger(unit) || !Number.isSafeInteger(quantity))
    throw new MoneyError('non-integer amount');
  const r = unit * quantity;
  if (!Number.isSafeInteger(r) || r > MAX_MINOR_AMOUNT) throw new MoneyError('amount overflow');
  return r;
}

export type Rounding = 'half_up' | 'down' | 'up';

/**
 * round(amount * numerator / denominator) in exact integer arithmetic (BigInt). `half_up` rounds .5 away from zero for
 * the non-negative values we deal with; `down` = floor; `up` = ceil.
 */
export function mulDiv(
  amount: number,
  numerator: number,
  denominator: number,
  rounding: Rounding = 'half_up',
): number {
  if (
    !Number.isSafeInteger(amount) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  ) {
    throw new MoneyError('mulDiv needs integer inputs and a positive denominator');
  }
  if (amount < 0 || numerator < 0)
    throw new MoneyError('mulDiv is defined for non-negative values only');
  const n = BigInt(amount) * BigInt(numerator);
  const d = BigInt(denominator);
  let q = n / d;
  const r = n % d;
  if (rounding === 'up' && r > 0n) q += 1n;
  else if (rounding === 'half_up' && r * 2n >= d) q += 1n;
  return Number(q);
}

/**
 * Split `total` across `weights` so the parts always sum to exactly `total` (largest-remainder method; ties go to the
 * earlier index). Used to allocate order-level amounts (shipping, discounts) to lines without losing a cent.
 */
export function allocate(total: number, weights: number[]): number[] {
  assertMinorAmount(total, 'total');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || sum <= 0 || weights.some((w) => !Number.isSafeInteger(w) || w < 0))
    throw new MoneyError('invalid weights');
  const base = weights.map((w) => mulDiv(total, w, sum, 'down'));
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, rem: Number((BigInt(total) * BigInt(w)) % BigInt(sum)) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    base[i]! += 1;
    left -= 1;
  }
  return base;
}
