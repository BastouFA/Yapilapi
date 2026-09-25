import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LiveSession } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { SessionsListView } from './SessionsListView';

function session(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    id: 'sess1',
    hostId: 'host1',
    host: { id: 'host1', username: 'alice', displayName: 'Alice' },
    title: 'My live show',
    description: '',
    status: 'live',
    visibility: 'public',
    mediaMode: 'interactive',
    scheduledFor: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    language: null,
    viewerCount: 3,
    peakViewers: 5,
    chatEnabled: true,
    slowModeSec: 0,
    ticket: { required: false },
    video: null,
    hasRecording: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SessionsListView', () => {
  it('lists live sessions', async () => {
    const client = fakeClient({
      live: { list: vi.fn().mockResolvedValue({ items: [session()] }) },
    });
    renderWithProviders(<SessionsListView />, { client });
    await waitFor(() => expect(screen.getByText('My live show')).toBeInTheDocument());
  });

  it('creates a new session from the "My sessions" tab', async () => {
    const create = vi.fn().mockResolvedValue(session());
    const mine = vi.fn().mockResolvedValue({ items: [] });
    const client = fakeClient({
      live: { list: vi.fn().mockResolvedValue({ items: [] }), mine, create },
    });
    renderWithProviders(<SessionsListView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'My sessions' }));
    await waitFor(() => expect(screen.getByText('Schedule a session')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A new show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        title: 'A new show',
        description: undefined,
        visibility: 'followers',
        mediaMode: 'interactive',
        scheduledFor: undefined,
      }),
    );
  });
});
