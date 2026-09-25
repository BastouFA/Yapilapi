import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import Chat from '../src/app/chat/[id]';
import Notifications from '../src/app/(tabs)/notifications';
import { makeFetch, meResponse, renderApp, router, selfUser, setParams } from './support/harness';

// Let in-flight query notifications land inside act() before the tree is torn down, so they never leak into the next test.
afterEach(async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
});

const ME = selfUser().id;
const peer = { id: 'u-2', username: 'bola', displayName: 'Bola A', avatarUrl: null };
const conversation = (over: Record<string, unknown> = {}) => ({
  id: 'conv-1',
  kind: 'direct',
  title: null,
  channelName: null,
  createdAt: '2026-01-01T00:00:00Z',
  role: 'member',
  canSend: true,
  canManage: false,
  me: { lastReadAt: null, mutedUntil: null, muted: false, pinned: false },
  unreadCount: 0,
  members: [],
  peer,
  ...over,
});
const message = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  conversationId: 'conv-1',
  senderId: 'u-2',
  sender: peer,
  kind: 'text',
  body: 'Hi there',
  deleted: false,
  replyTo: null,
  attachments: [],
  metadata: {},
  reactions: { counts: {}, mine: null },
  poll: null,
  plan: null,
  clientMessageId: null,
  createdAt: '2026-01-02T10:30:00Z',
  editedAt: null,
  ...over,
});
const base = (msgs: unknown[] = [message()]) => ({
  'GET /v1/auth/me': { json: meResponse() },
  'GET /v1/conversations/conv-1': { json: conversation() },
  'GET /v1/conversations/conv-1/messages': { json: { items: msgs, nextCursor: null } },
  'POST /v1/conversations/conv-1/read': { json: { lastReadAt: '2026-01-02T11:00:00Z' } },
});

describe('Chat', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    setParams({ id: 'conv-1' });
  });

  it('shows messages with accessible names for sender and time, and marks the conversation read', async () => {
    const fetch = makeFetch(
      base([
        message(),
        message({
          id: 'm2',
          senderId: ME,
          sender: { ...peer, id: ME, username: 'ada', displayName: 'Ada Obi' },
          body: 'Hello Bola',
        }),
      ]),
    );
    await renderApp(<Chat />, { fetch });
    expect(await screen.findByText('Hi there')).toBeTruthy();
    expect(screen.getByText('Hello Bola')).toBeTruthy();
    expect(screen.getByLabelText(/^Message from Bola A, .+\. Hi there$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Your message, .+\. Hello Bola$/)).toBeTruthy();
    await waitFor(() =>
      expect(
        fetch.calls.some((c) => c.method === 'POST' && c.path === '/v1/conversations/conv-1/read'),
      ).toBe(true),
    );
  });

  it('shows an empty conversation prompt and a not-allowed notice when sending is blocked', async () => {
    await renderApp(<Chat />, {
      fetch: makeFetch({
        ...base([]),
        'GET /v1/conversations/conv-1': { json: conversation({ canSend: false }) },
      }),
    });
    expect(await screen.findByText('Say hello to start the conversation.')).toBeTruthy();
    expect(screen.getByText('You cannot send messages in this conversation.')).toBeTruthy();
    expect(screen.queryByLabelText('Write a message')).toBeNull();
  });

  it('sends with a clientMessageId (idempotent) and shows the message as sending, then delivered', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const delivered: unknown[] = [];
    const fetch = makeFetch({
      ...base([]),
      'GET /v1/conversations/conv-1/messages': () => ({
        json: { items: delivered, nextCursor: null },
      }),
      'POST /v1/conversations/conv-1/messages': async ({ body }) => {
        await gate;
        const b = body as { body: string; clientMessageId: string };
        const m = message({
          id: 'm9',
          senderId: ME,
          sender: { ...peer, id: ME },
          body: b.body,
          clientMessageId: b.clientMessageId,
        });
        delivered.push(m);
        return { status: 201, json: m };
      },
    });
    await renderApp(<Chat />, { fetch });
    fireEvent.changeText(await screen.findByLabelText('Write a message'), '  On my way ');
    fireEvent.press(screen.getByLabelText('Send message'));
    expect(await screen.findByText('Sending')).toBeTruthy();
    expect(screen.getByText('On my way')).toBeTruthy();
    expect(screen.getByLabelText('Write a message').props.value).toBe('');
    release();
    await waitFor(() => expect(screen.queryByText('Sending')).toBeNull());
    expect(screen.getAllByText('On my way')).toHaveLength(1); // never duplicated
    const post = fetch.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages'))!;
    expect(post.body).toMatchObject({ body: 'On my way' });
    expect((post.body as { clientMessageId: string }).clientMessageId).toMatch(/[0-9a-f-]{20,}/);
  });

  it('keeps an unsent message visible with a retry action when offline', async () => {
    let online = false;
    const fetch = makeFetch({
      ...base([]),
      'POST /v1/conversations/conv-1/messages': ({ body }) => {
        if (!online) throw new TypeError('Network request failed');
        const b = body as { body: string; clientMessageId: string };
        return {
          status: 201,
          json: message({
            id: 'm9',
            senderId: ME,
            body: b.body,
            clientMessageId: b.clientMessageId,
          }),
        };
      },
    });
    await renderApp(<Chat />, { fetch });
    fireEvent.changeText(await screen.findByLabelText('Write a message'), 'Offline note');
    fireEvent.press(screen.getByLabelText('Send message'));
    expect(await screen.findByText('Offline note')).toBeTruthy();
    const retry = await screen.findByRole('button', { name: 'Send now' });
    const first = fetch.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'));
    online = true;
    fireEvent.press(retry);
    await waitFor(() =>
      expect(
        fetch.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages')).length,
      ).toBeGreaterThan(first.length),
    );
    const all = fetch.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'));
    // Same idempotency key on every attempt, so the server can drop duplicates.
    expect(
      new Set(all.map((c) => (c.body as { clientMessageId: string }).clientMessageId)).size,
    ).toBe(1);
  });

  it('marks a message the server rejected as "Not sent" and lets the user discard it', async () => {
    const fetch = makeFetch({
      ...base([]),
      'POST /v1/conversations/conv-1/messages': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'Friends only' } },
      },
    });
    await renderApp(<Chat />, { fetch });
    fireEvent.changeText(await screen.findByLabelText('Write a message'), 'Blocked one');
    fireEvent.press(screen.getByLabelText('Send message'));
    expect(await screen.findByText('Not sent')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('Blocked one')).toBeNull());
  });

  it('shows deleted messages as a placeholder, not their content', async () => {
    await renderApp(<Chat />, {
      fetch: makeFetch(base([message({ deleted: true, body: 'secret' })])),
    });
    expect(await screen.findByText('This message was deleted.')).toBeTruthy();
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('shows an error with retry if the conversation cannot be loaded', async () => {
    await renderApp(<Chat />, {
      fetch: makeFetch({
        'GET /v1/conversations/conv-1': () => {
          throw new TypeError('Network request failed');
        },
      }),
    });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  kind: 'follow',
  category: 'social',
  actor: { id: 'u-2', username: 'bola', displayName: 'Bola A', avatarUrl: null },
  targetType: 'user',
  targetId: 'u-2',
  data: {},
  read: false,
  createdAt: '2026-01-02T00:00:00Z',
  ...over,
});

describe('Notifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders localised sentences per kind and a generic line for unknown kinds (never raw API text)', async () => {
    const fetch = makeFetch({
      'GET /v1/notifications': {
        json: {
          items: [
            note(),
            note({
              id: 'n2',
              kind: 'privacy_export_ready',
              actor: null,
              targetType: null,
              targetId: null,
              read: true,
            }),
            note({
              id: 'n3',
              kind: 'something_new_from_server',
              actor: null,
              targetType: null,
              targetId: null,
            }),
          ],
          nextCursor: null,
        },
      },
    });
    await renderApp(<Notifications />, { fetch });
    expect(await screen.findByText('Bola A started following you')).toBeTruthy();
    expect(screen.getByText('Your data export is ready.')).toBeTruthy();
    expect(screen.getByText('You have a new notification.')).toBeTruthy();
    expect(screen.getByLabelText(/Bola A started following you\. .*Unread/)).toBeTruthy();
  });

  it('opens the target and marks the notification read', async () => {
    const fetch = makeFetch({
      'GET /v1/notifications': {
        json: {
          items: [
            note({
              id: 'n5',
              kind: 'comment',
              targetType: 'comment',
              targetId: 'c1',
              data: { postId: 'p7' },
            }),
          ],
          nextCursor: null,
        },
      },
      'POST /v1/notifications/n5/read': { status: 204 },
    });
    await renderApp(<Notifications />, { fetch });
    fireEvent.press(await screen.findByRole('button', { name: /commented on your post/ }));
    expect(router().push).toHaveBeenCalledWith('/post/p7');
    await waitFor(() =>
      expect(fetch.calls.some((c) => c.path === '/v1/notifications/n5/read')).toBe(true),
    );
  });

  it('marks everything as read', async () => {
    const fetch = makeFetch({
      'GET /v1/notifications': { json: { items: [note()], nextCursor: null } },
      'POST /v1/notifications/read-all': { json: { updated: 1 } },
    });
    await renderApp(<Notifications />, { fetch });
    fireEvent.press(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect(fetch.calls.some((c) => c.path === '/v1/notifications/read-all')).toBe(true),
    );
  });

  it('has an empty state and an error state', async () => {
    await renderApp(<Notifications />, {
      fetch: makeFetch({ 'GET /v1/notifications': { json: { items: [], nextCursor: null } } }),
    });
    expect(await screen.findByText('You have no notifications yet.')).toBeTruthy();
    screen.unmount();
    await renderApp(<Notifications />, {
      fetch: makeFetch({
        'GET /v1/notifications': {
          status: 500,
          json: { error: { code: 'internal', message: 'x' } },
        },
      }),
    });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
