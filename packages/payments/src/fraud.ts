import { currencyExponent } from './money.js';

export type FraudDecision = 'allow' | 'review' | 'block';

export interface FraudReason {
  code: string;
  weight: number;
  detail: string;
}

export interface FraudInput {
  /** Order/payment amount in minor units. */
  amountMinor: number;
  currency: string;
  accountAgeHours: number;
  user: {
    ordersLastHour: number;
    ordersLast24h: number;
    failedPaymentsLast24h: number;
    /** Average of the user's previous paid orders in the same currency (minor units), null when there are none. */
    avgPaidOrderMinor: number | null;
    paidOrders: number;
  };
  network: {
    /** Distinct other users seen with the same IP hash in the last 24h. */
    ipDistinctUsers24h: number;
    /** Distinct other users who used the same card fingerprint in the last 24h. */
    fingerprintDistinctUsers24h: number;
  };
  geo: {
    accountCountry?: string | null | undefined;
    shippingCountry?: string | null | undefined;
    billingCountry?: string | null | undefined;
    cardCountry?: string | null | undefined;
    ipCountry?: string | null | undefined;
  };
}

export interface FraudConfig {
  reviewAt: number;
  blockAt: number;
  velocity: {
    userPerHourReview: number;
    userPerHourBlock: number;
    userPerDayReview: number;
    failed24hReview: number;
    failed24hBlock: number;
  };
  network: { ipUsersReview: number; fingerprintUsersReview: number; fingerprintUsersBlock: number };
  amount: { anomalyRatio: number; anomalyMinPriorOrders: number; highValueUsd: number };
  newAccount: { hours: number; highValueUsd: number };
  /** Coarse USD value of one MAJOR unit, used only for the risk thresholds (not for pricing, never shown to users). */
  usdPerMajorUnit: Record<string, number>;
}

export const DEFAULT_FRAUD_CONFIG: FraudConfig = {
  reviewAt: 50,
  blockAt: 100,
  velocity: {
    userPerHourReview: 5,
    userPerHourBlock: 12,
    userPerDayReview: 20,
    failed24hReview: 3,
    failed24hBlock: 8,
  },
  network: { ipUsersReview: 5, fingerprintUsersReview: 3, fingerprintUsersBlock: 6 },
  amount: { anomalyRatio: 5, anomalyMinPriorOrders: 2, highValueUsd: 2_000 },
  newAccount: { hours: 24, highValueUsd: 200 },
  usdPerMajorUnit: {
    USD: 1,
    EUR: 1.1,
    GBP: 1.3,
    CAD: 0.73,
    AUD: 0.66,
    CHF: 1.1,
    JPY: 0.0067,
    CNY: 0.14,
    INR: 0.012,
    NGN: 0.0007,
    GHS: 0.07,
    KES: 0.0077,
    ZAR: 0.055,
    BRL: 0.19,
    MXN: 0.055,
    SEK: 0.095,
    NOK: 0.093,
    DKK: 0.15,
    PLN: 0.25,
    KRW: 0.00073,
    SGD: 0.74,
    AED: 0.27,
    TRY: 0.03,
  },
};

export interface FraudResult {
  decision: FraudDecision;
  score: number;
  reasons: FraudReason[];
}

/** Approximate USD value of an amount for risk thresholds. Unknown currencies count as 1 USD per major unit (conservative for expensive ones). */
export function approxUsd(
  amountMinor: number,
  currency: string,
  cfg: FraudConfig = DEFAULT_FRAUD_CONFIG,
): number {
  const major = amountMinor / 10 ** currencyExponent(currency);
  return major * (cfg.usdPerMajorUnit[currency.toUpperCase()] ?? 1);
}

/**
 * Pure rules engine. Each rule adds a weight; the sum decides: >= blockAt => block, >= reviewAt => review, else allow.
 * Rules: user velocity, card-fingerprint sharing across users, IP sharing, repeated failed payments, amount anomalies
 * (versus the user's history and absolute high value), country mismatch (account/shipping/billing/card/IP) and
 * high-value purchases from brand-new accounts. Reasons are returned for staff and audit, never shown verbatim to buyers.
 */
export function evaluateFraud(
  input: FraudInput,
  cfg: FraudConfig = DEFAULT_FRAUD_CONFIG,
): FraudResult {
  const reasons: FraudReason[] = [];
  const add = (code: string, weight: number, detail: string) =>
    reasons.push({ code, weight, detail });
  const { user, network, geo } = input;
  const usd = approxUsd(input.amountMinor, input.currency, cfg);

  // ---- velocity
  if (user.ordersLastHour >= cfg.velocity.userPerHourBlock)
    add('velocity_user_hour_extreme', 100, `${user.ordersLastHour} orders in the last hour`);
  else if (user.ordersLastHour >= cfg.velocity.userPerHourReview)
    add('velocity_user_hour', 55, `${user.ordersLastHour} orders in the last hour`);
  if (user.ordersLast24h >= cfg.velocity.userPerDayReview)
    add('velocity_user_day', 55, `${user.ordersLast24h} orders in 24 hours`);
  if (user.failedPaymentsLast24h >= cfg.velocity.failed24hBlock)
    add(
      'failed_payments_extreme',
      100,
      `${user.failedPaymentsLast24h} failed payments in 24 hours`,
    );
  else if (user.failedPaymentsLast24h >= cfg.velocity.failed24hReview)
    add('failed_payments', 55, `${user.failedPaymentsLast24h} failed payments in 24 hours`);
  if (network.fingerprintDistinctUsers24h >= cfg.network.fingerprintUsersBlock)
    add(
      'card_shared_extreme',
      100,
      `card used by ${network.fingerprintDistinctUsers24h + 1} accounts in 24 hours`,
    );
  else if (network.fingerprintDistinctUsers24h >= cfg.network.fingerprintUsersReview)
    add(
      'card_shared',
      60,
      `card used by ${network.fingerprintDistinctUsers24h + 1} accounts in 24 hours`,
    );
  if (network.ipDistinctUsers24h >= cfg.network.ipUsersReview)
    add('ip_shared', 35, `${network.ipDistinctUsers24h + 1} accounts from one network in 24 hours`);

  // ---- amount anomalies
  if (
    user.avgPaidOrderMinor &&
    user.paidOrders >= cfg.amount.anomalyMinPriorOrders &&
    input.amountMinor >= user.avgPaidOrderMinor * cfg.amount.anomalyRatio
  ) {
    add(
      'amount_anomaly',
      40,
      `amount is at least ${cfg.amount.anomalyRatio}x this buyer's average order`,
    );
  }
  if (usd >= cfg.amount.highValueUsd) add('high_value', 30, 'unusually high order value');

  // ---- new account with a valuable order
  if (input.accountAgeHours < cfg.newAccount.hours && usd >= cfg.newAccount.highValueUsd) {
    add(
      'new_account_high_value',
      55,
      `account is ${Math.max(0, Math.floor(input.accountAgeHours))}h old`,
    );
  }

  // ---- geography
  const cc = (s?: string | null) => (s ? s.toUpperCase() : null);
  const known = (
    ['accountCountry', 'shippingCountry', 'billingCountry', 'cardCountry', 'ipCountry'] as const
  )
    .map((k) => cc(geo[k]))
    .filter((v): v is string => Boolean(v));
  const distinct = new Set(known);
  if (distinct.size >= 3)
    add('country_mismatch_multiple', 55, `signals disagree across ${distinct.size} countries`);
  else if (distinct.size === 2) {
    const card = cc(geo.cardCountry);
    const ship = cc(geo.shippingCountry) ?? cc(geo.billingCountry);
    if (
      (card && ship && card !== ship) ||
      (cc(geo.accountCountry) && ship && cc(geo.accountCountry) !== ship)
    )
      add('country_mismatch', 30, 'card, account and shipping countries differ');
    else add('country_mismatch', 20, 'location signals disagree');
  }

  const score = reasons.reduce((s, r) => s + r.weight, 0);
  const decision: FraudDecision =
    score >= cfg.blockAt ? 'block' : score >= cfg.reviewAt ? 'review' : 'allow';
  return { decision, score, reasons };
}
