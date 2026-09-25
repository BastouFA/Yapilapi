import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeClient, renderWithProviders } from './test-utils';
import { MemoriesView } from './MemoriesView';

describe('MemoriesView', () => {
  it('shows an empty state with no memories', async () => {
    const client = fakeClient({
      ai: {
        memories: vi.fn().mockResolvedValue({
          items: [],
          enabled: true,
          consented: true,
          howItWorks: 'How it works.',
        }),
      },
    });
    renderWithProviders(<MemoriesView />, { client });
    await waitFor(() => expect(screen.getByText('Nothing is remembered yet.')).toBeInTheDocument());
  });

  it('lists memories and deletes one after confirming', async () => {
    const deleteMemory = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      ai: {
        memories: vi.fn().mockResolvedValue({
          items: [
            {
              id: 'm1',
              content: 'Likes hiking',
              source: 'user_stated',
              sourceRef: null,
              useCount: 2,
              lastUsedAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
          enabled: true,
          consented: true,
          howItWorks: 'How it works.',
        }),
        deleteMemory,
      },
    });
    renderWithProviders(<MemoriesView />, { client });

    await waitFor(() => expect(screen.getByText('Likes hiking')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);

    await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith('m1'));
  });

  it('shows a notice when memory consent has not been given', async () => {
    const client = fakeClient({
      ai: {
        memories: vi.fn().mockResolvedValue({
          items: [],
          enabled: true,
          consented: false,
          howItWorks: 'How it works.',
        }),
      },
    });
    renderWithProviders(<MemoriesView />, { client });
    await waitFor(() =>
      expect(
        screen.getByText('Turn on AI memory consent in Privacy to use this.'),
      ).toBeInTheDocument(),
    );
  });
});
