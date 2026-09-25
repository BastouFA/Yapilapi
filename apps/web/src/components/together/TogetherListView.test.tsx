import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TogetherExperience } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { TogetherListView } from './TogetherListView';

function experience(overrides: Partial<TogetherExperience> = {}): TogetherExperience {
  return {
    id: 'exp1',
    title: 'Beach day',
    description: '',
    owner: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null },
    eventId: null,
    placeId: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    visibility: 'private',
    counts: { members: 2, contributions: 1 },
    viewer: {
      membership: 'joined',
      role: 'owner',
      isOwner: true,
      canContribute: true,
      showOnProfile: false,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TogetherListView', () => {
  it('lists joined shared experiences', async () => {
    const client = fakeClient({
      together: {
        mine: vi.fn().mockResolvedValue({ items: [experience()], nextCursor: null }),
      },
    });
    renderWithProviders(<TogetherListView />, { client });
    await waitFor(() => expect(screen.getByText('Beach day')).toBeInTheDocument());
  });

  it('creates a new shared experience', async () => {
    const create = vi.fn().mockResolvedValue(experience());
    const client = fakeClient({
      together: {
        mine: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        create,
      },
    });
    renderWithProviders(<TogetherListView />, { client });

    await waitFor(() => expect(screen.getByText('Start a shared experience')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Road trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        title: 'Road trip',
        description: '',
        visibility: 'private',
      }),
    );
  });

  it('accepts an invitation from the invited tab', async () => {
    const accept = vi.fn().mockResolvedValue(experience());
    const invited = experience({
      id: 'exp2',
      title: 'Camping trip',
      viewer: {
        membership: 'invited',
        role: 'contributor',
        isOwner: false,
        canContribute: true,
        showOnProfile: false,
      },
    });
    const client = fakeClient({
      together: {
        mine: vi
          .fn()
          .mockImplementation(({ membership }: { membership: string }) =>
            Promise.resolve({ items: membership === 'invited' ? [invited] : [], nextCursor: null }),
          ),
        accept,
      },
    });
    renderWithProviders(<TogetherListView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Invited' }));
    await waitFor(() => expect(screen.getByText('Camping trip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith('exp2'));
  });

  it('declines an invitation only after confirming the dialog', async () => {
    const decline = vi.fn().mockResolvedValue(undefined);
    const invited = experience({
      id: 'exp3',
      title: 'Museum visit',
      viewer: {
        membership: 'invited',
        role: 'contributor',
        isOwner: false,
        canContribute: true,
        showOnProfile: false,
      },
    });
    const client = fakeClient({
      together: {
        mine: vi
          .fn()
          .mockImplementation(({ membership }: { membership: string }) =>
            Promise.resolve({ items: membership === 'invited' ? [invited] : [], nextCursor: null }),
          ),
        decline,
      },
    });
    renderWithProviders(<TogetherListView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Invited' }));
    await waitFor(() => expect(screen.getByText('Museum visit')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(decline).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(decline).toHaveBeenCalledWith('exp3'));
  });
});
