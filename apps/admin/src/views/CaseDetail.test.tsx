import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@yapilapi/api-client';
import { CASE_ID, makeCase, OTHER_STAFF } from '@/fixtures';
import { fakeClient, renderAsStaff } from '@/test-utils';
import { CaseDetailView, decisionOptions, DESTRUCTIVE_DECISIONS } from './CaseDetail';

const ME = '00000000-0000-4000-8000-000000000001';

function view(
  role: 'support' | 'moderator' | 'admin',
  detail = makeCase(),
  extra: Record<string, unknown> = {},
) {
  const admin = {
    case: vi.fn().mockResolvedValue(detail),
    caseReadOnly: vi.fn().mockResolvedValue(detail),
    claim: vi.fn().mockResolvedValue({ assignedTo: ME }),
    release: vi.fn().mockResolvedValue({ assignedTo: null }),
    escalate: vi.fn().mockResolvedValue({ state: 'escalated' }),
    decide: vi.fn().mockResolvedValue({
      caseId: CASE_ID,
      decision: 'remove',
      state: 'resolved',
      enforcementIds: [],
      contentEffects: 1,
      strike: null,
    }),
    reviewAppeal: vi.fn(),
    ...extra,
  };
  renderAsStaff(<CaseDetailView id={CASE_ID} />, {
    role,
    client: fakeClient({ admin: { moderation: admin } }),
    userId: ME,
  });
  return admin;
}

describe('decisionOptions', () => {
  it('hides bans from moderators and account actions when there is no account', () => {
    expect(decisionOptions({ targetType: 'post', hasSubject: true, canBan: false })).not.toContain(
      'ban_user',
    );
    expect(decisionOptions({ targetType: 'post', hasSubject: true, canBan: true })).toContain(
      'ban_user',
    );
    expect(decisionOptions({ targetType: 'post', hasSubject: false, canBan: true })).toEqual([
      'no_action',
      'label',
      'limit_reach',
      'remove',
    ]);
  });

  it('never offers "remove" for an account target (the API says to suspend or ban instead)', () => {
    expect(decisionOptions({ targetType: 'user', hasSubject: true, canBan: true })).not.toContain(
      'remove',
    );
  });

  it('treats removal, suspension and bans as destructive', () => {
    expect([...DESTRUCTIVE_DECISIONS].sort()).toEqual(['ban_user', 'remove', 'suspend_user']);
  });
});

describe('case detail as a moderator', () => {
  it('shows the evidence, the reports and the strike ladder recommendation', async () => {
    view('moderator');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Case 11111111/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Buy cheap followers now').length).toBeGreaterThan(0);
    expect(screen.getByText('Looks like a bot')).toBeInTheDocument();
    expect(screen.getByTestId('ladder')).toHaveTextContent('Recommended: Limit reach for 3 days');
    expect(screen.getByTestId('ladder')).toHaveTextContent(/A recommendation for you/);
  });

  it('uses the moderation endpoint (with reporters) rather than the read-only one', async () => {
    const api = view('moderator');
    await screen.findByRole('heading', { level: 1 });
    expect(api.case).toHaveBeenCalled();
    expect(api.caseReadOnly).not.toHaveBeenCalled();
  });

  it('claims a case', async () => {
    const api = view('moderator');
    await userEvent.click(await screen.findByRole('button', { name: 'Claim case' }));
    await waitFor(() => expect(api.claim).toHaveBeenCalledWith(CASE_ID));
    expect(api.case).toHaveBeenCalledTimes(2);
  });

  it('shows the API refusal when another moderator holds the case', async () => {
    const api = view('moderator', makeCase(), {
      claim: vi
        .fn()
        .mockRejectedValue(
          new ApiError('conflict', 'This case is claimed by another moderator', 409, 'req-9'),
        ),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Claim case' }));
    expect(
      await screen.findByText('This case is claimed by another moderator'),
    ).toBeInTheDocument();
    expect(api.claim).toHaveBeenCalled();
  });

  it('cannot ban: the ban option is not offered', async () => {
    view('moderator');
    await userEvent.click(await screen.findByRole('button', { name: 'Decide case' }));
    const dialog = screen.getByRole('dialog');
    const options = within(dialog)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('Suspend account');
    expect(options).not.toContain('Ban account');
  });

  it('removing content needs a reason and the typed case id, then sends both to the API', async () => {
    const api = view('moderator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Decide case' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Decision/), 'remove');
    const submit = within(dialog).getByRole('button', { name: 'Apply decision' });
    await user.type(within(dialog).getByLabelText(/Reason \(shown to the person\)/), 'Spam links');
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type "11111111" to confirm/), '11111111');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith(CASE_ID, {
        decision: 'remove',
        reason: 'Spam links',
      }),
    );
  });

  it('a non-destructive decision needs no typed phrase and sends the internal note', async () => {
    const api = view('moderator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Decide case' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Decision/), 'no_action');
    expect(within(dialog).queryByLabelText(/to confirm/)).toBeNull();
    await user.type(
      within(dialog).getByLabelText(/Reason \(shown to the person\)/),
      'No violation found',
    );
    await user.type(within(dialog).getByLabelText(/Internal note/), 'checked history');
    await user.click(within(dialog).getByRole('button', { name: 'Apply decision' }));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith(CASE_ID, {
        decision: 'no_action',
        reason: 'No violation found',
        note: 'checked history',
      }),
    );
  });

  it('a suspension sends the length in days and rejects lengths outside 1 to 365', async () => {
    const api = view('moderator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Decide case' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^Decision/), 'suspend_user');
    await user.type(
      within(dialog).getByLabelText(/Reason \(shown to the person\)/),
      'Repeated spam',
    );
    await user.type(within(dialog).getByLabelText(/Type "11111111" to confirm/), '11111111');
    const days = within(dialog).getByLabelText(/Suspension length/);
    await user.clear(days);
    await user.type(days, '400');
    expect(within(dialog).getByRole('button', { name: 'Apply decision' })).toBeDisabled();
    await user.clear(days);
    await user.type(days, '14');
    await user.click(within(dialog).getByRole('button', { name: 'Apply decision' }));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith(CASE_ID, {
        decision: 'suspend_user',
        reason: 'Repeated spam',
        durationDays: 14,
      }),
    );
  });

  it('escalates with a note', async () => {
    const api = view('moderator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Escalate to admins' }));
    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByLabelText(/Why it needs an admin/),
      'Possible minor safety issue',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Escalate to admins' }));
    await waitFor(() =>
      expect(api.escalate).toHaveBeenCalledWith(CASE_ID, 'Possible minor safety issue'),
    );
  });

  it('cannot decide an escalated case (admins do)', async () => {
    view('moderator', makeCase({ state: 'escalated' }));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Decide case' })).toBeNull();
    expect(screen.getByText(/Admins decide escalated cases/)).toBeInTheDocument();
  });

  it('cannot decide a case that is under appeal', async () => {
    view('moderator', makeCase({ state: 'appealed' }));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Decide case' })).toBeNull();
  });

  it('only offers release to the assignee', async () => {
    view('moderator', makeCase({ assignedTo: OTHER_STAFF }));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Release case' })).toBeNull();
  });
});

describe('case detail as other roles', () => {
  it("offers admins the ban decision and the ability to release someone else's claim", async () => {
    view('admin', makeCase({ assignedTo: OTHER_STAFF }));
    expect(await screen.findByRole('button', { name: 'Release case' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Decide case' }));
    expect(
      within(screen.getByRole('dialog'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('Ban account');
  });

  it('gives support a read-only view from the read-only endpoint, without actions', async () => {
    const api = view('support');
    await screen.findByRole('heading', { level: 1 });
    expect(api.caseReadOnly).toHaveBeenCalled();
    expect(api.case).not.toHaveBeenCalled();
    expect(screen.getByText(/can read this case but not act on it/)).toBeInTheDocument();
    for (const name of ['Claim case', 'Decide case', 'Escalate to admins'])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('shows a clear error with the request id when the API refuses', async () => {
    renderAsStaff(<CaseDetailView id={CASE_ID} />, {
      role: 'moderator',
      client: fakeClient({
        admin: {
          moderation: {
            case: vi
              .fn()
              .mockRejectedValue(new ApiError('not_found', 'Case not found', 404, 'req-nf-1')),
          },
        },
      }),
    });
    expect(await screen.findByText('Case not found')).toBeInTheDocument();
    expect(screen.getByText('req-nf-1')).toBeInTheDocument();
  });
});

describe('case detail: appeals', () => {
  it('lets a moderator review an open appeal and warns when they made the original decision', async () => {
    const appeal = {
      id: '77777777-2222-4333-8444-555555555555',
      userId: null,
      status: 'open' as const,
      statement: 'I did not post that',
      reviewerId: null,
      reviewerNote: null,
      originalDeciderId: ME,
      createdAt: '2026-09-21T00:00:00.000Z',
      decidedAt: null,
    };
    const api = view('moderator', makeCase({ state: 'appealed', appeals: [appeal] }));
    await userEvent.click(await screen.findByRole('button', { name: 'Review appeal' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('I did not post that')).toBeInTheDocument();
    expect(within(dialog).getByText(/You made the original decision/)).toBeInTheDocument();
    expect(api.reviewAppeal).not.toHaveBeenCalled();
  });
});
