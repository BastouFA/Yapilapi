import type { Requester, RequestOptions } from './http';
import type { IsoDate, Page, Uuid } from './types';
import type { PlatformRoleName } from './admin-types';
import type * as A from './admin-types';

export * from './admin-types';

const enc = encodeURIComponent;
type Sig = { signal?: AbortSignal | undefined };
const opt = (o: Sig | undefined, extra: Partial<RequestOptions> = {}): RequestOptions => ({
  ...extra,
  signal: o?.signal,
});
type PageParams = Sig & { cursor?: string | undefined; limit?: number | undefined };
const pq = (p: PageParams | undefined) => ({ cursor: p?.cursor, limit: p?.limit });

/**
 * Staff console endpoints (/v1/admin/*, /v1/staff/*). The server is the authority on who may call them: every route
 * requires a staff role and an MFA-verified session, and answers 403 otherwise. The UI only uses `permissions` from
 * `admin.me()` to hide controls the signed-in role cannot use.
 */
export function createAdminApi(r: Requester) {
  const me = (o?: Sig & { skipUnauthorizedHook?: boolean }) =>
    r<A.AdminMe>('GET', '/v1/admin/me', opt(o, { skipUnauthorizedHook: o?.skipUnauthorizedHook }));

  const users = {
    search: (
      p: PageParams & {
        q: string;
        status?: string | undefined;
        role?: PlatformRoleName | undefined;
      },
    ) =>
      r<Page<A.AdminUserRow>>(
        'GET',
        '/v1/admin/users',
        opt(p, { query: { ...pq(p), q: p.q, status: p.status, role: p.role } }),
      ),
    get: (id: Uuid, o?: Sig) => r<A.AdminUserDetail>('GET', `/v1/admin/users/${enc(id)}`, opt(o)),
    notes: (id: Uuid, o?: Sig) =>
      r<{ items: A.AdminNote[] }>('GET', `/v1/admin/users/${enc(id)}/notes`, opt(o)),
    addNote: (id: Uuid, body: string, o?: Sig) =>
      r<{ id: Uuid; createdAt: IsoDate }>(
        'POST',
        `/v1/admin/users/${enc(id)}/notes`,
        opt(o, { body: { body } }),
      ),
    suspend: (id: Uuid, input: { reason: string; days: number }, o?: Sig) =>
      r<{ id: Uuid; status: 'suspended'; endsAt: IsoDate | null; enforcementId: Uuid }>(
        'POST',
        `/v1/admin/users/${enc(id)}/suspend`,
        opt(o, { body: input }),
      ),
    reactivate: (id: Uuid, reason: string, o?: Sig) =>
      r<{ id: Uuid; status: 'active' }>(
        'POST',
        `/v1/admin/users/${enc(id)}/reactivate`,
        opt(o, { body: { reason } }),
      ),
    setRole: (id: Uuid, input: { role: PlatformRoleName; reason: string }, o?: Sig) =>
      r<{ id: Uuid; role: PlatformRoleName }>(
        'PUT',
        `/v1/admin/users/${enc(id)}/role`,
        opt(o, { body: input }),
      ),
  };

  const content = {
    lookup: (type: A.ContentType, id: Uuid, o?: Sig) =>
      r<A.ContentLookup>('GET', `/v1/admin/content/${enc(type)}/${enc(id)}`, opt(o)),
    blockMedia: (id: Uuid, reason: string, o?: Sig) =>
      r<void>('POST', `/v1/admin/media/${enc(id)}/block`, opt(o, { body: { reason } })),
    unblockMedia: (id: Uuid, o?: Sig) =>
      r<void>('DELETE', `/v1/admin/media/${enc(id)}/block`, opt(o)),
  };

  const moderation = {
    queueStats: (o?: Sig) => r<A.QueueStats>('GET', '/v1/staff/moderation/queue-stats', opt(o)),
    cases: (p?: PageParams & A.CaseFilters) =>
      r<Page<A.CaseSummary>>(
        'GET',
        '/v1/staff/moderation/cases',
        opt(p, {
          query: {
            ...pq(p),
            state: p?.state,
            risk: p?.risk,
            targetType: p?.targetType,
            source: p?.source,
            category: p?.category,
            assigned: p?.assigned,
          },
        }),
      ),
    /** Read-only listing available to every staff role (including support). */
    casesReadOnly: (p?: PageParams & A.CaseFilters) =>
      r<Page<A.CaseSummary>>(
        'GET',
        '/v1/admin/cases',
        opt(p, {
          query: {
            ...pq(p),
            state: p?.state,
            risk: p?.risk,
            targetType: p?.targetType,
            source: p?.source,
            category: p?.category,
            assigned: p?.assigned,
          },
        }),
      ),
    case: (id: Uuid, o?: Sig) =>
      r<A.CaseDetail>('GET', `/v1/staff/moderation/cases/${enc(id)}`, opt(o)),
    caseReadOnly: (id: Uuid, o?: Sig) =>
      r<A.CaseDetail>('GET', `/v1/admin/cases/${enc(id)}`, opt(o)),
    claim: (id: Uuid, o?: Sig) =>
      r<{ assignedTo: Uuid }>('POST', `/v1/staff/moderation/cases/${enc(id)}/claim`, opt(o)),
    release: (id: Uuid, o?: Sig) =>
      r<{ assignedTo: null }>('POST', `/v1/staff/moderation/cases/${enc(id)}/release`, opt(o)),
    escalate: (id: Uuid, note: string, o?: Sig) =>
      r<{ state: 'escalated' }>(
        'POST',
        `/v1/staff/moderation/cases/${enc(id)}/escalate`,
        opt(o, { body: { note } }),
      ),
    decide: (id: Uuid, input: A.DecisionInput, o?: Sig) =>
      r<A.DecisionResult>(
        'POST',
        `/v1/staff/moderation/cases/${enc(id)}/decision`,
        opt(o, { body: input }),
      ),
    appeals: (p?: PageParams & { status?: 'open' | 'upheld' | 'overturned' }) =>
      r<Page<A.AppealRow>>(
        'GET',
        '/v1/staff/moderation/appeals',
        opt(p, { query: { ...pq(p), status: p?.status } }),
      ),
    reviewAppeal: (id: Uuid, input: { outcome: 'upheld' | 'overturned'; note: string }, o?: Sig) =>
      r<{ id: Uuid; status: string; restored: number }>(
        'POST',
        `/v1/staff/moderation/appeals/${enc(id)}/review`,
        opt(o, { body: input }),
      ),
    impersonationCheck: (p: {
      username?: string | undefined;
      displayName?: string | undefined;
      signal?: AbortSignal | undefined;
    }) =>
      r<A.ImpersonationResult>(
        'GET',
        '/v1/staff/moderation/impersonation-check',
        opt(p, { query: { username: p.username, displayName: p.displayName } }),
      ),
    reports: (
      p?: PageParams & {
        status?: 'open' | 'triaged' | 'actioned' | 'dismissed';
        reason?: string | undefined;
      },
    ) =>
      r<Page<A.ReportRow>>(
        'GET',
        '/v1/admin/reports',
        opt(p, { query: { ...pq(p), status: p?.status, reason: p?.reason } }),
      ),
  };

  const communities = {
    list: (p?: PageParams & { q?: string | undefined; suspended?: boolean | undefined }) =>
      r<Page<A.AdminCommunity>>(
        'GET',
        '/v1/admin/communities',
        opt(p, {
          query: {
            ...pq(p),
            q: p?.q,
            suspended: p?.suspended === undefined ? undefined : String(p.suspended),
          },
        }),
      ),
    suspend: (id: Uuid, reason: string, o?: Sig) =>
      r<{ id: Uuid; suspended: true }>(
        'POST',
        `/v1/admin/communities/${enc(id)}/suspend`,
        opt(o, { body: { reason } }),
      ),
    restore: (id: Uuid, reason: string, o?: Sig) =>
      r<{ id: Uuid; suspended: false }>(
        'POST',
        `/v1/admin/communities/${enc(id)}/restore`,
        opt(o, { body: { reason } }),
      ),
  };

  const businesses = {
    list: (
      p?: PageParams & {
        q?: string | undefined;
        status?: string | undefined;
        verified?: boolean | undefined;
      },
    ) =>
      r<Page<A.AdminBusiness>>(
        'GET',
        '/v1/admin/businesses',
        opt(p, {
          query: {
            ...pq(p),
            q: p?.q,
            status: p?.status,
            verified: p?.verified === undefined ? undefined : String(p.verified),
          },
        }),
      ),
    verify: (id: Uuid, note?: string, o?: Sig) =>
      r<unknown>(
        'POST',
        `/v1/staff/businesses/${enc(id)}/verify`,
        opt(o, { body: note ? { note } : {} }),
      ),
    unverify: (id: Uuid, note?: string, o?: Sig) =>
      r<unknown>(
        'POST',
        `/v1/staff/businesses/${enc(id)}/unverify`,
        opt(o, { body: note ? { note } : {} }),
      ),
    setStatus: (id: Uuid, input: { status: 'active' | 'suspended'; reason: string }, o?: Sig) =>
      r<{ id: Uuid; status: string }>(
        'PUT',
        `/v1/staff/businesses/${enc(id)}/status`,
        opt(o, { body: input }),
      ),
  };

  const creators = {
    list: (p?: PageParams & { status?: string | undefined; kyc?: string | undefined }) =>
      r<Page<A.AdminCreator>>(
        'GET',
        '/v1/admin/creators',
        opt(p, { query: { ...pq(p), status: p?.status, kyc: p?.kyc } }),
      ),
    kycQueue: (status: 'pending' | 'verified' | 'rejected' | 'unverified' = 'pending', o?: Sig) =>
      r<{ items: A.KycRow[] }>('GET', '/v1/staff/creators/kyc', opt(o, { query: { status } })),
    decideKyc: (id: Uuid, input: { decision: 'verify' | 'reject'; note: string }, o?: Sig) =>
      r<A.AdminCreatorView>('POST', `/v1/staff/creators/${enc(id)}/kyc`, opt(o, { body: input })),
    suspend: (id: Uuid, reason: string, o?: Sig) =>
      r<{ id: Uuid; status: 'suspended' }>(
        'POST',
        `/v1/admin/creators/${enc(id)}/suspend`,
        opt(o, { body: { reason } }),
      ),
    reinstate: (id: Uuid, reason: string, o?: Sig) =>
      r<{ id: Uuid; status: 'active' }>(
        'POST',
        `/v1/admin/creators/${enc(id)}/reinstate`,
        opt(o, { body: { reason } }),
      ),
  };

  const payments = {
    summary: (days = 30, o?: Sig) =>
      r<A.PaymentsSummary>('GET', '/v1/admin/payments/summary', opt(o, { query: { days } })),
    orders: (p?: PageParams & { status?: string | undefined }) =>
      r<Page<A.StaffOrder>>(
        'GET',
        '/v1/staff/orders',
        opt(p, { query: { ...pq(p), status: p?.status } }),
      ),
    order: (id: Uuid, o?: Sig) =>
      r<{ order: A.StaffOrder; fraudSignals: A.FraudSignalStage[] }>(
        'GET',
        `/v1/staff/orders/${enc(id)}`,
        opt(o),
      ),
    reviewOrder: (
      id: Uuid,
      input: { decision: 'approve' | 'reject'; note?: string | undefined },
      o?: Sig,
    ) =>
      r<{ id: Uuid; status: string }>(
        'POST',
        `/v1/staff/orders/${enc(id)}/review`,
        opt(o, { body: input }),
      ),
    refunds: (p?: PageParams & { status?: string | undefined }) =>
      r<Page<A.StaffRefund>>(
        'GET',
        '/v1/staff/refunds',
        opt(p, { query: { ...pq(p), status: p?.status } }),
      ),
    decideRefund: (
      id: Uuid,
      decision: 'approve' | 'deny',
      input: { note?: string | undefined; restock?: boolean | undefined } = {},
      o?: Sig,
    ) =>
      r<A.StaffRefund>('POST', `/v1/staff/refunds/${enc(id)}/${decision}`, opt(o, { body: input })),
    payouts: (p?: PageParams & { status?: string | undefined }) =>
      r<Page<A.StaffPayout>>(
        'GET',
        '/v1/staff/payouts',
        opt(p, { query: { ...pq(p), status: p?.status } }),
      ),
    retryPayout: (id: Uuid, o?: Sig) =>
      r<A.StaffPayout>('POST', `/v1/staff/payouts/${enc(id)}/retry`, opt(o)),
    failPayout: (id: Uuid, reason: string, o?: Sig) =>
      r<A.StaffPayout>('POST', `/v1/staff/payouts/${enc(id)}/fail`, opt(o, { body: { reason } })),
    disputes: (p?: {
      status?: 'open' | 'won' | 'lost' | undefined;
      limit?: number | undefined;
      signal?: AbortSignal | undefined;
    }) =>
      r<{ items: A.StaffDispute[] }>(
        'GET',
        '/v1/staff/disputes',
        opt(p, { query: { status: p?.status, limit: p?.limit } }),
      ),
    webhookEvents: (p?: {
      unprocessed?: boolean | undefined;
      limit?: number | undefined;
      signal?: AbortSignal | undefined;
    }) =>
      r<{ items: A.WebhookEvent[] }>(
        'GET',
        '/v1/staff/webhook-events',
        opt(p, {
          query: {
            unprocessed: p?.unprocessed === undefined ? undefined : String(p.unprocessed),
            limit: p?.limit,
          },
        }),
      ),
    reconciliation: (range: { from?: string | undefined; to?: string | undefined } = {}, o?: Sig) =>
      r<A.ReconciliationReport>('GET', '/v1/staff/reconciliation', opt(o, { query: range })),
  };

  const fraud = {
    summary: (days = 30, o?: Sig) =>
      r<A.FraudSummary>('GET', '/v1/admin/fraud/summary', opt(o, { query: { days } })),
    signals: (p?: {
      decision?: 'allow' | 'review' | 'block' | undefined;
      userId?: string | undefined;
      limit?: number | undefined;
      signal?: AbortSignal | undefined;
    }) =>
      r<{ items: A.FraudSignalRow[] }>(
        'GET',
        '/v1/staff/fraud-signals',
        opt(p, { query: { decision: p?.decision, userId: p?.userId, limit: p?.limit } }),
      ),
  };

  const ai = {
    usage: (days = 30, o?: Sig) =>
      r<A.AiUsage>('GET', '/v1/admin/ai/usage', opt(o, { query: { days } })),
  };

  const analytics = {
    msa: (weeks = 4, o?: Sig) =>
      r<A.MsaReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/msa',
        opt(o, { query: { weeks } }),
      ),
    acquisition: (days = 30, o?: Sig) =>
      r<A.AcquisitionReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/acquisition',
        opt(o, { query: { days } }),
      ),
    engagement: (days = 30, o?: Sig) =>
      r<A.EngagementReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/engagement',
        opt(o, { query: { days } }),
      ),
    retention: (weeks = 8, o?: Sig) =>
      r<A.RetentionReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/retention',
        opt(o, { query: { weeks } }),
      ),
    commerce: (days = 30, o?: Sig) =>
      r<A.CommerceReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/commerce',
        opt(o, { query: { days } }),
      ),
    creators: (days = 30, o?: Sig) =>
      r<A.CreatorsReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/creators',
        opt(o, { query: { days } }),
      ),
    safety: (days = 30, o?: Sig) =>
      r<A.SafetyReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/safety',
        opt(o, { query: { days } }),
      ),
    technical: (days = 30, o?: Sig) =>
      r<A.TechnicalReport | A.Unavailable>(
        'GET',
        '/v1/admin/analytics/technical',
        opt(o, { query: { days } }),
      ),
  };

  const audit = {
    search: (p?: PageParams & A.AuditFilters) =>
      r<{ items: A.AuditEntry[]; nextCursor: string | null }>(
        'GET',
        '/v1/admin/audit',
        opt(p, {
          query: {
            cursor: p?.cursor,
            limit: p?.limit,
            actorId: p?.actorId,
            action: p?.action,
            actionPrefix: p?.actionPrefix,
            targetType: p?.targetType,
            targetId: p?.targetId,
            from: p?.from,
            to: p?.to,
          },
        }),
      ),
  };

  const flags = {
    list: (o?: Sig) => r<{ items: A.FlagView[] }>('GET', '/v1/admin/flags', opt(o)),
    update: (
      key: string,
      input: { enabled?: boolean | undefined; rolloutPct?: number | undefined; reason: string },
      o?: Sig,
    ) => r<A.FlagView>('PUT', `/v1/admin/flags/${enc(key)}`, opt(o, { body: input })),
    overrides: (key: string, o?: Sig) =>
      r<{ items: A.FlagOverride[] }>('GET', `/v1/admin/flags/${enc(key)}/overrides`, opt(o)),
    setOverride: (
      key: string,
      userId: Uuid,
      input: { enabled: boolean; reason: string },
      o?: Sig,
    ) =>
      r<{ key: string; userId: Uuid; enabled: boolean }>(
        'PUT',
        `/v1/admin/flags/${enc(key)}/overrides/${enc(userId)}`,
        opt(o, { body: input }),
      ),
    removeOverride: (key: string, userId: Uuid, o?: Sig) =>
      r<void>('DELETE', `/v1/admin/flags/${enc(key)}/overrides/${enc(userId)}`, opt(o)),
  };

  const system = {
    health: (o?: Sig) => r<A.SystemHealth>('GET', '/v1/admin/system/health', opt(o)),
  };

  const miniApps = {
    list: (
      p?: PageParams & { status?: 'draft' | 'in_review' | 'published' | 'rejected' | 'suspended' },
    ) =>
      r<Page<A.StaffMiniApp>>(
        'GET',
        '/v1/staff/mini-apps',
        opt(p, { query: { ...pq(p), status: p?.status } }),
      ),
    review: (
      id: Uuid,
      input: {
        decision: 'approve' | 'reject' | 'suspend' | 'reinstate';
        note?: string | undefined;
      },
      o?: Sig,
    ) => r<unknown>('PUT', `/v1/staff/mini-apps/${enc(id)}/review`, opt(o, { body: input })),
  };

  return {
    me,
    users,
    content,
    moderation,
    communities,
    businesses,
    creators,
    payments,
    fraud,
    ai,
    analytics,
    audit,
    flags,
    system,
    miniApps,
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
