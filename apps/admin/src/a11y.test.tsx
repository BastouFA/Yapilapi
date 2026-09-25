import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { FlagView } from '@yapilapi/api-client';
import { CASE_ID, makeCase, makeUser, SUBJECT_ID } from '@/fixtures';
import { fakeClient, renderAsStaff, renderPublic } from '@/test-utils';
import { LoginFlow } from '@/components/LoginFlow';
import { Shell } from '@/components/Shell';
import { AnalyticsView } from '@/views/Analytics';
import { AuditView } from '@/views/Audit';
import { CaseDetailView } from '@/views/CaseDetail';
import { FlagsView } from '@/views/Flags';
import { IdentityView } from '@/views/Identity';
import { UserDetailView } from '@/views/UserDetail';
import { UsersView } from '@/views/Users';

/** axe-core in jsdom: colour contrast needs real layout, so it is checked on the design tokens instead. */
async function violations(node: Element = document.body) {
  const r = await axe.run(node, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return r.violations.map(
    (v) =>
      `${v.id}: ${v.help} (${v.nodes
        .slice(0, 2)
        .map((n) => n.target.join(' '))
        .join(', ')})`,
  );
}

const FLAG: FlagView = {
  key: 'MINI_APPS',
  description: 'Mini apps',
  enabled: true,
  rolloutPct: 50,
  updatedAt: '2026-09-20T10:00:00.000Z',
  known: true,
  overrides: 1,
};

describe('accessibility (axe-core)', () => {
  it('sign in: every step', async () => {
    const auth = { login: vi.fn().mockResolvedValue({ mfaRequired: true, challengeToken: 'c' }) };
    renderPublic(<LoginFlow next="/" />, { client: fakeClient({ auth }) });
    expect(await violations()).toEqual([]);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Email/), 'a@b.co');
    await user.type(screen.getByLabelText(/^Password/), 'pw');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Two-factor code' });
    expect(await violations()).toEqual([]);
  });

  it('shell with the user search page', async () => {
    renderAsStaff(
      <Shell>
        <UsersView />
      </Shell>,
      { role: 'admin' },
    );
    expect(await violations()).toEqual([]);
  });

  it('case detail, and its decision dialog', async () => {
    const admin = { moderation: { case: vi.fn().mockResolvedValue(makeCase()) } };
    renderAsStaff(
      <main>
        <CaseDetailView id={CASE_ID} />
      </main>,
      { role: 'moderator', client: fakeClient({ admin }) },
    );
    await screen.findByRole('heading', { level: 1 });
    expect(await violations()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Decide case' }));
    await screen.findByRole('dialog');
    expect(await violations(screen.getByRole('dialog'))).toEqual([]);
  });

  it('user detail', async () => {
    const admin = {
      users: {
        get: vi.fn().mockResolvedValue(
          makeUser({
            enforcements: [
              {
                id: 'e1',
                kind: 'suspension',
                reason: 'spam',
                startsAt: '2026-09-01T00:00:00.000Z',
                endsAt: null,
                revokedAt: null,
                strikePoints: 1,
              },
            ],
          }),
        ),
        notes: vi.fn().mockResolvedValue({
          items: [
            {
              id: 'n',
              body: 'note',
              createdAt: '2026-09-01T00:00:00.000Z',
              authorId: null,
              author: 'Staff',
            },
          ],
        }),
      },
    };
    renderAsStaff(
      <main>
        <UserDetailView id={SUBJECT_ID} />
      </main>,
      { role: 'admin', client: fakeClient({ admin }) },
    );
    await screen.findByRole('heading', { level: 1, name: 'ada' });
    await screen.findByText('note');
    expect(await violations()).toEqual([]);
  });

  it('flags', async () => {
    const admin = {
      flags: {
        list: vi.fn().mockResolvedValue({ items: [FLAG] }),
        overrides: vi.fn().mockResolvedValue({
          items: [{ userId: SUBJECT_ID, username: 'tester', enabled: true }],
        }),
      },
    };
    renderAsStaff(
      <main>
        <FlagsView />
      </main>,
      { role: 'admin', client: fakeClient({ admin }) },
    );
    await screen.findByText('MINI_APPS');
    expect(await violations()).toEqual([]);
  });

  it('audit log with data', async () => {
    const search = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          actorId: SUBJECT_ID,
          actorType: 'staff',
          action: 'admin.flag_updated',
          targetType: 'feature_flag',
          targetId: 'X',
          requestId: 'r',
          metadata: { a: 1 },
          createdAt: '2026-09-21T10:00:00.000Z',
        },
      ],
      nextCursor: 'n',
    });
    renderAsStaff(
      <main>
        <AuditView />
      </main>,
      { role: 'admin', client: fakeClient({ admin: { audit: { search } } }) },
    );
    await screen.findByText('admin.flag_updated');
    expect(await violations()).toEqual([]);
  });

  it('analytics charts', async () => {
    const report = {
      definition: {
        msa: 'x',
        notMsa: ['y'],
        dailyCapPerUserPerType: { message: 10 },
        meaningfulWeeklyParticipant: 'z',
      },
      minCell: 5,
      windows: [
        {
          windowStart: '2026-09-08',
          windowEnd: '2026-09-14',
          participants: 10,
          mwp: 6,
          mwpShare: 0.6,
          actionsByType: { message: 20 },
        },
        {
          windowStart: '2026-09-15',
          windowEnd: '2026-09-21',
          participants: null,
          mwp: null,
          mwpShare: null,
          actionsByType: { message: null },
        },
      ],
    };
    renderAsStaff(
      <main>
        <AnalyticsView tab="msa" />
      </main>,
      {
        role: 'admin',
        client: fakeClient({ admin: { analytics: { msa: vi.fn().mockResolvedValue(report) } } }),
      },
    );
    await screen.findByText('What counts');
    await waitFor(() =>
      expect(
        screen.getByRole('figure', { name: 'Meaningful weekly participants' }),
      ).toBeInTheDocument(),
    );
    expect(await violations()).toEqual([]);
  });

  it('identity check result', async () => {
    const check = vi.fn().mockResolvedValue({
      risk: 'high',
      best: null,
      matches: [
        { identityId: 'i', kind: 'business', field: 'username', score: 0.9, reason: 'lookalike' },
      ],
    });
    renderAsStaff(
      <main>
        <IdentityView />
      </main>,
      {
        role: 'moderator',
        client: fakeClient({ admin: { moderation: { impersonationCheck: check } } }),
      },
    );
    await userEvent.type(screen.getByLabelText('Username'), 'paypa1');
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText('Lookalike characters');
    expect(await violations()).toEqual([]);
  });

  it('right-to-left rendering keeps the same structure', async () => {
    renderAsStaff(
      <Shell>
        <UsersView />
      </Shell>,
      { role: 'support', locale: 'ar' },
    );
    expect(await violations()).toEqual([]);
  });
});
