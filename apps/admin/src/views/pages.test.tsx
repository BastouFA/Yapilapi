import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MsaReport, RetentionReport, StaffOrder } from '@yapilapi/api-client';
import { fakeClient, renderAsStaff } from '@/test-utils';
import { AnalyticsView } from './Analytics';
import { AuditView } from './Audit';
import { DashboardView } from './Dashboard';
import { ModerationQueueView } from './ModerationQueue';
import { PaymentsView } from './Payments';
import { UsersView } from './Users';

describe('users search', () => {
  it('does not list anyone until a search is submitted, and needs 2+ characters', async () => {
    const search = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    renderAsStaff(<UsersView />, { client: fakeClient({ admin: { users: { search } } }) });
    expect(screen.getByText('Search to see accounts')).toBeInTheDocument();
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Search' });
    await user.type(screen.getByLabelText(/^Username, email or id/), 'a');
    expect(button).toBeDisabled();
    expect(search).not.toHaveBeenCalled();
  });

  it('searches with the filters and shows masked emails from the API', async () => {
    const search = vi.fn().mockResolvedValue({
      items: [
        {
          id: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
          username: 'ada',
          displayName: 'Ada',
          status: 'suspended',
          role: 'user',
          ageBand: 'adult',
          createdAt: '2026-01-01T00:00:00.000Z',
          email: 'a***@example.com',
        },
      ],
      nextCursor: 'next-page',
    });
    renderAsStaff(<UsersView />, {
      role: 'support',
      client: fakeClient({ admin: { users: { search } } }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Username, email or id/), 'ada');
    await user.selectOptions(screen.getByLabelText('Status'), 'suspended');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('link', { name: 'ada' })).toHaveAttribute(
      'href',
      '/users/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    );
    expect(screen.getByText('a***@example.com')).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'ada', status: 'suspended', limit: 25 }),
    );
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('shows an honest empty state when nothing matches', async () => {
    renderAsStaff(<UsersView />, {
      client: fakeClient({
        admin: { users: { search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) } },
      }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Username, email or id/), 'nobody');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No accounts found')).toBeInTheDocument();
  });
});

describe('moderation queue', () => {
  const page = {
    items: [
      {
        id: '11111111-2222-4333-8444-555555555555',
        targetType: 'post',
        targetId: 'x',
        subject: { id: 'y', username: 'spammer' },
        source: 'automated',
        riskLevel: 'critical',
        categories: ['minor_safety'],
        state: 'review',
        decision: null,
        assignedTo: null,
        reportCount: 3,
        createdAt: '2026-09-20T10:00:00.000Z',
        decidedAt: null,
      },
    ],
    nextCursor: null,
  };

  it('gives moderators the working queue with stats', async () => {
    const admin = {
      queueStats: vi.fn().mockResolvedValue({
        queue: [
          {
            state: 'review',
            riskLevel: 'critical',
            count: 4,
            oldest: '2026-09-19T00:00:00.000Z',
          },
        ],
        openAppeals: 2,
      }),
      cases: vi.fn().mockResolvedValue(page),
      casesReadOnly: vi.fn(),
    };
    renderAsStaff(<ModerationQueueView />, {
      role: 'moderator',
      client: fakeClient({ admin: { moderation: admin } }),
    });
    expect(await screen.findByRole('link', { name: '11111111' })).toHaveAttribute(
      'href',
      '/moderation/cases/11111111-2222-4333-8444-555555555555',
    );
    expect(
      within(screen.getByRole('table', { name: 'Cases' })).getByText('Minor safety'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Open appeals')).toBeInTheDocument();
    expect(admin.casesReadOnly).not.toHaveBeenCalled();
  });

  it('gives support the read-only listing and no queue stats (the staff endpoint would refuse them)', async () => {
    const admin = {
      queueStats: vi.fn(),
      cases: vi.fn(),
      casesReadOnly: vi.fn().mockResolvedValue(page),
    };
    renderAsStaff(<ModerationQueueView />, {
      role: 'support',
      client: fakeClient({ admin: { moderation: admin } }),
    });
    await screen.findByRole('link', { name: '11111111' });
    expect(admin.queueStats).not.toHaveBeenCalled();
    expect(admin.cases).not.toHaveBeenCalled();
  });

  it('passes filters through to the API', async () => {
    const admin = {
      queueStats: vi.fn().mockResolvedValue({ queue: [], openAppeals: 0 }),
      cases: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    renderAsStaff(<ModerationQueueView />, {
      role: 'moderator',
      client: fakeClient({ admin: { moderation: admin } }),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Risk'), 'critical');
    await waitFor(() =>
      expect(admin.cases).toHaveBeenLastCalledWith(expect.objectContaining({ risk: 'critical' })),
    );
    expect(await screen.findByText('No cases match')).toBeInTheDocument();
  });
});

describe('dashboard', () => {
  it('does not call endpoints the role cannot use', async () => {
    const admin = {
      system: { health: vi.fn() },
      moderation: { queueStats: vi.fn() },
      analytics: { engagement: vi.fn(), msa: vi.fn() },
    };
    renderAsStaff(<DashboardView />, { role: 'support', client: fakeClient({ admin }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(admin.system.health).not.toHaveBeenCalled();
    expect(admin.moderation.queueStats).not.toHaveBeenCalled();
    expect(admin.analytics.engagement).not.toHaveBeenCalled();
    expect(screen.getByText('users.read', { selector: 'code' })).toBeInTheDocument();
  });

  it('shows system health to admins and flags backlogs that need attention', async () => {
    const admin = {
      system: {
        health: vi.fn().mockResolvedValue({
          time: '2026-09-21T10:00:00.000Z',
          uptimeSec: 7200,
          runtime: { node: 'v22', env: 'test', memoryMb: 200 },
          database: { ok: true, latencyMs: 3, migrations: { applied: 40, latest: '261_x' } },
          adapters: { email: 'MemoryEmail' },
          backlogs: {
            webhooksFailed24h: 3,
            openModerationCases: 9,
            deadPushTokens: { available: false },
          },
          featureFlags: { enabled: 5, total: 8 },
        }),
      },
      moderation: { queueStats: vi.fn().mockResolvedValue({ queue: [], openAppeals: 0 }) },
      analytics: {
        engagement: vi.fn().mockResolvedValue({ available: false }),
        msa: vi.fn().mockResolvedValue({ available: false }),
      },
    };
    renderAsStaff(<DashboardView />, { role: 'admin', client: fakeClient({ admin }) });
    expect(await screen.findByTestId('health-db')).toHaveTextContent('Healthy, 3 ms');
    expect(screen.getByText('Webhook deliveries failed (24 h)')).toBeInTheDocument();
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
  });

  it('tells the person when the health call fails, with the request id', async () => {
    const { ApiError } = await import('@yapilapi/api-client');
    const admin = {
      system: {
        health: vi
          .fn()
          .mockRejectedValue(new ApiError('internal', 'boom SQL detail', 500, 'req-health-1')),
      },
      moderation: { queueStats: vi.fn().mockResolvedValue({ queue: [], openAppeals: 0 }) },
      analytics: {
        engagement: vi.fn().mockResolvedValue({ available: false }),
        msa: vi.fn().mockResolvedValue({ available: false }),
      },
    };
    renderAsStaff(<DashboardView />, { role: 'admin', client: fakeClient({ admin }) });
    expect(await screen.findByText('req-health-1')).toBeInTheDocument();
    expect(screen.queryByText(/SQL detail/)).toBeNull();
  });
});

describe('analytics', () => {
  it('shows suppressed small counts as hidden, never as zero', async () => {
    const msa: MsaReport = {
      definition: {
        msa: 'A deliberate action that reaches another person.',
        notMsa: ['Reactions'],
        dailyCapPerUserPerType: { message: 10, comment: 10, post: 5, plan: 5 },
        meaningfulWeeklyParticipant: '3 actions on 2 days.',
      },
      minCell: 5,
      windows: [
        {
          windowStart: '2026-09-15',
          windowEnd: '2026-09-21',
          participants: null,
          mwp: null,
          mwpShare: null,
          actionsByType: { message: null, comment: 12, post: null, plan: null },
        },
      ],
    };
    renderAsStaff(<AnalyticsView tab="msa" />, {
      role: 'admin',
      client: fakeClient({ admin: { analytics: { msa: vi.fn().mockResolvedValue(msa) } } }),
    });
    expect(
      await screen.findByText('A deliberate action that reaches another person.'),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Weekly windows' });
    expect(within(table).getAllByText('Hidden (fewer than 5)')).toHaveLength(3);
    expect(within(table).queryByText('0')).toBeNull();
  });

  it('degrades a section the API marks unavailable without failing the page', async () => {
    renderAsStaff(<AnalyticsView tab="commerce" />, {
      role: 'admin',
      client: fakeClient({
        admin: { analytics: { commerce: vi.fn().mockResolvedValue({ available: false }) } },
      }),
    });
    expect(await screen.findByText(/This section is unavailable right now/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Analytics sections' })).toBeInTheDocument();
  });

  it('renders retention as a real table with a caption', async () => {
    const r: RetentionReport = {
      definition: 'Retained means a write action.',
      minCell: 5,
      cohorts: [
        {
          cohortWeek: '2026-08-31',
          size: 40,
          weeks: [
            { week: 0, retained: 40, rate: 1 },
            { week: 1, retained: null, rate: null },
          ],
        },
      ],
    };
    renderAsStaff(<AnalyticsView tab="retention" />, {
      role: 'admin',
      client: fakeClient({ admin: { analytics: { retention: vi.fn().mockResolvedValue(r) } } }),
    });
    const table = await screen.findByRole('table', { name: 'Retention by signup week' });
    expect(within(table).getByText('100%')).toBeInTheDocument();
    expect(within(table).getByText('Hidden (fewer than 5)')).toBeInTheDocument();
  });

  it('lets people change the period and refetches', async () => {
    const eng = vi.fn().mockResolvedValue({
      definition: 'd',
      periodDays: 30,
      dauPerDay: [],
      current: { dau: 10, wau: 20, mau: 30, stickiness: 0.33 },
    });
    renderAsStaff(<AnalyticsView tab="engagement" />, {
      role: 'admin',
      client: fakeClient({ admin: { analytics: { engagement: eng } } }),
    });
    await screen.findByText('Daily active people', { selector: '.kpi__label' });
    await userEvent.selectOptions(screen.getByLabelText('Period'), '90');
    await waitFor(() => expect(eng).toHaveBeenLastCalledWith(90, expect.anything()));
  });
});

describe('audit log viewer', () => {
  const entries = [
    {
      id: 12,
      actorId: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
      actorType: 'staff',
      action: 'moderation.case_decided',
      targetType: 'moderation_case',
      targetId: 'c1',
      requestId: 'req-77',
      metadata: { decision: 'remove', reason: 'spam' },
      createdAt: '2026-09-21T10:00:00.000Z',
    },
    {
      id: 11,
      actorId: null,
      actorType: 'system',
      action: 'safety.enforcement_expired',
      targetType: null,
      targetId: null,
      requestId: null,
      metadata: null,
      createdAt: '2026-09-21T09:00:00.000Z',
    },
  ];

  it('lists entries newest first with details behind a disclosure', async () => {
    const search = vi.fn().mockResolvedValue({ items: entries, nextCursor: null });
    renderAsStaff(<AuditView />, {
      role: 'admin',
      client: fakeClient({ admin: { audit: { search } } }),
    });
    expect(await screen.findByText('moderation.case_decided')).toBeInTheDocument();
    expect(screen.getByText('safety.enforcement_expired')).toBeInTheDocument();
    expect(screen.getByText('req-77'.slice(0, 8))).toBeInTheDocument();
    expect(screen.getByText('Show details')).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it('searches by action prefix and can be reset', async () => {
    const search = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    renderAsStaff(<AuditView />, {
      role: 'admin',
      client: fakeClient({ admin: { audit: { search } } }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Action starts with/), 'moderation.');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ actionPrefix: 'moderation.' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ actionPrefix: expect.anything() }),
      ),
    );
  });

  it('blocks an invalid actor id before it reaches the API', async () => {
    const search = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    renderAsStaff(<AuditView />, {
      role: 'admin',
      client: fakeClient({ admin: { audit: { search } } }),
    });
    await userEvent.type(await screen.findByLabelText(/^Actor id/), 'zzz');
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    expect(screen.getByText('Enter a full id (a UUID).')).toBeInTheDocument();
  });
});

describe('payments', () => {
  const order = {
    id: 'aaaaaaaa-2222-4333-8444-555555555555',
    status: 'pending_review',
    currency: 'USD',
    subtotalCents: 1000,
    shippingCents: 0,
    taxCents: 0,
    totalCents: 1000,
    refundedCents: 0,
    items: [],
    seller: { type: 'user', id: null },
    payment: null,
    heldForReview: true,
    cancelReason: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    paidAt: null,
    buyer: { id: 'b', username: 'buyer1' },
    fraud: { score: 85, decision: 'review', flags: ['velocity'] },
  } as unknown as StaffOrder;

  it('shows support only the overview (the queues are for admins)', async () => {
    const summary = vi.fn().mockResolvedValue({
      periodDays: 30,
      orders: [],
      payments: [],
      refunds: [],
      payouts: [],
      actions: {},
    });
    renderAsStaff(<PaymentsView tab="overview" />, {
      role: 'support',
      client: fakeClient({ admin: { payments: { summary } } }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Payments' });
    const nav = screen.getByRole('navigation', { name: 'Payments sections' });
    expect(within(nav).getAllByRole('link')).toHaveLength(1);
  });

  it('rejecting a held order needs a typed confirmation and sends the decision', async () => {
    const payments = {
      orders: vi.fn().mockResolvedValue({ items: [order], nextCursor: null }),
      order: vi.fn().mockResolvedValue({ order, fraudSignals: [] }),
      reviewOrder: vi.fn().mockResolvedValue({ id: order.id, status: 'cancelled' }),
    };
    renderAsStaff(<PaymentsView tab="orders" />, {
      role: 'admin',
      client: fakeClient({ admin: { payments } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this order' });
    const submit = within(dialog).getByRole('button', { name: 'Reject' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'aaaaaaaa');
    await user.type(within(dialog).getByLabelText(/Note/), 'Stolen card pattern');
    await user.click(submit);
    await waitFor(() =>
      expect(payments.reviewOrder).toHaveBeenCalledWith(order.id, {
        decision: 'reject',
        note: 'Stolen card pattern',
      }),
    );
  });
});
