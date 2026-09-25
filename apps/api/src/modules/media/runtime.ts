import type { AppContext } from '../../lib/context.js';
import { DefaultMediaProcessor, type MediaProcessor } from './processor.js';
import { LocalStorageAdapter, type StorageAdapter } from './storage.js';
import { S3StorageAdapter } from './s3.js';
import { processMedia } from './pipeline.js';

/** Queue seam: today an in-process queue, replaceable by a durable job system without touching callers. */
export interface MediaQueue {
  enqueue(mediaId: string): void;
  /** Resolves when nothing is queued or running (used by tests and graceful shutdown). */
  idle(): Promise<void>;
}

export class InProcessQueue implements MediaQueue {
  private pending: string[] = [];
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(
    private readonly handler: (mediaId: string) => Promise<void>,
    private readonly concurrency = 1,
  ) {}

  enqueue(mediaId: string): void {
    if (this.pending.includes(mediaId)) return;
    this.pending.push(mediaId);
    setImmediate(() => this.pump());
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length) {
      const id = this.pending.shift()!;
      this.running++;
      void this.handler(id)
        .catch(() => undefined) // handler records failures itself
        .finally(() => {
          this.running--;
          this.pump();
          if (!this.running && !this.pending.length) for (const w of this.waiters.splice(0)) w();
        });
    }
  }

  idle(): Promise<void> {
    if (!this.running && !this.pending.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
}

export interface MediaRuntime {
  adapter: StorageAdapter;
  processor: MediaProcessor;
  queue: MediaQueue;
}

const runtimes = new WeakMap<AppContext, MediaRuntime>();

export function createStorageAdapter(ctx: AppContext): StorageAdapter {
  const c = ctx.config;
  if (c.MEDIA_ADAPTER === 's3') {
    if (!c.S3_BUCKET || !c.S3_REGION || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY) {
      throw new Error(
        'MEDIA_ADAPTER=s3 requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY',
      );
    }
    return new S3StorageAdapter({
      endpoint: c.S3_ENDPOINT,
      region: c.S3_REGION,
      bucket: c.S3_BUCKET,
      accessKeyId: c.S3_ACCESS_KEY_ID,
      secretAccessKey: c.S3_SECRET_ACCESS_KEY,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalStorageAdapter(c.MEDIA_LOCAL_DIR);
}

/** Process-wide (per AppContext) storage adapter, processor and queue; created lazily so scripts can use them too. */
export function getMediaRuntime(ctx: AppContext): MediaRuntime {
  let rt = runtimes.get(ctx);
  if (!rt) {
    const processor = new DefaultMediaProcessor({
      ffmpegPath: ctx.config.MEDIA_FFMPEG_PATH,
      ffprobePath: ctx.config.MEDIA_FFPROBE_PATH,
    });
    const queue = new InProcessQueue((id) => processMedia(ctx, runtimes.get(ctx)!, id));
    rt = { adapter: createStorageAdapter(ctx), processor, queue };
    runtimes.set(ctx, rt);
  }
  return rt;
}

/** Replace parts of the runtime (tests, alternative deployments). */
export function overrideMediaRuntime(ctx: AppContext, patch: Partial<MediaRuntime>): MediaRuntime {
  const rt = { ...getMediaRuntime(ctx), ...patch };
  runtimes.set(ctx, rt);
  return rt;
}
