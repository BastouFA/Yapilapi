import { describe, expect, it } from 'vitest';
import { copyableMedia } from './forwarding.ts';
import type { Message } from './types.ts';

const message = (o: Partial<Message>): Message =>
  ({ id: 'm', conversationId: 'c', body: '', replyToId: null, attachments: [], createdAt: '2026-11-02T00:00:00Z', sender: { id: 'u' }, ...o }) as Message;
const file = (kind: string, more = {}) => ({ kind, mediaId: 'f', url: '/f', ...more }) as Message['attachments'][number];

describe('copyableMedia', () => {
  it('finds a voice message or a video, with its length', () => {
    expect(copyableMedia(message({ attachments: [file('audio', { durationMs: 4000 })] }))).toEqual({ kind: 'voice', durationMs: 4000 });
    expect(copyableMedia(message({ attachments: [file('video')] }))).toEqual({ kind: 'video', durationMs: null });
  });

  it('leaves out photos and words: those go through the real clipboard', () => {
    expect(copyableMedia(message({ attachments: [file('image')] }))).toBeUndefined();
    expect(copyableMedia(message({ body: 'hello' }))).toBeUndefined();
  });

  it('never offers a message that is meant to go or is gone', () => {
    const video = [file('video')];
    expect(copyableMedia(message({ attachments: video, viewOnce: { state: 'unopened' } as unknown as Message['viewOnce'] }))).toBeUndefined();
    expect(copyableMedia(message({ attachments: video, expiresAt: '2026-11-03T00:00:00Z' }))).toBeUndefined();
    expect(copyableMedia(message({ attachments: video, unsent: true }))).toBeUndefined();
    expect(copyableMedia(message({ attachments: [file('video', { removed: true })] }))).toBeUndefined();
  });
});
