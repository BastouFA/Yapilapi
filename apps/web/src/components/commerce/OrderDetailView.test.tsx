import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Order } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { OrderDetailView } from './OrderDetailView';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    status: 'pending_payment',
    currency: 'USD',
    subtotalCents: 2500,
    shippingCents: 0,
    taxCents: 0,
    totalCents: 2500,
    refundedCents: 0,
    items: [
      {
        id: 'i1',
        type: 'product',
        kind: 'physical',
        productId: 'p1',
        ticketTypeId: null,
        eventId: null,
        bookingId: null,
        title: 'Mug',
        quantity: 1,
        unitPriceCents: 2500,
        lineTotalCents: 2500,
        taxCents: 0,
        refundedCents: 0,
        entitlement: null,
      },
    ],
    tracking: null,
    seller: { type: 'user', id: 'u2' },
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

describe('OrderDetailView', () => {
  it('shows a spinner while loading', () => {
    const client = fakeClient({ commerce: { getOrder: vi.fn(() => new Promise(() => {})) } });
    renderWithProviders(<OrderDetailView id="o1" />, { client });
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('shows a not-found state for a 404', async () => {
    const client = fakeClient({
      commerce: { getOrder: vi.fn().mockRejectedValue(new ApiError('not_found', 'nope', 404)) },
    });
    renderWithProviders(<OrderDetailView id="o1" />, { client });
    await waitFor(() => expect(screen.getByText('Order not found')).toBeInTheDocument());
  });

  it('shows a retryable error on an unexpected failure', async () => {
    const client = fakeClient({
      commerce: { getOrder: vi.fn().mockRejectedValue(new ApiError('internal', 'boom', 500)) },
    });
    renderWithProviders(<OrderDetailView id="o1" />, { client });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument(),
    );
  });

  it('lets the buyer retry payment on an unpaid order with a dev token', async () => {
    const client = fakeClient({
      commerce: { getOrder: vi.fn().mockResolvedValue(order()) },
      payments: {
        pay: vi
          .fn()
          .mockResolvedValue({ payment: { status: 'captured' }, nextAction: null, order: {} }),
      },
    });
    renderWithProviders(<OrderDetailView id="o1" />, { client });
    await waitFor(() => expect(screen.getByText('Awaiting payment')).toBeInTheDocument());
    expect(screen.getByLabelText('Payment method')).toBeInTheDocument();
    expect(screen.queryByLabelText(/card number/i)).not.toBeInTheDocument();
  });

  it('shows seller-only actions (fulfil, refund decisions) for the seller view', async () => {
    const client = fakeClient({
      commerce: {
        getOrder: vi.fn().mockResolvedValue(
          order({
            status: 'paid',
            buyer: { id: 'u1', username: 'ada', displayName: 'Ada Buyer' },
          }),
        ),
      },
      payments: { orderRefunds: vi.fn().mockResolvedValue({ items: [] }) },
    });
    renderWithProviders(<OrderDetailView id="o1" />, { client });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Mark as shipped / delivered' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Buyer: Ada Buyer')).toBeInTheDocument();
    // Sellers see decisions on refund requests, not a request form of their own.
    expect(screen.queryByText('Request a refund')).not.toBeInTheDocument();
  });
});
