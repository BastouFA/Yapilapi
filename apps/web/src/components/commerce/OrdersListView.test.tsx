import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Order } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { OrdersListView } from './OrdersListView';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    status: 'paid',
    currency: 'USD',
    subtotalCents: 2500,
    shippingCents: 0,
    taxCents: 0,
    totalCents: 2500,
    refundedCents: 0,
    items: [],
    tracking: null,
    seller: { type: 'user', id: 'u1' },
    payment: null,
    reservedUntil: null,
    heldForReview: false,
    cancelReason: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
    fulfilledAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe('OrdersListView', () => {
  it('shows a spinner while loading', () => {
    const client = fakeClient({ commerce: { orders: vi.fn(() => new Promise(() => {})) } });
    renderWithProviders(<OrdersListView />, { client });
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('shows an empty state with no orders', async () => {
    const client = fakeClient({
      commerce: { orders: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
    });
    renderWithProviders(<OrdersListView />, { client });
    await waitFor(() => expect(screen.getByText('No orders yet')).toBeInTheDocument());
  });

  it('shows a retryable error on failure', async () => {
    const client = fakeClient({
      commerce: { orders: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    renderWithProviders(<OrdersListView />, { client });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument(),
    );
  });

  it('lists orders with their status', async () => {
    const client = fakeClient({
      commerce: { orders: vi.fn().mockResolvedValue({ items: [order()], nextCursor: null }) },
    });
    renderWithProviders(<OrdersListView />, { client });
    await waitFor(() => expect(screen.getByText('Paid')).toBeInTheDocument());
  });
});
