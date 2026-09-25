import { createHash } from 'crypto';
import { ApiError } from '@yapilapi/api-client';
import type { MobileApi, MediaView } from '../src/api';
import { uploadMedia, bytesSource, kindOf, CHUNK_LOW_BANDWIDTH } from '../src/media/upload';
import { Sha256 } from '../src/lib/sha256';

const media = (id = 'm1'): MediaView => ({
  id,
  kind: 'image',
  status: 'ready',
  mimeType: 'image/jpeg',
  sizeBytes: 1,
  url: 'https://cdn/x.jpg',
  width: 1,
  height: 1,
  durationMs: null,
  blurhash: null,
  altText: null,
  needsAltText: false,
  variants: [],
});
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const file = { uri: 'file:///x.jpg', name: 'x.jpg', mimeType: 'image/jpeg' };
const noSleep = async () => undefined;

function fakeApi(over: Partial<Record<keyof MobileApi['media'], jest.Mock>> = {}) {
  const m = {
    upload: jest.fn(async () => media('simple')),
    initUpload: jest.fn(async (i: { size: number; chunkSize?: number }) => ({
      id: 'u1',
      mode: 'chunked',
      status: 'pending',
      size: i.size,
      expiresAt: 'x',
      chunkSize: i.chunkSize ?? 4,
      chunkCount: Math.ceil(i.size / (i.chunkSize ?? 4)),
    })),
    uploadStatus: jest.fn(),
    putChunk: jest.fn(async () => ({
      index: 0,
      duplicate: false,
      receivedCount: 1,
      chunkCount: 1,
      complete: false,
    })),
    complete: jest.fn(async () => media('done')),
    get: jest.fn(async () => media('existing')),
    ...over,
  };
  return { api: { media: m } as unknown as MobileApi, m };
}

describe('Sha256', () => {
  it('matches node for empty, short, block-boundary and multi-block input, incrementally', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 200, 5000]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
      const h = new Sha256();
      h.update(b.subarray(0, Math.floor(n / 3)));
      h.update(b.subarray(Math.floor(n / 3)));
      expect(h.digestHex()).toBe(sha(b));
    }
  });
});

describe('uploadMedia', () => {
  it('uses one multipart request for a small file on a normal link', async () => {
    const { api, m } = fakeApi();
    const out = await uploadMedia(api, { ...file, size: 1000 }, { altText: 'a dog' });
    expect(out.id).toBe('simple');
    expect(m.upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ altText: 'a dog' }),
    );
    expect(m.initUpload).not.toHaveBeenCalled();
  });

  it('uses the resumable path for big files and for low-bandwidth mode, with smaller chunks', async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
    const a = fakeApi();
    await uploadMedia(a.api, file, {
      mode: 'resumable',
      source: bytesSource(bytes),
      chunkBytes: 4,
      sleep: noSleep,
    });
    expect(a.m.initUpload).toHaveBeenCalledWith(
      expect.objectContaining({ size: 10, sha256: sha(bytes), chunkSize: 4, kind: 'image' }),
      expect.anything(),
    );
    expect(a.m.putChunk).toHaveBeenCalledTimes(3);
    expect(a.m.complete).toHaveBeenCalledWith('u1', expect.anything());

    const b = fakeApi();
    await uploadMedia(b.api, file, {
      lowBandwidth: true,
      source: bytesSource(bytes),
      sleep: noSleep,
    });
    expect(b.m.initUpload.mock.calls[0]![0].chunkSize).toBe(CHUNK_LOW_BANDWIDTH);
    expect(b.m.upload).not.toHaveBeenCalled();
  });

  it('sends each chunk in order with its own checksum', async () => {
    const bytes = Uint8Array.from({ length: 9 }, (_, i) => i + 1);
    const { api, m } = fakeApi();
    const progress: number[] = [];
    await uploadMedia(api, file, {
      mode: 'resumable',
      source: bytesSource(bytes),
      chunkBytes: 4,
      sleep: noSleep,
      onProgress: (s) => progress.push(s),
    });
    const calls = m.putChunk.mock.calls;
    expect(calls.map((c) => c[1])).toEqual([0, 1, 2]);
    expect(calls[1]![3]).toBe(sha(bytes.subarray(4, 8)));
    expect(Array.from(calls[2]![2] as Uint8Array)).toEqual([9]);
    expect(progress[progress.length - 1]).toBe(9);
  });

  it('retries a failed chunk with backoff, but not a permanent error', async () => {
    const bytes = new Uint8Array(4).fill(1);
    let n = 0;
    const flaky = jest.fn(async () => {
      if (n++ < 2) throw new ApiError('network_error', 'x', 0);
      return { index: 0, duplicate: false, receivedCount: 1, chunkCount: 1, complete: true };
    });
    const a = fakeApi({ putChunk: flaky });
    await uploadMedia(a.api, file, {
      mode: 'resumable',
      source: bytesSource(bytes),
      chunkBytes: 4,
      sleep: noSleep,
    });
    expect(flaky).toHaveBeenCalledTimes(3);

    const bad = fakeApi({
      putChunk: jest.fn(async () => {
        throw new ApiError('validation_failed', 'bad checksum', 422);
      }),
    });
    await expect(
      uploadMedia(bad.api, file, {
        mode: 'resumable',
        source: bytesSource(bytes),
        chunkBytes: 4,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(bad.m.putChunk).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts on a dead link', async () => {
    const dead = fakeApi({
      putChunk: jest.fn(async () => {
        throw new ApiError('network_error', 'x', 0);
      }),
    });
    await expect(
      uploadMedia(dead.api, file, {
        mode: 'resumable',
        source: bytesSource(new Uint8Array(4)),
        chunkBytes: 4,
        maxAttempts: 3,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(dead.m.putChunk).toHaveBeenCalledTimes(3);
  });

  it('resumes: only the chunks the server is missing are sent, and no new session is created', async () => {
    const bytes = Uint8Array.from({ length: 12 }, (_, i) => i);
    const { api, m } = fakeApi({
      uploadStatus: jest.fn(async () => ({
        id: 'u1',
        status: 'pending',
        mode: 'chunked',
        size: 12,
        chunkSize: 4,
        chunkCount: 3,
        received: [0, 2],
        missing: [1],
        expiresAt: 'x',
        expired: false,
      })),
    });
    await uploadMedia(api, file, { resumeId: 'u1', source: bytesSource(bytes), sleep: noSleep });
    expect(m.initUpload).not.toHaveBeenCalled();
    expect(m.putChunk.mock.calls.map((c) => c[1])).toEqual([1]);
    expect(m.complete).toHaveBeenCalled();
  });

  it('starts over when the old session has expired or is gone; returns the media if it already completed', async () => {
    const bytes = new Uint8Array(4);
    const expired = fakeApi({
      uploadStatus: jest.fn(async () => ({
        id: 'u1',
        status: 'pending',
        mode: 'chunked',
        size: 4,
        chunkSize: 4,
        chunkCount: 1,
        received: [],
        missing: [0],
        expiresAt: 'x',
        expired: true,
      })),
    });
    await uploadMedia(expired.api, file, {
      resumeId: 'old',
      source: bytesSource(bytes),
      chunkBytes: 4,
      sleep: noSleep,
    });
    expect(expired.m.initUpload).toHaveBeenCalled();

    const gone = fakeApi({
      uploadStatus: jest.fn(async () => {
        throw new ApiError('not_found', 'x', 404);
      }),
    });
    await uploadMedia(gone.api, file, {
      resumeId: 'old',
      source: bytesSource(bytes),
      chunkBytes: 4,
      sleep: noSleep,
    });
    expect(gone.m.initUpload).toHaveBeenCalled();

    const finished = fakeApi({
      uploadStatus: jest.fn(async () => ({
        id: 'u1',
        status: 'ready',
        mode: 'chunked',
        size: 4,
        chunkSize: 4,
        chunkCount: 1,
        received: [0],
        missing: [],
        expiresAt: null,
        expired: false,
      })),
    });
    const out = await uploadMedia(finished.api, file, {
      resumeId: 'u1',
      source: bytesSource(bytes),
      sleep: noSleep,
    });
    expect(out.id).toBe('existing');
    expect(finished.m.putChunk).not.toHaveBeenCalled();
  });

  it('reports the new session id so the outbox can persist it', async () => {
    const ids: string[] = [];
    const { api } = fakeApi();
    await uploadMedia(api, file, {
      mode: 'resumable',
      source: bytesSource(new Uint8Array(4)),
      chunkBytes: 4,
      sleep: noSleep,
      onSession: (i) => ids.push(i),
    });
    expect(ids).toEqual(['u1']);
  });

  it('classifies mime types', () => {
    expect([
      kindOf('image/png'),
      kindOf('video/mp4'),
      kindOf('audio/mpeg'),
      kindOf('application/pdf'),
    ]).toEqual(['image', 'video', 'audio', 'file']);
  });
});
