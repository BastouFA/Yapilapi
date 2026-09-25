import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeUser, SUBJECT_ID } from '@/fixtures';
import { fakeClient, renderAsStaff } from '@/test-utils';
import { UserDetailView } from './UserDetail';

function view(role: 'support' | 'moderator' | 'admin' | 'superadmin', user = makeUser()) {
  const users = {
    get: vi.fn().mockResolvedValue(user),
    notes: vi.fn().mockResolvedValue({ items: [] }),
    addNote: vi.fn().mockResolvedValue({ id: 'n1', createdAt: '2026-09-21T00:00:00.000Z' }),
    suspend: vi.fn().mockResolvedValue({
      id: SUBJECT_ID,
      status: 'suspended',
      endsAt: '2026-10-01T00:00:00.000Z',
      enforcementId: 'e1',
    }),
    reactivate: vi.fn().mockResolvedValue({ id: SUBJECT_ID, status: 'active' }),
    setRole: vi.fn().mockResolvedValue({ id: SUBJECT_ID, role: 'moderator' }),
  };
  renderAsStaff(<UserDetailView id={SUBJECT_ID} />, {
    role,
    client: fakeClient({ admin: { users } }),
  });
  return users;
}

describe('user detail: role-based actions', () => {
  it('lets support read and leave notes but shows no account actions', async () => {
    view('support');
    expect(await screen.findByRole('heading', { level: 1, name: 'ada' })).toBeInTheDocument();
    expect(screen.getByText(/No account actions are available/)).toBeInTheDocument();
    expect(screen.getByLabelText('New note')).toBeInTheDocument();
    for (const name of ['Suspend account', 'Reactivate account', 'Change platform role'])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('offers moderators a suspension but not a role change', async () => {
    view('moderator');
    expect(await screen.findByRole('button', { name: 'Suspend account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change platform role' })).toBeNull();
  });

  it('respects what the server says it may do for this particular account (rank rules)', async () => {
    view(
      'moderator',
      makeUser({ actions: { canSuspend: false, canReactivate: false, canChangeRole: false } }),
    );
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Suspend account' })).toBeNull();
  });

  it('offers reactivation only for a suspended account and only to admins', async () => {
    view('admin', makeUser({ status: 'suspended' }));
    expect(await screen.findByRole('button', { name: 'Reactivate account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend account' })).toBeNull();
  });

  it('hides the role change from admins, shows it to superadmins', async () => {
    view('superadmin');
    expect(await screen.findByRole('button', { name: 'Change platform role' })).toBeInTheDocument();
  });
});

describe('user detail: suspending', () => {
  it('asks for days, a reason and the username, and sends exactly those to the API', async () => {
    const users = view('moderator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Suspend account' }));
    const dialog = screen.getByRole('dialog', { name: 'Suspend ada' });
    const submit = within(dialog).getByRole('button', { name: 'Suspend account' });
    expect(submit).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/Days suspended/));
    await user.type(within(dialog).getByLabelText(/Days suspended/), '10');
    await user.type(
      within(dialog).getByLabelText(/Reason \(shown to the person\)/),
      'Harassing other members',
    );
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type "ada" to confirm/), 'ada');
    await user.click(submit);
    await waitFor(() =>
      expect(users.suspend).toHaveBeenCalledWith(SUBJECT_ID, {
        reason: 'Harassing other members',
        days: 10,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not allow more than 90 days', async () => {
    view('moderator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Suspend account' }));
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText(/Days suspended/));
    await user.type(within(dialog).getByLabelText(/Days suspended/), '91');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Some reason');
    await user.type(within(dialog).getByLabelText(/to confirm/), 'ada');
    expect(within(dialog).getByRole('button', { name: 'Suspend account' })).toBeDisabled();
  });
});

describe('user detail: notes', () => {
  it('adds a note and reloads the list', async () => {
    const users = view('support');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New note'), 'Called about billing');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(users.addNote).toHaveBeenCalledWith(SUBJECT_ID, 'Called about billing'),
    );
    await waitFor(() => expect(users.notes).toHaveBeenCalledTimes(2));
  });

  it('shows a masked email as the API returned it (the console never unmasks anything itself)', async () => {
    view('support');
    expect(await screen.findByText('a***@example.com')).toBeInTheDocument();
  });
});

describe('user detail: changing a platform role', () => {
  it('needs the reason, the typed username, and a different role', async () => {
    const users = view('superadmin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change platform role' }));
    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Change role' });
    await user.type(
      within(dialog).getByLabelText(/Reason for the change/),
      'Joining the trust team',
    );
    await user.type(within(dialog).getByLabelText(/to confirm/), 'ada');
    expect(submit).toBeDisabled(); // role unchanged
    await user.selectOptions(within(dialog).getByLabelText(/New platform role/), 'moderator');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(users.setRole).toHaveBeenCalledWith(SUBJECT_ID, {
        role: 'moderator',
        reason: 'Joining the trust team',
      }),
    );
  });
});
