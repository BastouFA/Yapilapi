'use client';

import { dualInsetBox, type DualCorner } from '@yapilapi/shared';

/** Largest edge of a "Both sides" photo, like the photo editor's limit on the server. */
const MAX_EDGE = 4096;

/** The camera's current frame, the right way round (the front camera preview is mirrored; photos aren't). */
export function grabFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d')!.drawImage(video, 0, 0);
  return c;
}

export const canvasBlob = (c: HTMLCanvasElement, quality = 0.92) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('empty'))), 'image/jpeg', quality));

/**
 * Draw a "Both sides" photo: the back camera photo with the front camera photo in a rounded,
 * white-edged corner. Uses the same layout as the API (dualInsetBox), so the preview, this and
 * the server's version all match.
 */
export async function composeDual(back: HTMLCanvasElement, front: HTMLCanvasElement, corner: DualCorner): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(back.width, back.height));
  const width = Math.round(back.width * scale);
  const height = Math.round(back.height * scale);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  g.drawImage(back, 0, 0, width, height);
  const box = dualInsetBox(width, height, front.width, front.height, corner);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(box.left, box.top, box.width, box.height, box.radius);
  g.fill();
  const x = box.left + box.border;
  const y = box.top + box.border;
  const w = box.width - 2 * box.border;
  const h = box.height - 2 * box.border;
  g.save();
  g.beginPath();
  g.roundRect(x, y, w, h, Math.max(0, box.radius - box.border));
  g.clip();
  // Fill the box, cropping the front photo's edges (like object-fit: cover).
  const s = Math.max(w / front.width, h / front.height);
  const sw = w / s;
  const sh = h / s;
  g.drawImage(front, (front.width - sw) / 2, (front.height - sh) / 2, sw, sh, x, y, w, h);
  g.restore();
  return canvasBlob(c);
}
