import { ApiError } from '@yapilapi/api-client';
import type { MobileApi, MediaView, UploadFile } from '../api';
import { sha256Hex, Sha256 } from '../lib/sha256';

/** Random-access reader over a local file (an Expo `File` on device, a Buffer in tests). */
export interface FileSource {
  size: number;
  readChunk(offset: number, length: number): Promise<Uint8Array>;
  /** SHA-256 of the whole file as lowercase hex. */
  sha256(): Promise<string>;
}

export const SIMPLE_MAX_BYTES = 4 * 1024 * 1024; // above this (or on a slow link) use the resumable path
export const CHUNK_NORMAL = 1024 * 1024;
export const CHUNK_LOW_BANDWIDTH = 256 * 1024;
const HASH_SLICE = 1024 * 1024;

export function bytesSource(bytes: Uint8Array): FileSource {
  return {
    size: bytes.length,
    readChunk: async (o, l) => bytes.subarray(o, o + l),
    sha256: async () => {
      const h = new Sha256();
      for (let o = 0; o < bytes.length; o += HASH_SLICE)
        h.update(bytes.subarray(o, o + HASH_SLICE));
      return h.digestHex();
    },
  };
}

/** Expo file (file:// or content:// URI) source. Hashing streams in 1 MB slices, so memory stays flat for big videos. */
export async function expoFileSource(uri: string): Promise<FileSource> {
  const { File } = await import('expo-file-system');
  const file = new File(uri);
  const size = file.size;
  return {
    size,
    async readChunk(offset, length) {
      const h = file.open();
      try {
        h.offset = offset;
        return h.readBytes(length);
      } finally {
        h.close();
      }
    },
    async sha256() {
      if (size <= 16 * 1024 * 1024) return sha256Hex(await file.bytes());
      const h = file.open();
      const hasher = new Sha256();
      try {
        h.offset = 0;
        for (let read = 0; read < size; read += HASH_SLICE)
          hasher.update(h.readBytes(Math.min(HASH_SLICE, size - read)));
      } finally {
        h.close();
      }
      return hasher.digestHex();
    },
  };
}

export const kindOf = (mime: string): 'image' | 'video' | 'audio' | 'file' =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'file';

export interface UploadOptions {
  lowBandwidth?: boolean;
  altText?: string;
  purpose?: 'attachment' | 'public';
  signal?: AbortSignal;
  /** Continue a previously started resumable upload (persisted by the caller through `onSession`). */
  resumeId?: string | undefined;
  onSession?: (uploadId: string) => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  source?: FileSource;
  chunkBytes?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Force a path (tests, or a caller that knows better). */
  mode?: 'simple' | 'resumable';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Upload one file. Small files on a good link use a single multipart request (`POST /v1/media`); large files or
 * low-bandwidth mode use the resumable chunked protocol (`/v1/media/uploads`): each chunk is checksummed, retried with
 * backoff, and an interrupted upload continues from the chunks the server already has.
 */
export async function uploadMedia(
  api: MobileApi,
  file: UploadFile,
  o: UploadOptions = {},
): Promise<MediaView> {
  const knownSize = o.source?.size ?? file.size ?? file.blob?.size;
  const wantResumable =
    o.mode === 'resumable' ||
    (o.mode !== 'simple' &&
      (o.resumeId !== undefined ||
        o.lowBandwidth === true ||
        (knownSize !== undefined && knownSize > SIMPLE_MAX_BYTES)));
  if (!wantResumable) {
    o.onProgress?.(0, knownSize ?? 0);
    const m = await api.media.upload(file, {
      ...(o.altText ? { altText: o.altText } : {}),
      ...(o.purpose ? { purpose: o.purpose } : {}),
      signal: o.signal,
    });
    o.onProgress?.(knownSize ?? m.sizeBytes, knownSize ?? m.sizeBytes);
    return m;
  }

  const source = o.source ?? (await expoFileSource(file.uri));
  const sleep = o.sleep ?? defaultSleep;
  const maxAttempts = o.maxAttempts ?? 5;
  const { size } = source;
  let uploadId = o.resumeId;
  let chunkSize = 0;
  let missing: number[] = [];

  if (uploadId) {
    try {
      const st = await api.media.uploadStatus(uploadId, { signal: o.signal });
      if (st.status !== 'pending') return await api.media.get(uploadId);
      if (st.expired || !st.chunkSize) uploadId = undefined;
      else {
        chunkSize = st.chunkSize;
        missing = st.missing;
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) uploadId = undefined;
      else throw e;
    }
  }
  if (!uploadId) {
    const init = await api.media.initUpload(
      {
        kind: kindOf(file.mimeType),
        size,
        sha256: await source.sha256(),
        contentType: file.mimeType,
        chunkSize: o.chunkBytes ?? (o.lowBandwidth ? CHUNK_LOW_BANDWIDTH : CHUNK_NORMAL),
        ...(o.altText ? { altText: o.altText } : {}),
        ...(o.purpose ? { purpose: o.purpose } : {}),
      },
      { signal: o.signal },
    );
    uploadId = init.id;
    chunkSize = init.chunkSize!;
    missing = Array.from({ length: init.chunkCount! }, (_, i) => i);
    o.onSession?.(uploadId);
  }

  const total = size;
  const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
  let sent = Math.min(total, (chunkCount - missing.length) * chunkSize);
  o.onProgress?.(sent, total);
  for (const n of missing) {
    const offset = n * chunkSize;
    const bytes = await source.readChunk(offset, Math.min(chunkSize, size - offset));
    const sum = await sha256Hex(bytes);
    for (let attempt = 1; ; attempt++) {
      try {
        await api.media.putChunk(uploadId, n, bytes, sum, { signal: o.signal });
        break;
      } catch (e) {
        const retryable = e instanceof ApiError && e.retryable;
        if (!retryable || attempt >= maxAttempts || o.signal?.aborted) throw e;
        await sleep(Math.min(15_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
      }
    }
    sent += bytes.length;
    o.onProgress?.(Math.min(sent, total), total);
  }
  return api.media.complete(uploadId, { signal: o.signal });
}
