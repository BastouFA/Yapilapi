import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Product } from '@yapilapi/api-client';
import { routerMock } from '@/test-router';
import { fakeClient, renderWithProviders } from './test-utils';
import { ProductDetailView } from './ProductDetailView';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    kind: 'physical',
    title: 'Handmade mug',
    description: 'A nice mug.',
    priceCents: 2500,
    currency: 'USD',
    taxBps: 0,
    inStock: true,
    stock: 4,
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

describe('ProductDetailView', () => {
  it('shows a spinner while loading', () => {
    const client = fakeClient({
      commerce: { get: vi.fn(() => new Promise(() => {})) },
    });
    renderWithProviders(<ProductDetailView id="p1" />, { client });
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('shows a not-found state for a 404', async () => {
    const client = fakeClient({
      commerce: {
        get: vi.fn().mockRejectedValue(new ApiError('not_found', 'nope', 404)),
        reviews: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      },
    });
    renderWithProviders(<ProductDetailView id="p1" />, { client });
    await waitFor(() => expect(screen.getByText('Product not found')).toBeInTheDocument());
  });

  it('shows a retryable error on an unexpected failure', async () => {
    const client = fakeClient({
      commerce: { get: vi.fn().mockRejectedValue(new ApiError('internal', 'boom', 500)) },
    });
    renderWithProviders(<ProductDetailView id="p1" />, { client });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument(),
    );
  });

  it('renders the product and navigates to checkout on Buy now', async () => {
    const client = fakeClient({
      commerce: {
        get: vi.fn().mockResolvedValue(product()),
        reviews: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      },
    });
    renderWithProviders(<ProductDetailView id="p1" />, { client });
    await waitFor(() => expect(screen.getByText('Handmade mug')).toBeInTheDocument());
    screen.getByRole('button', { name: 'Buy now' }).click();
    expect(routerMock.push).toHaveBeenCalledWith('/shop/checkout/p1');
  });

  it('hides Buy now for the product’s own seller', async () => {
    const client = fakeClient({
      commerce: {
        get: vi
          .fn()
          .mockResolvedValue(product({ viewer: { isSeller: true, hasPurchased: false } })),
        reviews: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      },
    });
    renderWithProviders(<ProductDetailView id="p1" />, { client });
    await waitFor(() => expect(screen.getByText('Handmade mug')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Buy now' })).not.toBeInTheDocument();
  });
});
