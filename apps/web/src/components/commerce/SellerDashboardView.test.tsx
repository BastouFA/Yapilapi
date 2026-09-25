import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeClient, renderWithProviders } from './test-utils';
import { SellerDashboardView } from './SellerDashboardView';

describe('SellerDashboardView', () => {
  it('shows the products tab with an empty list by default', async () => {
    const client = fakeClient({
      commerce: {
        myProducts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        create: vi.fn(),
      },
    });
    renderWithProviders(<SellerDashboardView />, { client });
    await waitFor(() => expect(screen.getByText('New product')).toBeInTheDocument());
  });

  it('creates a product from the form', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1' });
    const client = fakeClient({
      commerce: {
        myProducts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        create,
      },
    });
    renderWithProviders(<SellerDashboardView />, { client });
    await waitFor(() => expect(screen.getByText('New product')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Title'), 'Handmade mug');
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ kind: 'physical', title: 'Handmade mug' });
  });

  it('shows a retryable error when the balance fails to load', async () => {
    const client = fakeClient({
      commerce: { myProducts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
      payments: {
        balance: vi.fn().mockRejectedValue(new Error('boom')),
        payoutAccount: vi.fn().mockResolvedValue({ account: null }),
        payouts: vi.fn().mockResolvedValue({ items: [] }),
      },
    });
    renderWithProviders(<SellerDashboardView />, { client });
    await userEvent.click(screen.getByRole('tab', { name: 'Payouts' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument(),
    );
  });
});
