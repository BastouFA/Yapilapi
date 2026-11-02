import type { Message } from './types.ts';

/**
 * Whether a message can go on to another chat: words or files someone can see. Never a view-once or
 * disappearing one (meant to go), one held for review, or a card that only means something here.
 */
export function canForward(m: Message & { pending?: boolean }): boolean {
  if (m.pending || m.unsent || m.moderation || m.viewOnce || m.expiresAt || m.kind === 'system') return false;
  if (m.story || m.storyReply || m.location || m.market || m.offer) return false;
  return !!m.body || !!m.attachments?.some((a) => a.mediaId && !a.removed);
}

/**
 * The voice message or video in a message, when it can be copied to paste into another chat.
 * Clipboards don't take either, so the app keeps which message it was and pasting sends it on.
 */
export function copyableMedia(m: Message & { pending?: boolean }): { kind: 'voice' | 'video'; durationMs: number | null } | undefined {
  if (!canForward(m)) return undefined;
  const a = m.attachments?.find((x) => (x.kind === 'audio' || x.kind === 'video') && x.mediaId && !x.removed);
  return a ? { kind: a.kind === 'video' ? 'video' : 'voice', durationMs: a.durationMs ?? null } : undefined;
}
