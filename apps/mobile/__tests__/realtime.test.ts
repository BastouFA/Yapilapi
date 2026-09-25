import { RealtimeClient, reconnectDelay, wsUrl, type RealtimeStatus } from '../src/realtime/client';
import { FakeSocket } from './support/harness';

const ticket = (n = 1) => ({ ticket: `T${n}`, expiresInSec: 60, url: `/v1/ws?ticket=T${n}` });
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(over: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  FakeSocket.instances = [];
  let n = 0;
  const getTicket = jest.fn(async () => ticket(++n));
  const client = new RealtimeClient({
    baseUrl: 'https://api.test',
    getTicket,
    socketFactory: (u) => new FakeSocket(u),
    random: () => 1,
    minBackoffMs: 1000,
    maxBackoffMs: 30000,
    ...over,
  });
  const statuses: RealtimeStatus[] = [];
  client.onStatus((s) => statuses.push(s));
  const events: Array<{ type: string }> = [];
  client.on((e) => events.push(e));
  return { client, getTicket, statuses, events };
}
const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

describe('RealtimeClient', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('uses the ticket flow: fetches a ticket, opens ws(s)://host/v1/ws?ticket=..., never puts the session token in the URL', async () => {
    const { client, getTicket } = setup();
    client.connect();
    await flush();
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(sock().url).toBe('wss://api.test/v1/ws?ticket=T1');
    expect(wsUrl('http://10.0.2.2:4000/', '/v1/ws?ticket=x')).toBe(
      'ws://10.0.2.2:4000/v1/ws?ticket=x',
    );
    client.disconnect();
  });

  it('is "open" only after the server says ready; then re-subscribes and heartbeats', async () => {
    const { client, statuses, events } = setup();
    client.subscribe('conv-1'); // before connecting: remembered
    client.connect();
    await flush();
    expect(statuses).toContain('connecting');
    sock().open();
    sock().receive({ type: 'ready', userId: 'u', subscriptions: 0, heartbeatMs: 30000 });
    expect(client.status).toBe('open');
    expect(sock().sent.map((s) => JSON.parse(s))).toContainEqual({
      type: 'subscribe',
      conversationId: 'conv-1',
    });
    jest.advanceTimersByTime(30_000);
    expect(sock().sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'ping' });
    sock().receive({ type: 'message.new', conversationId: 'conv-1', message: { id: 'm1' } });
    expect(events.map((e) => e.type)).toEqual(['ready', 'message.new']);
    client.disconnect();
  });

  it('reconnects with a NEW ticket after a drop, backing off, and tells screens to catch up (no replay on the socket)', async () => {
    const { client, getTicket, events, statuses } = setup();
    client.connect();
    await flush();
    sock().open();
    sock().receive({ type: 'ready', userId: 'u', subscriptions: 0, heartbeatMs: 30000 });
    sock().close(); // network drop
    expect(client.status).toBe('reconnecting');
    jest.advanceTimersByTime(999);
    await flush();
    expect(getTicket).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2);
    await flush();
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(sock().url).toContain('ticket=T2');
    sock().open();
    sock().receive({ type: 'ready', userId: 'u', subscriptions: 0, heartbeatMs: 30000 });
    expect(events.map((e) => e.type)).toContain('reconnected');
    expect(statuses.filter((s) => s === 'open')).toHaveLength(2);
    client.disconnect();
  });

  it('keeps retrying when the ticket request itself fails (offline)', async () => {
    let fail = true;
    const { client, getTicket } = setup({
      getTicket: jest.fn(async () => {
        if (fail) throw new Error('offline');
        return ticket(9);
      }),
    });
    client.connect();
    await flush();
    expect(client.status).toBe('reconnecting');
    fail = false;
    jest.advanceTimersByTime(1500);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    void getTicket;
    client.disconnect();
  });

  it('disconnect() stops everything: no reconnect after a deliberate close', async () => {
    const { client, getTicket } = setup();
    client.connect();
    await flush();
    sock().open();
    sock().receive({ type: 'ready', userId: 'u', subscriptions: 0, heartbeatMs: 30000 });
    client.disconnect();
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(client.status).toBe('closed');
  });

  it('sends typing frames only while open', async () => {
    const { client } = setup();
    client.connect();
    await flush();
    client.typing('c1');
    expect(sock().sent).toHaveLength(0);
    sock().open();
    sock().receive({ type: 'ready', userId: 'u', subscriptions: 0, heartbeatMs: 30000 });
    client.typing('c1', 'start');
    expect(JSON.parse(sock().sent.pop()!)).toEqual({
      type: 'typing',
      conversationId: 'c1',
      state: 'start',
    });
    client.disconnect();
  });

  it('ignores malformed frames and a throwing listener does not break the others', async () => {
    const { client } = setup();
    const seen: string[] = [];
    client.on(() => {
      throw new Error('bad listener');
    });
    client.on((e) => seen.push(e.type));
    client.connect();
    await flush();
    sock().open();
    sock().onmessage?.({ data: '{not json' });
    sock().receive({ type: 'ready', userId: 'u', subscriptions: 0, heartbeatMs: 30000 });
    expect(seen).toEqual(['ready']);
    client.disconnect();
  });

  it('reconnectDelay: exponential, jittered into the upper half, capped', () => {
    expect(reconnectDelay(1, 1000, 30000, () => 0)).toBe(500);
    expect(reconnectDelay(1, 1000, 30000, () => 1)).toBe(1000);
    expect(reconnectDelay(4, 1000, 30000, () => 1)).toBe(8000);
    expect(reconnectDelay(20, 1000, 30000, () => 1)).toBe(30000);
  });
});
