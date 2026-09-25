import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { ProductsListView } from './ProductsListView';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    kind: 'physical',
    title: 'Handmade mug',
    description: '',
    priceCents: 2500,
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

describe('ProductsListView', () => {
  it('shows a spinner while loading', () => {
    const client = fakeClient({
      commerce: { products: vi.fn(() => new Promise(() => {})) },
    });
    renderWithProviders(<ProductsListView />, { client });
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('shows an empty state with no results', async () => {
    const client = fakeClient({
      commerce: { products: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
    });
    renderWithProviders(<ProductsListView />, { client });
    await waitFor(() => expect(screen.getByText('No products found')).toBeInTheDocument());
  });

  it('shows a retryable error on failure', async () => {
    const client = fakeClient({
      commerce: { products: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    renderWithProviders(<ProductsListView />, { client });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument(),
    );
  });

  it('renders products once loaded', async () => {
    const client = fakeClient({
      commerce: {
        products: vi.fn().mockResolvedValue({ items: [product()], nextCursor: null }),
      },
    });
    renderWithProviders(<ProductsListView />, { client });
    await waitFor(() => expect(screen.getByText('Handmade mug')).toBeInTheDocument());
    expect(screen.getByText('Ada Seller', { exact: false })).toBeInTheDocument();
  });
});
