import { ApiError } from '@yapilapi/api-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Outbox, backoffMs, type OutboxItem } from '../src/offline/outbox';
import { createOutboxRunner, findPostedDuplicate } from '../src/offline/handlers';
import { buildChatRows } from '../src/features/chat';
import { makeFetch } from './support/harness';
import { createMobileApi } from '../src/api';

const U = 'user-1';
let clock = 1_000_000;
const mk = (userId = U) => new Outbox(userId, () => clock);
const ok = async (i: OutboxItem) => ({ echoed: i.id });

beforeEach(async () => {
  await AsyncStorage.clear();
  clock = 1_000_000;
});

describe('outbox', () => {
  it('persists queued items per user and reloads them after a restart', async () => {
    const a = mk();
    await a.enqueue({ kind: 'post', draft: { body: 'hello' } });
    await a.enqueue({ kind: 'message', conversationId: 'c1', body: 'hi' });
    const b = mk();
    await b.load();
    expect(b.list().map((i) => i.kind)).toEqual(['post', 'message']);
    const other = mk('user-2');
    await other.load();
    expect(other.list()).toHaveLength(0); // one person's drafts never leak to another
  });

  it('delivers in order and removes delivered items', async () => {
    const o = mk();
    await o.enqueue({ kind: 'message', conversationId: 'c1', body: 'one' });
    await o.enqueue({ kind: 'message', conversationId: 'c1', body: 'two' });
    const seen: string[] = [];
    const res = await o.flush(async (i) => {
      seen.push((i as { body: string }).body);
      return ok(i);
    });
    expect(seen).toEqual(['one', 'two']);
    expect(res.delivered).toHaveLength(2);
    expect(o.list()).toHaveLength(0);
    expect(JSON.parse((await AsyncStorage.getItem(`yl.outbox.v1.${U}`))!)).toEqual([]);
  });

  it('stops at the first connectivity failure (order matters) and backs off exponentially', async () => {
    const o = mk();
    await o.enqueue({ kind: 'message', conversationId: 'c1', body: 'one' });
    await o.enqueue({ kind: 'message', conversationId: 'c1', body: 'two' });
    const run = jest.fn(async () => {
      throw new ApiError('network_error', 'offline', 0);
    });
    const res = await o.flush(run);
    expect(res.offline).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(o.list()).toHaveLength(2);
    expect(o.list()[0]!.attempts).toBe(1);
    expect(o.nextDueAt()).toBeGreaterThan(clock);
    // Not due yet: nothing is attempted until the backoff passes.
    run.mockClear();
    await o.flush(run);
    expect(run).not.toHaveBeenCalled();
    clock += 10_000;
    await o.flush(ok);
    expect(o.list()).toHaveLength(0);
  });

  it('marks permanent 4xx failures as failed, keeps going, and lets the user retry', async () => {
    const o = mk();
    await o.enqueue({ kind: 'post', draft: { body: 'bad' } });
    await o.enqueue({ kind: 'post', draft: { body: 'good' } });
    const res = await o.flush(async (i) => {
      if ((i as { draft: { body: string } }).draft.body === 'bad')
        throw new ApiError('validation_failed', 'nope', 422);
      return ok(i);
    });
    expect(res.failed).toHaveLength(1);
    expect(res.delivered).toHaveLength(1);
    const failed = o.list()[0]!;
    expect(failed.status).toBe('failed');
    await o.retry(failed.id);
    expect(o.list()[0]!.status).toBe('queued');
  });

  it('honours Retry-After on 429', async () => {
    const o = mk();
    await o.enqueue({ kind: 'message', conversationId: 'c', body: 'x' });
    await o.flush(async () => {
      throw new ApiError('rate_limited', 'slow', 429, null, undefined, 60);
    });
    expect(o.nextDueAt()).toBe(clock + 60_000);
  });

  it('runs one flush at a time', async () => {
    const o = mk();
    await o.enqueue({ kind: 'message', conversationId: 'c', body: 'x' });
    const run = jest.fn(async (i: OutboxItem) => {
      await new Promise((r) => setTimeout(r, 20));
      return ok(i);
    });
    await Promise.all([o.flush(run), o.flush(run), o.flush(run)]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('clear() wipes the queue and its storage (sign-out)', async () => {
    const o = mk();
    await o.enqueue({ kind: 'post', draft: { body: 'secret draft' } });
    await o.clear();
    expect(o.list()).toHaveLength(0);
    expect(await AsyncStorage.getItem(`yl.outbox.v1.${U}`)).toBeNull();
  });

  it('backoff grows 2s, 4s, 8s ... capped at 5 minutes (plus jitter below 500ms)', () => {
    const z = () => 0;
    expect([1, 2, 3, 4].map((n) => backoffMs(n, z))).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffMs(30, z)).toBe(300_000);
    expect(backoffMs(3, () => 0.999)).toBeLessThan(8500);
  });
});

describe('outbox runner (what actually gets sent)', () => {
  const setup = (routes: Parameters<typeof makeFetch>[0]) => {
    const fetch = makeFetch(routes);
    const api = createMobileApi({
      baseUrl: 'https://api.test',
      getToken: () => 't',
      fetch: fetch as never,
    });
    return {
      fetch,
      api,
      run: createOutboxRunner(api, { username: 'ada', lowBandwidth: () => false }),
    };
  };
  const item = (over: Partial<OutboxItem>) =>
    ({
      id: 'i1',
      userId: U,
      createdAt: 1000,
      attempts: 0,
      nextAttemptAt: 0,
      status: 'queued',
      ...over,
    }) as OutboxItem;

  it('messages carry the clientMessageId so retries are idempotent on the server', async () => {
    const { fetch, run } = setup({
      'POST /v1/conversations/c1/messages': { status: 201, json: { id: 'm1' } },
    });
    await run(
      item({
        kind: 'message',
        conversationId: 'c1',
        body: 'hi',
        clientMessageId: 'cmid-1',
      } as never),
      async () => undefined,
    );
    expect(fetch.calls[0]!.body).toEqual({ body: 'hi', clientMessageId: 'cmid-1' });
  });

  it('posts are created once; a post whose answer was lost is found again instead of duplicated', async () => {
    const posted = { id: 'p1', body: 'hello', createdAt: new Date(1500).toISOString(), poll: null };
    const { fetch, run } = setup({
      'GET /v1/users/ada/posts': { json: { items: [posted], nextCursor: null } },
      'POST /v1/posts': { status: 201, json: { id: 'p-new' } },
    });
    const res = await run(
      item({ kind: 'post', draft: { body: 'hello' }, maybeSent: true, sentAt: 1200 } as never),
      async () => undefined,
    );
    expect(res).toEqual(posted);
    expect(fetch.calls.some((c) => c.method === 'POST' && c.path === '/v1/posts')).toBe(false);
  });

  it('marks maybeSent before the create request, so a crash mid-request is reconciled next time', async () => {
    const { run } = setup({ 'POST /v1/posts': { status: 201, json: { id: 'p1' } } });
    const patches: Array<Partial<OutboxItem>> = [];
    await run(item({ kind: 'post', draft: { body: 'x' } } as never), async (p) => {
      patches.push(p);
    });
    expect(patches.some((p) => p.maybeSent === true)).toBe(true);
  });

  it('findPostedDuplicate ignores older posts with the same text', async () => {
    const { api } = setup({
      'GET /v1/users/ada/posts': {
        json: {
          items: [{ id: 'old', body: 'hello', createdAt: new Date(0).toISOString(), poll: null }],
          nextCursor: null,
        },
      },
    });
    expect(await findPostedDuplicate(api, 'ada', { body: 'hello' }, 1_000_000)).toBeNull();
  });
});

describe('chat rows', () => {
  const msg = (id: string, clientMessageId?: string) => ({
    id,
    clientMessageId,
    conversationId: 'c1',
    senderId: 'u',
    sender: null,
    kind: 'text',
    body: id,
    deleted: false,
    replyTo: null,
    attachments: [],
    metadata: {},
    reactions: { counts: {}, mine: null },
    poll: null,
    plan: null,
    createdAt: '2026-01-01T00:00:00Z',
    editedAt: null,
  });
  const pending = (id: string, cmid: string, conv = 'c1') =>
    ({
      id,
      userId: U,
      createdAt: 5,
      attempts: 0,
      nextAttemptAt: 0,
      status: 'queued',
      kind: 'message',
      conversationId: conv,
      body: id,
      clientMessageId: cmid,
    }) as OutboxItem;

  it('shows queued messages first (newest) and hides one the server already returned', () => {
    const rows = buildChatRows(
      [msg('m2', 'A'), msg('m1')] as never,
      [pending('p1', 'A'), pending('p2', 'B'), pending('p3', 'C', 'other-conv')],
      'c1',
    );
    expect(rows.map((r) => r.id)).toEqual(['pending:p2', 'm2', 'm1']);
  });
});
