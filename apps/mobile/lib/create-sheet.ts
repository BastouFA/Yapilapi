import type { Picked } from './media';

/** 'yap': a voice post, recorded in Create itself (the camera only switches over to it). */
export type CreateMode = 'yap' | 'post' | 'reel' | 'story';
/** What the camera takes photos and videos for. */
export type CameraMode = Exclude<CreateMode, 'yap'>;
type Pending = { asset: Picked; mode: CameraMode };

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
export function deliverPendingAsset(asset: Picked, mode: CameraMode) {
  pending = { asset, mode };
  listeners.forEach((l) => l());
}

export const createModeFrom = (mode: unknown): CreateMode | null => (mode === 'yap' || mode === 'post' || mode === 'reel' || mode === 'story' ? mode : null);

/**
 * A video recorded in the camera for an echo (the camera opened with `echo=<reel id>`), handed back
 * to the Echo screen rather than to Create.
 */
let pendingEcho: { postId: string; asset: Picked } | null = null;
const echoListeners = new Set<() => void>();

export function deliverEchoAsset(postId: string, asset: Picked) {
  pendingEcho = { postId, asset };
  echoListeners.forEach((l) => l());
}

/** The video recorded for an echo of `postId`, once. */
export function takeEchoAsset(postId: string): Picked | null {
  if (pendingEcho?.postId !== postId) return null;
  const a = pendingEcho.asset;
  pendingEcho = null;
  return a;
}

export function onEchoAsset(fn: () => void): () => void {
  echoListeners.add(fn);
  return () => void echoListeners.delete(fn);
}
