import type { Redis } from 'ioredis';

export interface RealtimeEvent {
  type: string;
  data: unknown;
}

type Socket = { send: (data: string) => void; readyState: number };

/**
 * Delivers events to connected WebSocket clients. With Redis configured, every
 * API instance publishes to one channel and delivers to its own sockets, so
 * horizontal scaling works. Without Redis it delivers in-process only.
 */
export class RealtimeHub {
  private sockets = new Map<string, Set<Socket>>();
  private readonly channel = 'ypl:realtime';

  constructor(
    private pub?: Redis,
    private sub?: Redis,
  ) {
    if (sub) {
      void sub.subscribe(this.channel);
      sub.on('message', (_ch, raw) => {
        try {
          const { userIds, event } = JSON.parse(raw) as { userIds: string[]; event: RealtimeEvent };
          this.deliverLocal(userIds, event);
        } catch {
          /* ignore malformed messages */
        }
      });
    }
  }

  add(userId: string, socket: Socket): () => void {
    let set = this.sockets.get(userId);
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(socket);
    return () => {
      set!.delete(socket);
      if (!set!.size) this.sockets.delete(userId);
    };
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }

  async publish(userIds: string[], event: RealtimeEvent): Promise<void> {
    if (!userIds.length) return;
    if (this.pub) await this.pub.publish(this.channel, JSON.stringify({ userIds, event }));
    else this.deliverLocal(userIds, event);
  }

  private deliverLocal(userIds: string[], event: RealtimeEvent) {
    const payload = JSON.stringify(event);
    for (const id of userIds)
      for (const s of this.sockets.get(id) ?? [])
        if (s.readyState === 1) s.send(payload);
  }
}
