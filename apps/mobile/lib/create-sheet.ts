import type { Picked } from './media';

export type CreateMode = 'post' | 'reel' | 'story';
type Pending = { asset: Picked; mode: CreateMode };

let pending: Pending | null = null;
const listeners = new Set<() => void>();

/** What was just taken with the camera or picked from its gallery button, once. */
export function takePendingAsset(): Pending | null {
  const p = pending;
  pending = null;
  return p;
}

/** Call `fn` whenever something is handed over from the camera (Create may already be open). */
export function onPendingAsset(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Hand a photo or video from the camera screen to Create, which switches to `mode`, checks it
 * and opens the editor. Navigate to Create right after.
 */
export function deliverPendingAsset(asset: Picked, mode: CreateMode) {
  pending = { asset, mode };
  listeners.forEach((l) => l());
}

export const createModeFrom = (mode: unknown): CreateMode | null => (mode === 'post' || mode === 'reel' || mode === 'story' ? mode : null);
