import { useSyncExternalStore } from 'react';
import { copyText } from '@/lib/clipboard';

/**
 * A voice message or video copied in a chat, to paste into another. Clipboards don't take them, so
 * it's kept here on this device, and pasting sends the message itself on (POST /v1/messages/:id/forward).
 */
export type CopiedMedia = { messageId: string; kind?: 'voice' | 'video'; durationMs: number | null; at: number };

const KEY = 'ypl.chat.copied';
/** How long something copied waits to be pasted. */
const KEEP_MS = 30 * 60_000;
const listeners = new Set<() => void>();
let raw: string | null = null;
let parsed: CopiedMedia | null = null;

function read(): CopiedMedia | null {
  try {
    const now = localStorage.getItem(KEY);
    if (now !== raw) {
      raw = now;
      parsed = now ? (JSON.parse(now) as CopiedMedia) : null;
    }
  } catch {
    parsed = null;
  }
  return parsed && Date.now() - parsed.at < KEEP_MS ? parsed : null;
}

function save(value: CopiedMedia | null) {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: nothing to paste later */
  }
  listeners.forEach((l) => l());
}

/**
 * Put on the real clipboard in its place, so Paste knows it's still the latest thing copied: anything
 * copied after it (words from another app) replaces this, and Paste then means that instead.
 */
const STAND_IN = { voice: '[YAPILAPI voice message]', video: '[YAPILAPI video]' };
export const isStandIn = (text: string) => text === STAND_IN.voice || text === STAND_IN.video;

export const copyMedia = (messageId: string, kind: 'voice' | 'video', durationMs: number | null) => {
  save({ messageId, kind, durationMs, at: Date.now() });
  void copyText(STAND_IN[kind]);
};
export const clearCopiedMedia = () => save(null);

/** What's waiting to be pasted, in every tab of this browser. */
export function useCopiedMedia(): CopiedMedia | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      window.addEventListener('storage', l);
      return () => {
        listeners.delete(l);
        window.removeEventListener('storage', l);
      };
    },
    read,
    () => null,
  );
}
