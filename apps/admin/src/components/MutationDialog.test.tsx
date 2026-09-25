import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@yapilapi/api-client';
import { renderAsStaff } from '@/test-utils';
import { MutationDialog } from './common';

function setup(props: Partial<Parameters<typeof MutationDialog<{ ok: true }>>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue({ ok: true });
  const onClose = vi.fn();
  const onDone = vi.fn();
  renderAsStaff(
    <MutationDialog<{ ok: true }>
      open
      onClose={onClose}
      title="Suspend ada"
      submitLabel="Suspend account"
      reasonLabel="Reason"
      tone="danger"
      onSubmit={onSubmit}
      successMessage="Done"
      onDone={onDone}
      {...props}
    />,
  );
  return { onSubmit, onClose, onDone, user: userEvent.setup() };
}

describe('MutationDialog (every destructive action goes through it)', () => {
  it('is an accessible modal with a labelled reason field', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Suspend ada' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason/)).toBeRequired();
  });

  it('keeps the action disabled until a reason of at least 3 characters is given', async () => {
    const { user } = setup();
    const submit = screen.getByRole('button', { name: 'Suspend account' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'ab');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'c');
    expect(submit).toBeEnabled();
  });

  it('for destructive actions also needs the phrase typed exactly', async () => {
    const { user, onSubmit } = setup({ confirmPhrase: 'ada' });
    await user.type(screen.getByLabelText(/Reason/), 'Repeated harassment');
    const submit = screen.getByRole('button', { name: 'Suspend account' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Type "ada" to confirm/), 'ad');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Type "ada" to confirm/), 'a');
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('Repeated harassment');
  });

  it('honours an extra validity gate from the caller', async () => {
    const { user } = setup({ valid: false });
    await user.type(screen.getByLabelText(/Reason/), 'A good reason');
    expect(screen.getByRole('button', { name: 'Suspend account' })).toBeDisabled();
  });

  it('closes and reports success only after the server accepted it', async () => {
    const { user, onClose, onDone } = setup();
    await user.type(screen.getByLabelText(/Reason/), 'A good reason');
    await user.click(screen.getByRole('button', { name: 'Suspend account' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalledWith({ ok: true });
    expect(await screen.findByText('Done')).toBeInTheDocument();
  });

  it('stays open and shows the API message with its request id when the server refuses', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new ApiError('forbidden', 'Only admins can ban accounts', 403, 'req-abc-123'),
      );
    const { user, onClose, onDone } = setup({ onSubmit });
    await user.type(screen.getByLabelText(/Reason/), 'A good reason');
    await user.click(screen.getByRole('button', { name: 'Suspend account' }));
    const dialog = screen.getByRole('dialog');
    const alert = (await within(dialog).findByText(/Only admins can ban accounts/)).closest(
      '[role="alert"]',
    );
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent('req-abc-123');
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('can be cancelled with the keyboard without calling the API', async () => {
    const { user, onSubmit, onClose } = setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('makes an optional reason optional (no minimum)', async () => {
    setup({ reasonOptional: true });
    expect(screen.getByRole('button', { name: 'Suspend account' })).toBeEnabled();
  });

  it('does not double submit', async () => {
    let release: (v: { ok: true }) => void = () => undefined;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const { user } = setup({ onSubmit });
    await user.type(screen.getByLabelText(/Reason/), 'A good reason');
    await user.click(screen.getByRole('button', { name: 'Suspend account' }));
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    release({ ok: true });
  });
});
