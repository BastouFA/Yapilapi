import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryAiDraft, MemoryView } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { MemoryDetailView } from './MemoryDetailView';

function memory(overrides: Partial<MemoryView> = {}): MemoryView {
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
    items: [],
    itemCount: 0,
    links: [],
    ...overrides,
  };
}

function draft(overrides: Partial<MemoryAiDraft> = {}): MemoryAiDraft {
  return {
    id: 'd1',
    memoryId: 'mem1',
    kind: 'title',
    payload: { text: 'A great summer trip' },
    provider: 'dev',
    model: 'dev',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('MemoryDetailView', () => {
  it('adds an item to the memory', async () => {
    const addItems = vi.fn().mockResolvedValue({ added: 1 });
    const client = fakeClient({
      memory: { get: vi.fn().mockResolvedValue(memory()), addItems },
    });
    renderWithProviders(<MemoryDetailView id="mem1" />, { client });

    await waitFor(() =>
      expect(screen.getByText('No items in this memory yet.')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Item ID'), { target: { value: 'post1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));

    await waitFor(() =>
      expect(addItems).toHaveBeenCalledWith('mem1', [{ type: 'post', id: 'post1' }]),
    );
  });

  it('applies an AI draft only through the explicit confirmation dialog, never automatically', async () => {
    const confirmAiDraft = vi.fn().mockResolvedValue(memory({ title: 'A great summer trip' }));
    const client = fakeClient({
      memory: {
        get: vi.fn().mockResolvedValue(memory()),
        aiDrafts: vi.fn().mockResolvedValue({ items: [draft()] }),
        confirmAiDraft,
      },
    });
    renderWithProviders(<MemoryDetailView id="mem1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'AI drafts' }));
    await waitFor(() => expect(screen.getByText('A great summer trip')).toBeInTheDocument());
    expect(confirmAiDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    expect(confirmAiDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm and apply' })[1]!);
    await waitFor(() => expect(confirmAiDraft).toHaveBeenCalledWith('mem1', 'd1', undefined));
  });

  it('deletes the memory only through the explicit confirmation dialog', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      memory: { get: vi.fn().mockResolvedValue(memory()), remove },
    });
    renderWithProviders(<MemoryDetailView id="mem1" />, { client });

    await waitFor(() => expect(screen.getByText('Summer trip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete memory' })[1]!);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('mem1'));
  });
});
