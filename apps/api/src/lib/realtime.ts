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
/** Heard from within this long (two pings and a bit), or it's taken to be gone. */
const PRESENCE_MS = 60_000;

export class RealtimeHub {
  private presence = new WeakMap<Socket, { onScreen: boolean; heardAt: number }>();
  private sockets = new Map<string, Set<Socket>>();
  private readonly channel = 'ypl:realtime';

  constructor(
    private pub?: Redis,
    private sub?: Redis,
  ) {
    if (sub) {
      // Subscribe now and again whenever the connection is ready: if Redis was slow to answer at
      // start (or restarted), a single try would leave this instance deaf to every event.
      const listen = () =>
        void sub.subscribe(this.channel).catch(() => {
          /* tried again on the next 'ready' */
        });
      listen();
      sub.on('ready', listen);
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
    this.presence.set(socket, { onScreen: true, heardAt: Date.now() });
    return () => {
      set!.delete(socket);
      if (!set!.size) this.sockets.delete(userId);
    };
  }

  /** The socket said something (a ping, a frame); `onScreen` when it says whether its page is showing. */
  heard(socket: Socket, onScreen?: boolean) {
    const p = this.presence.get(socket);
    if (!p) return;
    p.heardAt = Date.now();
    if (onScreen !== undefined) p.onScreen = onScreen;
  }

  /**
   * Whether this person has the app in front of them, so a new message reaches them there and needs
   * no notification. An open socket isn't enough: a phone keeps one open for a long time with the app
   * in the background or frozen, and they'd never hear about anything. It has to say its page is
   * showing, and have been heard from lately (apps ping every 25 seconds).
   */
  isOnline(userId: string): boolean {
    const now = Date.now();
    for (const s of this.sockets.get(userId) ?? []) {
      const p = this.presence.get(s);
      if (s.readyState === 1 && p?.onScreen && now - p.heardAt < PRESENCE_MS) return true;
    }
    return false;
  }

  async publish(userIds: string[], event: RealtimeEvent): Promise<void> {
    if (!userIds.length) return;
    if (this.pub) await this.pub.publish(this.channel, JSON.stringify({ userIds, event }));
    else this.deliverLocal(userIds, event);
  }

  private deliverLocal(userIds: string[], event: RealtimeEvent) {
    const payload = JSON.stringify(event);
    for (const id of userIds) for (const s of this.sockets.get(id) ?? []) if (s.readyState === 1) s.send(payload);
  }
}
