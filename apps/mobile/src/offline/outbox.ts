import { ApiError, type CreatePostInput } from '@yapilapi/api-client';
import { kv } from '../lib/kv';
import { uuid } from '../lib/ids';

export interface DraftMedia {
  uri: string;
  name: string;
  mimeType: string;
  size?: number | undefined;
  altText?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** Filled once the file is uploaded, so a retry never uploads it twice. */
  mediaId?: string | undefined;
  /** Resumable upload session, so a retry continues instead of restarting. */
  uploadId?: string | undefined;
}
export type PostDraft = Omit<CreatePostInput, 'mediaIds'> & { media?: DraftMedia[] };

interface Base {
  /** Local id; also the idempotency key for the request. */
  id: string;
  userId: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: 'queued' | 'failed';
  error?: string | undefined;
  /** A create request was sent but we never saw the answer: reconcile before sending again. */
  maybeSent?: boolean | undefined;
  sentAt?: number | undefined;
}
export type OutboxItem =
  | (Base & { kind: 'post'; draft: PostDraft })
  | (Base & {
      kind: 'message';
      conversationId: string;
      body: string;
      replyToId?: string | undefined;
      clientMessageId: string;
    });

export type NewOutboxItem =
  | { kind: 'post'; draft: PostDraft }
  | {
      kind: 'message';
      conversationId: string;
      body: string;
      replyToId?: string | undefined;
      clientMessageId?: string;
    };

export type Runner = (
  item: OutboxItem,
  update: (patch: Partial<OutboxItem>) => Promise<void>,
) => Promise<unknown>;

export interface FlushResult {
  delivered: Array<{ item: OutboxItem; result: unknown }>;
  failed: OutboxItem[];
  offline: boolean;
}

/** Exponential backoff with jitter: 2s, 4s, 8s ... capped at 5 minutes. */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  return Math.min(300_000, 2000 * 2 ** Math.max(0, attempts - 1)) + Math.floor(rand() * 500);
}

const key = (userId: string) => `yl.outbox.v1.${userId}`;

/**
 * Durable retry queue for things the user created while offline or on a bad link (posts, chat messages).
 * Persisted to AsyncStorage per user, delivered in order, retried with backoff. Every entry carries an idempotency key:
 * messages use the API's `clientMessageId` (the server de-duplicates); the API has no idempotency for posts, so a post
 * whose answer was lost is reconciled against the author's recent posts before it is sent again (see handlers.ts).
 */
export class Outbox {
  private items: OutboxItem[] = [];
  private listeners = new Set<() => void>();
  private flushing: Promise<FlushResult> | null = null;
  private loaded = false;

  constructor(
    readonly userId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const stored = await kv.get<OutboxItem[]>(key(this.userId));
    // Items added before load finished (rare) are kept.
    const known = new Set(this.items.map((i) => i.id));
    this.items = [
      ...(stored ?? []).filter((i) => !known.has(i.id) && i.userId === this.userId),
      ...this.items,
    ];
    this.loaded = true;
    this.emit();
  }

  get isLoaded() {
    return this.loaded;
  }
  list(): readonly OutboxItem[] {
    return this.items;
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    for (const l of [...this.listeners]) l();
  }
  private async persist() {
    await kv.set(key(this.userId), this.items);
    this.emit();
  }

  async enqueue(n: NewOutboxItem): Promise<OutboxItem> {
    const base: Base = {
      id: uuid(),
      userId: this.userId,
      createdAt: this.now(),
      attempts: 0,
      nextAttemptAt: 0,
      status: 'queued',
    };
    const item: OutboxItem =
      n.kind === 'post'
        ? { ...base, kind: 'post', draft: n.draft }
        : {
            ...base,
            kind: 'message',
            conversationId: n.conversationId,
            body: n.body,
            replyToId: n.replyToId,
            clientMessageId: n.clientMessageId ?? uuid(),
          };
    this.items = [...this.items, item];
    await this.persist();
    return item;
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((i) => i.id !== id);
    await this.persist();
  }

  /** Put a failed item back in line right now (user tapped "Try again"). */
  async retry(id: string): Promise<void> {
    this.items = this.items.map((i) =>
      i.id === id
        ? ({ ...i, status: 'queued', error: undefined, nextAttemptAt: 0 } as OutboxItem)
        : i,
    );
    await this.persist();
  }

  async clear(): Promise<void> {
    this.items = [];
    await kv.remove(key(this.userId));
    this.emit();
  }

  private async patch(id: string, patch: Partial<OutboxItem>): Promise<void> {
    this.items = this.items.map((i) => (i.id === id ? ({ ...i, ...patch } as OutboxItem) : i));
    await this.persist();
  }

  /** Earliest time at which a queued item is due (for scheduling the next flush), or null. */
  nextDueAt(): number | null {
    // Delivery is in order, so the head of the queue decides when the next attempt can happen.
    const head = this.items.find((i) => i.status === 'queued');
    return head ? head.nextAttemptAt : null;
  }

  /**
   * Deliver everything that is due, oldest first. One flush at a time. Stops at the first connectivity failure
   * (later items would fail too and order matters); permanent 4xx failures mark the item `failed` and continue.
   */
  flush(run: Runner, opts: { ignoreBackoff?: boolean } = {}): Promise<FlushResult> {
    if (this.flushing) return this.flushing;
    this.flushing = (async (): Promise<FlushResult> => {
      const out: FlushResult = { delivered: [], failed: [], offline: false };
      for (const snapshot of [...this.items]) {
        const item = this.items.find((i) => i.id === snapshot.id);
        if (!item || item.status !== 'queued') continue;
        // The head of the queue is waiting out a backoff: later items wait too, so order is preserved.
        if (!opts.ignoreBackoff && item.nextAttemptAt > this.now()) break;
        try {
          const result = await run(item, (p) => this.patch(item.id, p));
          await this.remove(item.id);
          out.delivered.push({ item, result });
        } catch (e) {
          const attempts = item.attempts + 1;
          if (e instanceof ApiError && !e.retryable) {
            await this.patch(item.id, { attempts, status: 'failed', error: e.message });
            out.failed.push({
              ...item,
              attempts,
              status: 'failed',
              error: e.message,
            } as OutboxItem);
            continue;
          }
          const wait =
            e instanceof ApiError && e.retryAfterSec ? e.retryAfterSec * 1000 : backoffMs(attempts);
          await this.patch(item.id, {
            attempts,
            nextAttemptAt: this.now() + wait,
            error: e instanceof Error ? e.message : String(e),
          });
          if (e instanceof ApiError && (e.code === 'network_error' || e.code === 'timeout')) {
            out.offline = true;
            break;
          }
        }
      }
      return out;
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
}
