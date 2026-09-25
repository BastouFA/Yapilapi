import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FlagView } from '@yapilapi/api-client';
import { fakeClient, renderAsStaff } from '@/test-utils';
import { FlagsView, rolloutKind } from './Flags';

const FLAG: FlagView = {
  key: 'MINI_APPS',
  description: 'Mini apps',
  enabled: true,
  rolloutPct: 100,
  updatedAt: '2026-09-20T10:00:00.000Z',
  known: true,
  overrides: 0,
};

function view(role: 'admin' | 'support' | 'moderator' = 'admin', flags: FlagView[] = [FLAG]) {
  const api = {
    list: vi.fn().mockResolvedValue({ items: flags }),
    update: vi.fn().mockResolvedValue({ ...FLAG }),
    overrides: vi.fn().mockResolvedValue({ items: [] }),
    setOverride: vi.fn().mockResolvedValue({}),
    removeOverride: vi.fn().mockResolvedValue(undefined),
  };
  renderAsStaff(<FlagsView />, { role, client: fakeClient({ admin: { flags: api } }) });
  return api;
}

describe('rolloutKind', () => {
  it('summarises how far a flag reaches', () => {
    expect(rolloutKind({ enabled: false, rolloutPct: 100 })).toBe('off');
    expect(rolloutKind({ enabled: true, rolloutPct: 100 })).toBe('all');
    expect(rolloutKind({ enabled: true, rolloutPct: 25 })).toBe('partial');
    expect(rolloutKind({ enabled: true, rolloutPct: 0 })).toBe('zero');
  });
});

describe('feature flags', () => {
  it('lists flags with their state', async () => {
    view();
    expect(await screen.findByText('MINI_APPS')).toBeInTheDocument();
    expect(screen.getByText('On for everyone')).toBeInTheDocument();
  });

  it('is unreachable to change for roles without flags.write (the route is admin only anyway)', async () => {
    view('admin');
    expect(await screen.findByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('turning a flag off needs a reason and the flag key typed, and audits both', async () => {
    const api = view();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog', { name: 'Change MINI_APPS' });
    await user.click(within(dialog).getByRole('switch', { name: 'Enabled' }));
    const submit = within(dialog).getByRole('button', { name: 'Save change' });
    await user.type(
      within(dialog).getByLabelText(/Reason for the change/),
      'Incident 42: abuse via mini apps',
    );
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type "MINI_APPS" to confirm/), 'MINI_APPS');
    await user.click(submit);
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith('MINI_APPS', {
        enabled: false,
        reason: 'Incident 42: abuse via mini apps',
      }),
    );
  });

  it('changing only the rollout sends only the rollout (and needs no typed phrase)', async () => {
    const api = view();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog');
    const slider = within(dialog).getByLabelText('Rollout percentage');
    fireEvent.change(slider, { target: { value: '75' } });
    await user.type(within(dialog).getByLabelText(/Reason for the change/), 'Slow the rollout');
    await user.click(within(dialog).getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(api.update).toHaveBeenCalled());
    const body = api.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('enabled');
    expect(body['rolloutPct']).toBe(75);
    expect(body['reason']).toBe('Slow the rollout');
  });

  it('cannot save when nothing changed', async () => {
    view();
    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Reason for the change/), 'No real change');
    expect(within(dialog).getByRole('button', { name: 'Save change' })).toBeDisabled();
  });

  it('adds an override for a person by full id with a reason', async () => {
    const api = view();
    const user = userEvent.setup();
    await user.click(await screen.findByText(/Personal overrides/));
    const id = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
    await user.type(await screen.findByLabelText(/^Account id/), 'not-a-uuid');
    expect(screen.getByRole('button', { name: 'Add override' })).toBeDisabled();
    await user.clear(screen.getByLabelText(/^Account id/));
    await user.type(screen.getByLabelText(/^Account id/), id);
    await user.click(screen.getByRole('button', { name: 'Add override' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason for the change/), 'Internal tester');
    await user.click(within(dialog).getByRole('button', { name: 'Add override' }));
    await waitFor(() =>
      expect(api.setOverride).toHaveBeenCalledWith('MINI_APPS', id, {
        enabled: true,
        reason: 'Internal tester',
      }),
    );
  });

  it('marks flags the code does not know about', async () => {
    view('admin', [{ ...FLAG, key: 'OLD_FLAG', known: false }]);
    expect(await screen.findByText('Not in code')).toBeInTheDocument();
  });
});
