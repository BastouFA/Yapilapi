import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Product } from '@yapilapi/api-client';
import { routerMock } from '@/test-router';
import { fakeClient, renderWithProviders } from './test-utils';
import { CheckoutView } from './CheckoutView';

function service(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    kind: 'service',
    title: 'Portrait sitting',
    description: '',
    priceCents: 5000,
    currency: 'USD',
    taxBps: 0,
    inStock: true,
    delivery: { methods: [], estimateDays: null, shippingCents: 0 },
    returnsPolicy: '',
    status: 'active',
    rating: { average: 0, count: 0 },
    seller: { type: 'user', id: 'u1', name: 'Ada Seller' },
    media: [],
    createdAt: new Date().toISOString(),
    viewer: { isSeller: false, hasPurchased: false },
    ...overrides,
  };
}

describe('CheckoutView', () => {
  it('creates the order, pays with the chosen dev token, and moves to the order page', async () => {
    const createOrder = vi.fn().mockResolvedValue({
      order: { id: 'o1' },
      held: false,
      replayed: false,
    });
    const pay = vi.fn().mockResolvedValue({
      payment: { id: 'pay1', status: 'captured' },
      nextAction: null,
      order: { id: 'o1' },
    });
    const client = fakeClient({
      commerce: { get: vi.fn().mockResolvedValue(service()), createOrder },
      payments: { pay },
    });
    renderWithProviders(<CheckoutView productId="p1" />, { client });

    await waitFor(() => expect(screen.getByText(/Portrait sitting/)).toBeInTheDocument());

    // A service product never asks for a raw card field — only a payment-method token select.
    expect(screen.queryByLabelText(/card number/i)).not.toBeInTheDocument();
    const select = screen.getByLabelText('Payment method');
    await userEvent.selectOptions(select, 'tok_success');

    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    expect(createOrder).toHaveBeenCalledWith({ items: [{ productId: 'p1', quantity: 1 }] });
    await waitFor(() => expect(pay).toHaveBeenCalledWith('o1', { paymentMethod: 'tok_success' }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/shop/orders/o1'));
  });

  it('shows the decline message when the dev provider declines the token', async () => {
    const client = fakeClient({
      commerce: {
        get: vi.fn().mockResolvedValue(service()),
        createOrder: vi
          .fn()
          .mockResolvedValue({ order: { id: 'o1' }, held: false, replayed: false }),
      },
      payments: {
        pay: vi.fn().mockRejectedValue(new ApiError('payment_failed', 'declined', 402)),
      },
    });
    renderWithProviders(<CheckoutView productId="p1" />, { client });
    await waitFor(() => expect(screen.getByText(/Portrait sitting/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() =>
      expect(
        screen.getByText('Your payment was declined. Try another payment method.'),
      ).toBeInTheDocument(),
    );
  });
});
