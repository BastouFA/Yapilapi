import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TogetherExperienceView, TogetherMember } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { TogetherDetailView } from './TogetherDetailView';

function experience(overrides: Partial<TogetherExperienceView> = {}): TogetherExperienceView {
  return {
    id: 'exp1',
    title: 'Beach day',
    description: 'A day at the beach',
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
    cover: null,
    ...overrides,
  };
}

function member(overrides: Partial<TogetherMember> = {}): TogetherMember {
  return {
    user: { id: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null },
    role: 'contributor',
    status: 'joined',
    joinedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TogetherDetailView', () => {
  it('invites a member', async () => {
    const invite = vi.fn().mockResolvedValue({ status: 'invited' });
    const client = fakeClient({
      together: {
        get: vi.fn().mockResolvedValue(experience()),
        timeline: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        members: vi.fn().mockResolvedValue({ items: [member()] }),
        suggestedInvites: vi.fn().mockResolvedValue({ suggestions: [], reason: null }),
        invite,
      },
    });
    renderWithProviders(<TogetherDetailView id="exp1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Members' }));
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Friend ID to invite'), { target: { value: 'u9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(invite).toHaveBeenCalledWith('exp1', 'u9', 'contributor'));
  });

  it('adds a contribution to the timeline', async () => {
    const addContribution = vi.fn().mockResolvedValue({
      id: 'c1',
      contributor: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null },
      text: 'It was great',
      media: null,
      real: null,
      takenAt: new Date().toISOString(),
      addedAt: new Date().toISOString(),
      mine: true,
    });
    const client = fakeClient({
      together: {
        get: vi.fn().mockResolvedValue(experience()),
        timeline: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        addContribution,
      },
    });
    renderWithProviders(<TogetherDetailView id="exp1" />, { client });

    await waitFor(() => expect(screen.getByText('Add my perspective')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('What was it like for you? (optional)'), {
      target: { value: 'It was great' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(addContribution).toHaveBeenCalledWith('exp1', {
        body: 'It was great',
        mediaId: undefined,
        realCaptureId: undefined,
      }),
    );
  });

  it('leaves only after confirming the dialog', async () => {
    const leave = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      together: {
        get: vi.fn().mockResolvedValue(
          experience({
            viewer: {
              membership: 'joined',
              role: 'contributor',
              isOwner: false,
              canContribute: true,
              showOnProfile: false,
            },
          }),
        ),
        timeline: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        leave,
      },
    });
    renderWithProviders(<TogetherDetailView id="exp1" />, { client });

    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    expect(leave).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith('exp1', false));
  });

  it('deletes only after confirming the dialog', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      together: {
        get: vi.fn().mockResolvedValue(experience()),
        timeline: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        remove,
      },
    });
    renderWithProviders(<TogetherDetailView id="exp1" />, { client });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('exp1'));
  });
});
