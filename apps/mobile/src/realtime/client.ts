import type { RealtimeEvent, WsTicket } from '@yapilapi/api-client';

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The subset of the WebSocket API we use (React Native's global WebSocket, or `ws` / Node's in tests). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface RealtimeOptions {
  /** `POST /v1/ws/ticket`: a single-use, 60-second ticket. A fresh one is fetched for every (re)connection. */
  getTicket: () => Promise<WsTicket>;
  /** API origin, e.g. `https://api.example.com`. `http(s)` is turned into `ws(s)`. */
  baseUrl: string;
  socketFactory?: SocketFactory;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  /** Give up on a connection attempt if `ready` does not arrive in this time. */
  connectTimeoutMs?: number;
}

type Listener = (e: RealtimeEvent) => void;

export const wsUrl = (baseUrl: string, path: string) =>
  baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + path;

/** Exponential backoff with full jitter on the upper half: 1s, 2s, 4s ... capped (default 30s). */
export function reconnectDelay(
  attempt: number,
  min = 1000,
  max = 30_000,
  rand: () => number = Math.random,
): number {
  const ceil = Math.min(max, min * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceil / 2 + rand() * (ceil / 2));
}

/**
 * Realtime connection to `/v1/ws` using the ticket flow (the session token never appears in the socket URL):
 *  1. `getTicket()`  2. open `ws(s)://host/v1/ws?ticket=…`  3. wait for `ready`  4. re-subscribe to conversations
 * Heartbeats keep NATs and the server's liveness check happy. When the socket drops it reconnects with exponential
 * backoff and jitter, and emits `reconnected` so screens can catch up with a REST fetch (the socket has no replay).
 */
export class RealtimeClient {
  status: RealtimeStatus = 'idle';
  private socket: SocketLike | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: RealtimeStatus) => void>();
  private subs = new Set<string>();
  private attempt = 0;
  private wantOpen = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private everOpened = false;
  private generation = 0;

  constructor(private readonly o: RealtimeOptions) {}

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  onStatus(fn: (s: RealtimeStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }
  private setStatus(s: RealtimeStatus) {
    if (this.status !== s) {
      this.status = s;
      for (const l of [...this.statusListeners]) l(s);
    }
  }
  private emit(e: RealtimeEvent) {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* one bad listener must not break the others */
      }
    }
  }

  connect(): void {
    if (this.wantOpen) return;
    this.wantOpen = true;
    this.attempt = 0;
    void this.open();
  }

  disconnect(): void {
    this.wantOpen = false;
    this.generation++;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, 'client closing');
      } catch {
        /* ignore */
      }
    }
    this.setStatus('closed');
  }

  subscribe(conversationId: string): void {
    this.subs.add(conversationId);
    this.send({ type: 'subscribe', conversationId });
  }
  unsubscribe(conversationId: string): void {
    this.subs.delete(conversationId);
    this.send({ type: 'unsubscribe', conversationId });
  }
  typing(conversationId: string, state: 'start' | 'stop' = 'start'): void {
    this.send({ type: 'typing', conversationId, state });
  }

  private send(frame: Record<string, unknown>): void {
    const s = this.socket;
    if (s && s.readyState === 1) {
      try {
        s.send(JSON.stringify(frame));
      } catch {
        /* the close handler will reconnect */
      }
    }
  }

  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.timer = this.heartbeat = this.connectTimer = null;
  }

  private async open(): Promise<void> {
    const gen = ++this.generation;
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');
    let ticket: WsTicket;
    try {
      ticket = await this.o.getTicket();
    } catch {
      if (gen === this.generation) this.scheduleReconnect();
      return;
    }
    if (gen !== this.generation || !this.wantOpen) return;
    const factory: SocketFactory =
      this.o.socketFactory ??
      ((u) =>
        new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(u));
    const sock = factory(wsUrl(this.o.baseUrl, ticket.url));
    this.socket = sock;
    this.connectTimer = setTimeout(() => {
      if (gen === this.generation && this.status !== 'open')
        try {
          sock.close();
        } catch {
          /* ignore */
        }
    }, this.o.connectTimeoutMs ?? 15_000);

    sock.onmessage = (ev) => {
      if (gen !== this.generation) return;
      let frame: RealtimeEvent;
      try {
        frame = JSON.parse(String(ev.data)) as RealtimeEvent;
      } catch {
        return;
      }
      if (frame.type === 'ready') {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        const reconnected = this.everOpened;
        this.everOpened = true;
        this.attempt = 0;
        this.setStatus('open');
        const hb = Math.max(
          5_000,
          Math.min(60_000, (frame as { heartbeatMs?: number }).heartbeatMs ?? 30_000) - 2_000,
        );
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.send({ type: 'ping' }), hb);
        // The server subscribes us to existing conversations; anything opened since is re-subscribed explicitly.
        for (const id of this.subs) this.send({ type: 'subscribe', conversationId: id });
        this.emit(frame);
        if (reconnected) this.emit({ type: 'reconnected' });
        return;
      }
      this.emit(frame);
    };
    sock.onclose = () => {
      if (gen !== this.generation) return;
      this.socket = null;
      this.clearTimers();
      if (this.wantOpen) this.scheduleReconnect();
      else this.setStatus('closed');
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    this.clearTimers();
    this.setStatus('reconnecting');
    this.attempt += 1;
    const delay = reconnectDelay(
      this.attempt,
      this.o.minBackoffMs,
      this.o.maxBackoffMs,
      this.o.random,
    );
    this.timer = setTimeout(() => {
      if (this.wantOpen) void this.open();
    }, delay);
  }

  /** Drop the current socket and reconnect right away (e.g. the app returned to the foreground). */
  reconnectNow(): void {
    if (!this.wantOpen) return;
    this.generation++;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.attempt = 0;
    void this.open();
  }
}
