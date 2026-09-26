'use client';

import { MEDIA_ACCEPT } from '@yapilapi/shared';

export type CreateMode = 'post' | 'reel' | 'story';
type Pending = { files: File[]; mode: CreateMode };

let pending: Pending | null = null;
const EVENT = 'yp:pending-media';

/**
 * Open the system photo and video chooser right away, from the tap on "+" itself (browsers only open it
 * during a tap). On phones that chooser also offers the camera. What's picked is handed to the Create
 * page, which is opened at the same time, so it arrives with the files ready to edit. Cancelling just
 * leaves you on Create to write a text post.
 */
export function pickMediaForCreate(mode: CreateMode = 'post') {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = MEDIA_ACCEPT;
  input.multiple = mode === 'post';
  // Some mobile browsers only report the choice for inputs that are in the page.
  input.style.display = 'none';
  document.body.appendChild(input);
  const done = () => input.remove();
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    done();
    if (!files.length) return;
    pending = { files, mode };
    window.dispatchEvent(new Event(EVENT));
  });
  input.addEventListener('cancel', done);
  input.click();
}

/** Files picked from "+", once. */
export function takePendingMedia(): Pending | null {
  const p = pending;
  pending = null;
  return p;
}

/** Call `fn` whenever files are picked from "+" (the Create page may already be open). */
export function onPendingMedia(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
