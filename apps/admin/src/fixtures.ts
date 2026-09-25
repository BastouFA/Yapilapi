import type { AdminUserDetail, CaseDetail } from '@yapilapi/api-client';

export const CASE_ID = '11111111-2222-4333-8444-555555555555';
export const SUBJECT_ID = '22222222-2222-4333-8444-555555555555';
export const OTHER_STAFF = '33333333-2222-4333-8444-555555555555';

export function makeCase(over: Partial<CaseDetail> = {}): CaseDetail {
  return {
    id: CASE_ID,
    targetType: 'post',
    targetId: '44444444-2222-4333-8444-555555555555',
    subject: { id: SUBJECT_ID, username: 'spammer' },
    source: 'user_report',
    riskLevel: 'high',
    categories: ['spam'],
    state: 'review',
    decision: null,
    assignedTo: null,
    reportCount: 2,
    createdAt: '2026-09-20T10:00:00.000Z',
    decidedAt: null,
    signals: { velocity: 'high' },
    snapshot: { body: 'Buy cheap followers now', visibility: 'public' },
    currentContent: { body: 'Buy cheap followers now' },
    claimedAt: null,
    reports: [
      {
        id: '55555555-2222-4333-8444-555555555555',
        reporterId: '66666666-2222-4333-8444-555555555555',
        reason: 'spam',
        details: 'Looks like a bot',
        status: 'open',
        createdAt: '2026-09-20T09:00:00.000Z',
      },
    ],
    timeline: [
      {
        id: 1,
        actorId: null,
        event: 'opened',
        from: null,
        to: 'review',
        data: null,
        at: '2026-09-20T10:00:00.000Z',
      },
    ],
    appeals: [],
    subjectSummary: {
      id: SUBJECT_ID,
      username: 'spammer',
      displayName: 'Spammer',
      status: 'active',
      role: 'user',
      ageBand: 'adult',
      createdAt: '2026-01-01T00:00:00.000Z',
      activeStrikePoints: 1,
      enforcements: [],
    },
    ladderPreview: {
      pointsIfViolation: 1,
      totalPoints: 2,
      action: 'limit_reach',
      days: 3,
      recommendation: { action: 'limit_reach', days: 3 },
    },
    ...over,
  };
}

export function makeUser(over: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    id: SUBJECT_ID,
    username: 'ada',
    displayName: 'Ada Lovelace',
    status: 'active',
    role: 'user',
    ageBand: 'adult',
    mfaEnabled: false,
    email: 'a***@example.com',
    emailVerified: true,
    countryCode: 'GB',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-09-20T00:00:00.000Z',
    deletionScheduledFor: null,
    private: false,
    followers: 12,
    counts: { posts: 3, comments: 4, activeSessions: 1, reportsAgainst: 0, notes: 0 },
    enforcements: [],
    actions: { canSuspend: true, canReactivate: true, canChangeRole: true },
    ...over,
  };
}
