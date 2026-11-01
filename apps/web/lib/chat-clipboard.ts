import { useSyncExternalStore } from 'react';

/**
 * A voice message copied in a chat, to paste into another. Clipboards don't take sound, so it's kept
 * here on this device, and pasting sends the message itself on (POST /v1/messages/:id/forward).
 */
export type CopiedVoice = { messageId: string; durationMs: number | null; at: number };

const KEY = 'ypl.chat.copied';
/** How long a copied voice message waits to be pasted. */
const KEEP_MS = 30 * 60_000;
const listeners = new Set<() => void>();
let raw: string | null = null;
let parsed: CopiedVoice | null = null;

function read(): CopiedVoice | null {
  try {
    const now = localStorage.getItem(KEY);
    if (now !== raw) {
      raw = now;
      parsed = now ? (JSON.parse(now) as CopiedVoice) : null;
    }
  } catch {
    parsed = null;
  }
  return parsed && Date.now() - parsed.at < KEEP_MS ? parsed : null;
}

function save(value: CopiedVoice | null) {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: nothing to paste later */
  }
  listeners.forEach((l) => l());
}

export const copyVoice = (messageId: string, durationMs: number | null) => save({ messageId, durationMs, at: Date.now() });
export const clearCopiedVoice = () => save(null);

/** The voice message waiting to be pasted, in every tab of this browser. */
export function useCopiedVoice(): CopiedVoice | null {
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
