import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RealtimeHub } from '../src/lib/realtime.ts';

/** A subscriber whose first subscribe fails, as when Redis is slow to answer while the API starts. */
function flakySubscriber() {
  const sub = new EventEmitter() as EventEmitter & { subscribe: (ch: string) => Promise<number>; channels: string[] };
  let tries = 0;
  sub.channels = [];
  sub.subscribe = async (ch: string) => {
    tries += 1;
    if (tries === 1) throw new Error('Reached the max retries per request limit');
    sub.channels.push(ch);
    return 1;
  };
  return sub;
}

describe('realtime hub', () => {
  it('subscribes again once Redis is ready, so events still reach sockets after a slow start', async () => {
    const sub = flakySubscriber();
    const hub = new RealtimeHub(undefined, sub as unknown as Redis);
    await new Promise((r) => setImmediate(r));
    expect(sub.channels).toEqual([]);

    sub.emit('ready');
    await new Promise((r) => setImmediate(r));
    expect(sub.channels).toEqual(['ypl:realtime']);

    const got: string[] = [];
    hub.add('u1', { readyState: 1, send: (d) => got.push(d) });
    sub.emit('message', 'ypl:realtime', JSON.stringify({ userIds: ['u1'], event: { type: 'ping', data: 1 } }));
    expect(got).toEqual([JSON.stringify({ type: 'ping', data: 1 })]);
  });
});
