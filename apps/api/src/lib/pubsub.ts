import { Redis } from 'ioredis';

export type PubSubHandler = (message: unknown) => void;

/** Channel-based fan-out used for realtime (messaging, notifications). */
export interface PubSub {
  publish(channel: string, message: unknown): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export class MemoryPubSub implements PubSub {
  private readonly handlers = new Map<string, Set<PubSubHandler>>();

  async publish(channel: string, message: unknown): Promise<void> {
    for (const h of this.handlers.get(channel) ?? []) {
      try {
        h(message);
      } catch {
        /* a broken subscriber must not break publishers */
      }
    }
  }

  async subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

export class RedisPubSub implements PubSub {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<PubSubHandler>>();

  constructor(url: string) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 2 });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub.on('message', (channel: string, raw: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      for (const h of this.handlers.get(channel) ?? []) {
        try {
          h(parsed);
        } catch {
          /* isolate subscribers */
        }
      }
    });
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) {
      this.handlers.set(channel, (set = new Set()));
      await this.sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
