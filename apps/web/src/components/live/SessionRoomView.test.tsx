import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LiveMessage, LivePoll, LiveSession } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { SessionRoomView } from './SessionRoomView';

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
    viewerRole: 'host',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function message(overrides: Partial<LiveMessage> = {}): LiveMessage {
  return {
    id: 'm1',
    userId: 'u1',
    author: { username: 'bob', displayName: 'Bob' },
    kind: 'text',
    body: 'hello',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function poll(overrides: Partial<LivePoll> = {}): LivePoll {
  return {
    id: 'p1',
    question: 'Favorite color?',
    multiple: false,
    status: 'open',
    options: [
      { id: 'o1', label: 'Red', votes: 1 },
      { id: 'o2', label: 'Blue', votes: 0 },
    ],
    voters: 1,
    myVotes: [],
    createdAt: new Date().toISOString(),
    closedAt: null,
    ...overrides,
  };
}

describe('SessionRoomView', () => {
  it('sends a chat message', async () => {
    const postMessage = vi.fn().mockResolvedValue({});
    const client = fakeClient({
      live: {
        get: vi.fn().mockResolvedValue(session()),
        messages: vi.fn().mockResolvedValue({ items: [message()] }),
        postMessage,
      },
    });
    renderWithProviders(<SessionRoomView id="sess1" />, { client });

    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Say something'), { target: { value: 'hi there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('sess1', 'hi there'));
  });

  it('votes on a poll', async () => {
    const votePoll = vi.fn().mockResolvedValue({});
    const client = fakeClient({
      live: {
        get: vi.fn().mockResolvedValue(session()),
        messages: vi.fn().mockResolvedValue({ items: [] }),
        polls: vi.fn().mockResolvedValue({ items: [poll()] }),
        votePoll,
      },
    });
    renderWithProviders(<SessionRoomView id="sess1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Polls' }));
    await waitFor(() => expect(screen.getByText('Favorite color?')).toBeInTheDocument());
    const blueRow = screen.getByText('Blue').closest('li')!;
    fireEvent.click(within(blueRow).getByRole('button', { name: 'Vote' }));
    await waitFor(() => expect(votePoll).toHaveBeenCalledWith('sess1', 'p1', ['o2']));
  });

  it('asks and answers a question', async () => {
    const askQuestion = vi.fn().mockResolvedValue({});
    const client = fakeClient({
      live: {
        get: vi.fn().mockResolvedValue(session()),
        messages: vi.fn().mockResolvedValue({ items: [] }),
        questions: vi.fn().mockResolvedValue({ items: [] }),
        askQuestion,
      },
    });
    renderWithProviders(<SessionRoomView id="sess1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Q&A' }));
    await waitFor(() => expect(screen.getByText('No questions yet.')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'What now?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith('sess1', 'What now?'));
  });

  it('ends the session only after the explicit confirmation dialog', async () => {
    const end = vi.fn().mockResolvedValue({});
    const client = fakeClient({
      live: {
        get: vi.fn().mockResolvedValue(session()),
        messages: vi.fn().mockResolvedValue({ items: [] }),
        end,
      },
    });
    renderWithProviders(<SessionRoomView id="sess1" />, { client });

    await waitFor(() => expect(screen.getByText('My live show')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(end).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'End session' })[1]!);
    await waitFor(() => expect(end).toHaveBeenCalledWith('sess1'));
  });

  it('cancels a scheduled session only after the explicit confirmation dialog', async () => {
    const cancel = vi.fn().mockResolvedValue({});
    const client = fakeClient({
      live: {
        get: vi
          .fn()
          .mockResolvedValue(
            session({ status: 'scheduled', scheduledFor: new Date().toISOString() }),
          ),
        messages: vi.fn().mockResolvedValue({ items: [] }),
        cancel,
      },
    });
    renderWithProviders(<SessionRoomView id="sess1" />, { client });

    await waitFor(() => expect(screen.getByText('My live show')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    expect(cancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel session' })[1]!);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('sess1'));
  });
});
