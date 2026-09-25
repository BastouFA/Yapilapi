/** Response and request shapes of the staff console API (hand-maintained against apps/api/src/modules/{admin,safety,payments,...}). */
import type { IsoDate, Uuid } from './types';

export type PlatformRoleName = 'user' | 'support' | 'moderator' | 'admin' | 'superadmin';
export const STAFF_ROLE_NAMES: readonly PlatformRoleName[] = [
  'support',
  'moderator',
  'admin',
  'superadmin',
];
export const PLATFORM_ROLE_NAMES: readonly PlatformRoleName[] = [
  'user',
  'support',
  'moderator',
  'admin',
  'superadmin',
];

/** Sections that failed server side degrade to this instead of failing the whole response. */
export interface Unavailable {
  available: false;
}
export const isUnavailable = (v: unknown): v is Unavailable =>
  typeof v === 'object' && v !== null && (v as { available?: unknown }).available === false;

export interface AdminMe {
  userId: Uuid;
  role: PlatformRoleName;
  permissions: string[];
}

// ------------------------------------------------------------------ users
export interface AdminUserRow {
  id: Uuid;
  username: string | null;
  displayName: string | null;
  status: string;
  role: PlatformRoleName;
  ageBand: string;
  createdAt: IsoDate;
  /** Masked (o***@host) below the admin role. */
  email: string;
}
export interface AdminEnforcement {
  id: Uuid;
  kind: string;
  reason: string | null;
  startsAt: IsoDate;
  endsAt: IsoDate | null;
  revokedAt: IsoDate | null;
  strikePoints: number;
}
export interface AdminUserDetail {
  id: Uuid;
  username: string | null;
  displayName: string | null;
  status: string;
  role: PlatformRoleName;
  ageBand: string;
  mfaEnabled: boolean;
  email: string;
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: IsoDate;
  lastLoginAt: IsoDate | null;
  deletionScheduledFor: IsoDate | null;
  private: boolean | null;
  followers: number | null;
  counts: {
    posts: number;
    comments: number;
    activeSessions: number;
    reportsAgainst: number;
    notes: number;
  };
  enforcements: AdminEnforcement[];
  actions: { canSuspend: boolean; canReactivate: boolean; canChangeRole: boolean };
}
export interface AdminNote {
  id: Uuid;
  body: string;
  createdAt: IsoDate;
  authorId: Uuid | null;
  author: string | null;
}

// ------------------------------------------------------------------ content
export type ContentType =
  | 'post'
  | 'comment'
  | 'moment'
  | 'community'
  | 'event'
  | 'product'
  | 'place'
  | 'business'
  | 'review'
  | 'live';
export const CONTENT_TYPES: readonly ContentType[] = [
  'post',
  'comment',
  'moment',
  'community',
  'event',
  'product',
  'place',
  'business',
  'review',
  'live',
];
export interface ContentLookup {
  type: string;
  id: Uuid;
  ownerId: Uuid | null;
  snapshot: Record<string, unknown>;
  cases: Array<{
    id: Uuid;
    state: string;
    risk_level: string;
    categories: string[];
    decision: string | null;
    created_at: IsoDate;
  }>;
}

// ------------------------------------------------------------------ moderation
export type CaseState = 'normal' | 'review' | 'restricted' | 'escalated' | 'appealed' | 'resolved';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export const CASE_STATES: readonly CaseState[] = [
  'review',
  'escalated',
  'restricted',
  'appealed',
  'normal',
  'resolved',
];
export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];
export const DECISIONS = [
  'no_action',
  'label',
  'limit_reach',
  'remove',
  'suspend_user',
  'ban_user',
] as const;
export type Decision = (typeof DECISIONS)[number];
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'violence',
  'sexual_content',
  'self_harm',
  'misinformation',
  'scam',
  'impersonation',
  'minor_safety',
  'illegal',
  'ip_violation',
  'other',
] as const;
export const REPORT_TARGET_TYPES = [
  'user',
  'post',
  'comment',
  'moment',
  'message',
  'community',
  'event',
  'product',
  'place',
  'business',
  'review',
  'live',
] as const;

export interface CaseFilters {
  state?: CaseState | undefined;
  risk?: RiskLevel | undefined;
  targetType?: string | undefined;
  source?: 'user_report' | 'automated' | 'staff' | undefined;
  category?: string | undefined;
  assigned?: 'me' | 'none' | 'any' | undefined;
}
export interface CaseSummary {
  id: Uuid;
  targetType: string;
  targetId: Uuid;
  subject: { id: Uuid; username: string | null } | null;
  source: string;
  riskLevel: RiskLevel;
  categories: string[];
  state: CaseState;
  decision: string | null;
  assignedTo: Uuid | null;
  reportCount: number;
  createdAt: IsoDate;
  decidedAt: IsoDate | null;
  pipeline?: unknown;
}
export interface CaseDetail extends Omit<CaseSummary, 'decision'> {
  signals: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
  currentContent: Record<string, unknown> | null;
  decision: {
    decision: string;
    reason: string | null;
    note: string | null;
    decidedBy: Uuid | null;
    decidedAt: IsoDate | null;
    effects: unknown;
  } | null;
  claimedAt: IsoDate | null;
  reports: Array<{
    id: Uuid;
    reporterId?: Uuid;
    reason: string;
    details: string | null;
    status: string;
    createdAt: IsoDate;
  }>;
  timeline: Array<{
    id: number | string;
    actorId: Uuid | null;
    event: string;
    from: string | null;
    to: string | null;
    data: Record<string, unknown> | null;
    at: IsoDate;
  }>;
  appeals: Array<{
    id: Uuid;
    userId: Uuid | null;
    status: string;
    statement: string;
    reviewerId: Uuid | null;
    reviewerNote: string | null;
    originalDeciderId: Uuid | null;
    createdAt: IsoDate;
    decidedAt: IsoDate | null;
  }>;
  subjectSummary: {
    id: Uuid;
    username: string | null;
    displayName: string | null;
    status: string;
    role: PlatformRoleName;
    ageBand: string;
    createdAt: IsoDate;
    activeStrikePoints: number;
    enforcements: Array<{
      id: Uuid;
      kind: string;
      reason: string | null;
      strikePoints: number;
      startsAt: IsoDate;
      endsAt: IsoDate | null;
      revokedAt: IsoDate | null;
      caseId: Uuid | null;
    }>;
  } | null;
  ladderPreview: {
    pointsIfViolation: number;
    totalPoints: number;
    action: string;
    days: number | null;
    recommendation: { action: string; days: number | null } | null;
  } | null;
}
export interface QueueStats {
  queue: Array<{ state: string; riskLevel: RiskLevel; count: number; oldest: IsoDate | null }>;
  openAppeals: number;
}
export interface DecisionInput {
  decision: Decision;
  reason: string;
  note?: string | undefined;
  durationDays?: number | undefined;
}
export interface DecisionResult {
  caseId: Uuid;
  decision: Decision;
  state: 'resolved';
  enforcementIds: Uuid[];
  contentEffects: number;
  strike: {
    pointsAdded: number;
    totalPoints: number;
    ladderAction: string;
    ladderDays: number | null;
  } | null;
}
export interface AppealRow {
  id: Uuid;
  caseId: Uuid;
  userId: Uuid | null;
  status: 'open' | 'upheld' | 'overturned';
  statement: string;
  decision: string | null;
  targetType: string;
  riskLevel: RiskLevel;
  originalDeciderId: Uuid | null;
  reviewerId: Uuid | null;
  createdAt: IsoDate;
  decidedAt: IsoDate | null;
}
export interface ImpersonationMatch {
  identityId: string;
  kind: 'business' | 'staff' | 'creator' | 'reserved';
  field: 'username' | 'displayName';
  score: number;
  reason: string;
}
export interface ImpersonationResult {
  risk: 'none' | 'low' | 'high';
  best: ImpersonationMatch | null;
  matches: ImpersonationMatch[];
}
export interface ReportRow {
  id: Uuid;
  targetType: string;
  targetId: Uuid;
  reason: string;
  status: string;
  reporterId: Uuid | null;
  createdAt: IsoDate;
}

// ------------------------------------------------------------------ entities
export interface AdminCommunity {
  id: Uuid;
  slug: string;
  name: string;
  visibility: string;
  memberCount: number;
  ownerId: Uuid | null;
  createdAt: IsoDate;
  suspended: boolean;
}
export interface AdminBusiness {
  id: Uuid;
  slug: string;
  name: string;
  category: string | null;
  status: string;
  verified: boolean;
  ownerId: Uuid | null;
  createdAt: IsoDate;
}
export interface AdminCreator {
  userId: Uuid;
  username: string | null;
  status: string;
  kycStatus: string;
  category: string | null;
  followers: number | null;
  createdAt: IsoDate;
}
export interface KycRow {
  userId: Uuid;
  username: string;
  kycStatus: string;
  submittedAt: IsoDate | null;
  decidedAt: IsoDate | null;
  note: string | null;
}
export interface AdminCreatorView {
  userId: Uuid;
  status: string;
  kycStatus: string;
  category: string | null;
  kycNote: string | null;
}

// ------------------------------------------------------------------ payments & fraud
export interface StatusAgg {
  status: string;
  currency: string;
  count: number;
  total_cents?: number | string;
  amount_cents?: number | string;
  platform_fee_cents?: number | string;
}
export interface PaymentsSummary {
  periodDays: number;
  orders: StatusAgg[] | Unavailable;
  payments: StatusAgg[] | Unavailable;
  refunds: StatusAgg[] | Unavailable;
  payouts: StatusAgg[] | Unavailable;
  actions: Record<string, string>;
}
export interface StaffOrderItem {
  id: Uuid;
  title: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  kind: string | null;
  type: string;
}
export interface StaffOrder {
  id: Uuid;
  status: string;
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  refundedCents: number;
  platformFeeCents?: number;
  items: StaffOrderItem[];
  buyer?: { id: Uuid; username?: string; displayName?: string };
  seller: { type: 'user' | 'business'; id: Uuid | null };
  payment: { id: Uuid; status: string; failureCode: string | null; provider: string } | null;
  heldForReview: boolean;
  cancelReason: string | null;
  createdAt: IsoDate;
  paidAt: IsoDate | null;
  fraud?: { score: number | null; decision: string | null; flags: string[] | null };
}
export interface FraudSignalStage {
  stage: string;
  decision: string;
  score: number;
  reasons: string[] | null;
  created_at: IsoDate;
}
export interface StaffRefund {
  id: Uuid;
  orderId: Uuid | null;
  paymentId: Uuid;
  amountCents: number;
  currency: string;
  reason: string | null;
  status: string;
  restock: boolean;
  automatic: boolean;
  decisionNote: string | null;
  failureCode: string | null;
  requestedBy: Uuid | null;
  decidedBy: Uuid | null;
  createdAt: IsoDate;
  decidedAt: IsoDate | null;
  succeededAt: IsoDate | null;
}
export interface StaffPayout {
  id: Uuid;
  payee: { type: 'user' | 'business'; id: Uuid | null };
  amountCents: number;
  currency: string;
  status: string;
  failureCode: string | null;
  verification: unknown;
  createdAt: IsoDate;
}
export interface StaffDispute {
  id: Uuid;
  payment_id: Uuid | null;
  order_id: Uuid | null;
  provider: string;
  provider_ref: string | null;
  status: string;
  reason: string | null;
  amount_cents: number;
  currency: string;
  opened_at: IsoDate;
  closed_at: IsoDate | null;
}
export interface WebhookEvent {
  id: Uuid;
  provider: string;
  event_id: string;
  event_type: string;
  signature_valid: boolean;
  received_at: IsoDate;
  processed_at: IsoDate | null;
  error: string | null;
}
export interface ReconciliationReport {
  provider: string;
  from: IsoDate;
  to: IsoDate;
  ok: boolean;
  providerRecords: number;
  ledgerRecords: number;
  matched: number;
  discrepancies: Array<Record<string, unknown>>;
  integrity: Array<{ type: string; ref: string; detail: string }>;
}
export interface FraudSummary {
  periodDays: number;
  ordersHeldForReview: number | Unavailable;
  topFlags: Array<{ flag: string; count: number }> | Unavailable;
  disputedPayments: number | Unavailable;
  scoreBands: Array<{ band: string; count: number }> | Unavailable;
  reviewQueue: string;
}
export interface FraudSignalRow {
  id: Uuid;
  user_id: Uuid | null;
  subject_type: string;
  subject_id: string;
  stage: string;
  decision: 'allow' | 'review' | 'block';
  score: number;
  reasons: string[] | null;
  signals: Record<string, unknown> | null;
  created_at: IsoDate;
}
export interface AiUsage {
  periodDays: number;
  assistantMessages: Array<{ provider: string; model: string; count: number }> | Unavailable;
  toolCalls: Array<{ tool: string; outcome: string; count: number }> | Unavailable;
  drafts: Array<{ kind: string; status: string; count: number }> | Unavailable;
  daily: Array<{ day: string; assistant_messages: number; conversations: number }> | Unavailable;
  consent: { users_with_ai_consent: number } | Unavailable;
}

// ------------------------------------------------------------------ analytics (counts under 5 are suppressed to null)
export type Cell = number | null;
export interface AcquisitionReport {
  periodDays: number;
  signupsPerDay: Array<{ day: string; signups: Cell }>;
  onboarding: { signups: Cell; onboarded: Cell; completionRate: number | null };
  onboardingFunnel: {
    basis: string;
    steps: Array<{ step: string | null; action: string | null; people: Cell }>;
  };
  referrers: { basis: string; rows: Array<{ referrer: string | null; opens: Cell }> };
}
export interface EngagementReport {
  definition: string;
  periodDays: number;
  dauPerDay: Array<{ day: string; dau: Cell }>;
  current: { dau: Cell; wau: Cell; mau: Cell; stickiness: number | null };
}
export interface RetentionReport {
  definition: string;
  minCell: number;
  cohorts: Array<{
    cohortWeek: string;
    size: Cell;
    weeks: Array<{ week: number; retained: Cell; rate: number | null }>;
  }>;
}
export interface MsaReport {
  definition: {
    msa: string;
    notMsa: string[];
    dailyCapPerUserPerType: Record<string, number>;
    meaningfulWeeklyParticipant: string;
  };
  minCell: number;
  windows: Array<{
    windowStart: string;
    windowEnd: string;
    participants: Cell;
    mwp: Cell;
    mwpShare: number | null;
    actionsByType: Record<string, Cell>;
  }>;
}
export interface CreatorsReport {
  periodDays: number;
  creatorsByStatus: Array<{ status: string; kyc_status: string; creators: Cell }>;
  subscriptionsByStatus: Array<{ status: string; subscriptions: Cell }>;
  tips: Array<{
    currency: string;
    tips: Cell;
    creators: Cell;
    amount_cents: number | string | null;
  }>;
}
export interface CommerceReport {
  periodDays: number;
  ordersByStatus: Array<{ status: string; orders: Cell }>;
  paidOrders: Array<{ currency: string; orders: Cell; total_cents: number | string | null }>;
}
export interface SafetyReport {
  periodDays: number;
  reports: Array<{ reason: string; status: string; reports: Cell }>;
  cases: Array<{ source: string; state: string; cases: Cell }>;
  timeToDecision: { decided: Cell; medianHours: number | null };
  appeals: Array<{ status: string; appeals: Cell }>;
  enforcements: Array<{ kind: string; enforcements: Cell }>;
}
export interface TechnicalReport {
  periodDays: number;
  basis: string;
  webVitalsP75: Array<{
    metric: string | null;
    platform: string;
    samples: Cell;
    p75: number | null;
  }>;
  clientErrors: Array<{ code: string | null; screen: string | null; errors: Cell }>;
  eventVolume: Array<{ day: string; source: string; events: number }>;
}

// ------------------------------------------------------------------ audit, flags, system
export interface AuditFilters {
  actorId?: string | undefined;
  action?: string | undefined;
  actionPrefix?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}
export interface AuditEntry {
  id: number | string;
  actorId: Uuid | null;
  actorType: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: IsoDate;
}
export interface FlagView {
  key: string;
  description: string | null;
  enabled: boolean;
  rolloutPct: number;
  updatedAt: IsoDate;
  known: boolean;
  overrides?: number;
}
export interface FlagOverride {
  userId: Uuid;
  username: string | null;
  enabled: boolean;
}
export interface SystemHealth {
  time: IsoDate;
  uptimeSec: number;
  runtime: { node: string; env: string; memoryMb: number };
  database: {
    ok: boolean;
    latencyMs?: number;
    pool?: { total: number; idle: number; waiting: number };
    migrations?: { applied: number; latest: string | null };
  };
  adapters: Record<string, string>;
  backlogs: Record<string, number | Unavailable>;
  featureFlags: { enabled: number; total: number } | Unavailable;
}
export interface StaffMiniApp {
  id: Uuid;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  manifest: Record<string, unknown> | null;
  status: string;
  submittedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  reviewedAt?: IsoDate | null;
  reviewNote?: string | null;
  appName: string;
  developer: string | null;
}
