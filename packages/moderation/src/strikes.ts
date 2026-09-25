/**
 * Strike escalation policy: a pure, configurable ladder. No I/O; the API's safety module feeds it the user's active
 * strike points and applies the result.
 *
 * Principles:
 *  - Strikes decay: only points earned inside `windowDays` count.
 *  - Proportionality: low-severity violations earn 1 point, critical ones earn more; zero-tolerance categories skip the
 *    ladder entirely (`immediate`).
 *  - The ladder AUTO-APPLIES up to a time-limited suspension. Permanent bans are only ever *recommended* here; a human
 *    with the right role must decide them.
 */

export type StrikeSeverity = 'low' | 'medium' | 'high' | 'critical';
export type LadderAction = 'none' | 'warning' | 'limit_reach' | 'suspension' | 'ban';

export interface LadderStep {
  /** Applies when active points are >= minPoints (highest matching step wins). */
  minPoints: number;
  action: Exclude<LadderAction, 'none'>;
  /** Duration in days for limit_reach / suspension; omitted for warning / ban. */
  days?: number;
}

export interface StrikePolicy {
  windowDays: number;
  pointsBySeverity: Record<StrikeSeverity, number>;
  /** Categories that skip the ladder and start at (at least) this action. */
  immediate: Record<string, { action: Exclude<LadderAction, 'none'>; days?: number }>;
  ladder: LadderStep[];
  /** The ladder never auto-applies these; they are returned as `recommendation`. */
  humanOnly: LadderAction[];
}

export const DEFAULT_STRIKE_POLICY: StrikePolicy = {
  windowDays: 90,
  pointsBySeverity: { low: 1, medium: 1, high: 2, critical: 3 },
  immediate: {
    minor_safety: { action: 'suspension', days: 30 },
    threat: { action: 'suspension', days: 14 },
  },
  ladder: [
    { minPoints: 1, action: 'warning' },
    { minPoints: 2, action: 'limit_reach', days: 3 },
    { minPoints: 3, action: 'suspension', days: 3 },
    { minPoints: 5, action: 'suspension', days: 14 },
    { minPoints: 7, action: 'ban' },
  ],
  humanOnly: ['ban'],
};

export function strikePointsFor(
  severity: StrikeSeverity,
  policy: StrikePolicy = DEFAULT_STRIKE_POLICY,
): number {
  return policy.pointsBySeverity[severity] ?? 1;
}

export interface EscalationInput {
  /** Points already active BEFORE this violation. */
  activePoints: number;
  severity: StrikeSeverity;
  categories?: readonly string[];
}

export interface Escalation {
  pointsAdded: number;
  totalPoints: number;
  /** What to apply automatically now. */
  action: LadderAction;
  days: number | null;
  /** Set when the ladder reached a human-only step (currently: ban). */
  recommendation: { action: LadderAction; days: number | null } | null;
  reason: 'ladder' | 'immediate_category' | 'none';
}

const ORDER: LadderAction[] = ['none', 'warning', 'limit_reach', 'suspension', 'ban'];
const rank = (a: LadderAction) => ORDER.indexOf(a);

/** Decide the account-level consequence of one more violation. */
export function escalate(
  input: EscalationInput,
  policy: StrikePolicy = DEFAULT_STRIKE_POLICY,
): Escalation {
  const pointsAdded = strikePointsFor(input.severity, policy);
  const totalPoints = Math.max(0, input.activePoints) + pointsAdded;

  let action: LadderAction = 'none';
  let days: number | null = null;
  let reason: Escalation['reason'] = 'none';
  for (const step of policy.ladder) {
    if (totalPoints >= step.minPoints && rank(step.action) >= rank(action)) {
      action = step.action;
      days = step.days ?? null;
      reason = 'ladder';
    }
  }
  for (const cat of input.categories ?? []) {
    const imm = policy.immediate[cat];
    if (
      imm &&
      (rank(imm.action) > rank(action) ||
        (rank(imm.action) === rank(action) && (imm.days ?? 0) > (days ?? 0)))
    ) {
      action = imm.action;
      days = imm.days ?? null;
      reason = 'immediate_category';
    }
  }

  let recommendation: Escalation['recommendation'] = null;
  if (policy.humanOnly.includes(action)) {
    recommendation = { action, days };
    // Fall back to the strongest automatic step below the human-only one.
    const fallback = [...policy.ladder]
      .reverse()
      .find((s) => !policy.humanOnly.includes(s.action) && totalPoints >= s.minPoints);
    action = fallback?.action ?? 'none';
    days = fallback?.days ?? null;
  }
  return { pointsAdded, totalPoints, action, days, recommendation, reason };
}

/** Sum the points that are still inside the decay window. */
export function activeStrikePoints(
  strikes: ReadonlyArray<{ points: number; at: Date; revoked?: boolean }>,
  now: Date = new Date(),
  policy: StrikePolicy = DEFAULT_STRIKE_POLICY,
): number {
  const cutoff = now.getTime() - policy.windowDays * 86_400_000;
  return strikes.reduce(
    (sum, s) => (s.revoked || s.at.getTime() < cutoff ? sum : sum + s.points),
    0,
  );
}
