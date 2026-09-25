import { describe, expect, it } from 'vitest';
import type { Message } from '@yapilapi/api-client';
import {
  backoffMs,
  conversationTitle,
  discardPending,
  failPending,
  isSeenBy,
  makePending,
  markDeleted,
  pageToItems,
  prependOlder,
  pruneTyping,
  resolvePending,
  sortInbox,
  upsertMessage,
  withReaction,
  wsUrlFrom,
} from './chat-state';

const person = { id: 'u1', username: 'ada', displayName: 'Ada', avatarUrl: null };
const msg = (id: string, at: string, over: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'c1',
  senderId: 'u2',
  sender: { ...person, id: 'u2' },
  kind: 'text',
  body: id,
  deleted: false,
  replyTo: null,
  attachments: [],
  metadata: {},
  reactions: { counts: {}, mine: null },
  poll: null,
  plan: null,
  createdAt: at,
  editedAt: null,
  ...over,
});

describe('chat-state', () => {
  it('reverses API pages into oldest-first order and prepends older pages without duplicates', () => {
    const items = pageToItems([msg('c', '2026-01-03T00:00:00Z'), msg('b', '2026-01-02T00:00:00Z')]);
    expect(items.map((i) => i.message.id)).toEqual(['b', 'c']);
    const more = prependOlder(items, [
      msg('b', '2026-01-02T00:00:00Z'),
      msg('a', '2026-01-01T00:00:00Z'),
    ]);
    expect(more.map((i) => i.message.id)).toEqual(['a', 'b', 'c']);
  });

  it("upsert inserts in time order and keeps the viewer's own reaction on neutral socket updates", () => {
    let items = pageToItems([
      msg('a', '2026-01-01T00:00:00Z', { reactions: { counts: { like: 1 }, mine: 'like' } }),
    ]);
    items = upsertMessage(items, msg('b', '2026-01-02T00:00:00Z'));
    expect(items.map((i) => i.message.id)).toEqual(['a', 'b']);
    items = upsertMessage(
      items,
      msg('a', '2026-01-01T00:00:00Z', { reactions: { counts: { like: 2 }, mine: null } }),
    );
    expect(items[0]!.message.reactions).toEqual({ counts: { like: 2 }, mine: 'like' });
    items = upsertMessage(
      items,
      msg('a', '2026-01-01T00:00:00Z', { reactions: { counts: {}, mine: null } }),
      { authoritative: true },
    );
    expect(items[0]!.message.reactions.mine).toBeNull();
  });

  it("withReaction moves the viewer's reaction and cleans zero counts", () => {
    const m = msg('a', '2026-01-01T00:00:00Z', {
      reactions: { counts: { like: 1, love: 2 }, mine: 'like' },
    });
    expect(withReaction(m, 'love').reactions).toEqual({ counts: { love: 3 }, mine: 'love' });
    expect(withReaction(m, null).reactions).toEqual({ counts: { love: 2 }, mine: null });
  });

  it('markDeleted turns a message into a tombstone', () => {
    const items = markDeleted(
      pageToItems([
        msg('a', '2026-01-01T00:00:00Z', { reactions: { counts: { like: 1 }, mine: null } }),
      ]),
      'a',
    );
    expect(items[0]!.message).toMatchObject({
      deleted: true,
      body: '',
      reactions: { counts: {}, mine: null },
    });
  });

  it('pending messages resolve to the server message, also when the socket delivered it first', () => {
    const sender = { id: 'u1', username: 'ada', displayName: 'Ada', avatarUrl: null };
    const pending = makePending({
      clientId: 'cid-1',
      body: 'hi',
      replyTo: null,
      sender,
      conversationId: 'c1',
      now: new Date('2026-01-05T00:00:00Z'),
    });
    expect(pending.status).toBe('sending');
    const server = msg('m1', '2026-01-05T00:00:01Z', {
      senderId: 'u1',
      clientMessageId: 'cid-1',
      body: 'hi',
    });
    expect(resolvePending([pending], 'cid-1', server).map((i) => [i.message.id, i.status])).toEqual(
      [['m1', 'sent']],
    );
    // socket first
    const viaSocket = upsertMessage([pending], server);
    expect(viaSocket.map((i) => i.message.id)).toEqual(['m1']);
    expect(resolvePending(viaSocket, 'cid-1', server)).toHaveLength(1);
    expect(failPending([pending], 'cid-1')[0]!.status).toBe('failed');
    expect(discardPending(failPending([pending], 'cid-1'), 'cid-1')).toHaveLength(0);
  });

  it('sorts the inbox by pinned then recency', () => {
    const rows = [
      {
        id: 'a',
        pinned: false,
        lastMessageAt: '2026-01-03T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'b',
        pinned: true,
        lastMessageAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      },
      { id: 'c', pinned: false, lastMessageAt: null, createdAt: '2026-01-04T00:00:00Z' },
    ];
    expect(sortInbox(rows).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('titles conversations by kind', () => {
    const fb = { group: 'Group', channel: 'Channel', person: 'Someone' };
    expect(
      conversationTitle({ kind: 'direct', title: null, channelName: null, peer: person }, fb),
    ).toBe('Ada');
    expect(conversationTitle({ kind: 'group', title: '  ', channelName: null }, fb)).toBe('Group');
    expect(
      conversationTitle({ kind: 'community_channel', title: null, channelName: 'general' }, fb),
    ).toBe('#general');
  });

  it('seen, typing expiry, ws url and backoff', () => {
    expect(isSeenBy('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(true);
    expect(isSeenBy(null, '2026-01-01T00:00:00Z')).toBe(false);
    expect(pruneTyping({ a: 1000, b: 9000 }, 10000)).toEqual({ b: 9000 });
    expect(wsUrlFrom('http://localhost:4000', '/v1/ws?ticket=abc')).toBe(
      'ws://localhost:4000/v1/ws?ticket=abc',
    );
    expect(wsUrlFrom('https://api.example.com', '/v1/ws?ticket=abc')).toBe(
      'wss://api.example.com/v1/ws?ticket=abc',
    );
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(10, () => 1)).toBe(30000);
  });
});
