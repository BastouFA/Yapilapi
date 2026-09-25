import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemorySummary } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { MemoriesListView } from './MemoriesListView';

function memory(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem1',
    owner: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null },
    kind: 'collection',
    title: 'Summer trip',
    summary: '',
    dateStart: null,
    dateEnd: null,
    privacy: 'private',
    aiGenerated: false,
    aiProvenance: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viewer: { isOwner: true },
    itemCount: 3,
    ...overrides,
  };
}

describe('MemoriesListView', () => {
  it('lists my memories', async () => {
    const client = fakeClient({
      memory: { list: vi.fn().mockResolvedValue({ items: [memory()], nextCursor: null }) },
    });
    renderWithProviders(<MemoriesListView />, { client });
    await waitFor(() => expect(screen.getByText('Summer trip')).toBeInTheDocument());
  });

  it('creates a new memory', async () => {
    const create = vi.fn().mockResolvedValue(memory());
    const client = fakeClient({
      memory: {
        list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        create,
      },
    });
    renderWithProviders(<MemoriesListView />, { client });

    await waitFor(() => expect(screen.getByText('New memory')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Weekend hike' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        title: 'Weekend hike',
        summary: '',
        privacy: 'private',
      }),
    );
  });
});
