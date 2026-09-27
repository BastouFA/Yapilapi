import { dataSaverActive, DATA_SAVER_MODES, DATA_SAVER_UPLOAD, fitWithin, type ConnectionHints, type DataSaverMode } from '@yapilapi/shared';

/**
 * Data saver on the web.
 *
 * The account's setting (Me.dataSaver) follows the person across devices; this
 * browser can override it (kept in localStorage, never sent). Automatic turns
 * on when the browser asks to save data (Save-Data, navigator.connection.saveData)
 * or the connection is 2G or 3G.
 */

/** This browser's choice: 'account' follows the account's setting. */
export type DeviceDataSaver = 'account' | DataSaverMode;
const DEVICE_KEY = 'yp.dataSaver.device';

export function readDeviceDataSaver(): DeviceDataSaver {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    return v && (DATA_SAVER_MODES as readonly string[]).includes(v) ? (v as DataSaverMode) : 'account';
  } catch {
    return 'account';
  }
}

export function writeDeviceDataSaver(v: DeviceDataSaver) {
  try {
    if (v === 'account') localStorage.removeItem(DEVICE_KEY);
    else localStorage.setItem(DEVICE_KEY, v);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

interface NetworkInformationLike extends EventTarget {
  saveData?: boolean;
  effectiveType?: string;
}

function connection(): NetworkInformationLike | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
}

/** What this browser says about its connection (Chrome, Edge and Android browsers; others say nothing). */
export function connectionHints(): ConnectionHints {
  const c = connection();
  return { saveData: !!c?.saveData, effectiveType: c?.effectiveType ?? null };
}

/** Call `fn` when the connection changes; returns a function that stops listening. */
export function onConnectionChange(fn: () => void): () => void {
  const c = connection();
  c?.addEventListener?.('change', fn);
  return () => c?.removeEventListener?.('change', fn);
}

export function effectiveMode(account: DataSaverMode | undefined, device: DeviceDataSaver): DataSaverMode {
  return device === 'account' ? (account ?? 'auto') : device;
}

// Read by the API client for every request: on Data saver it asks for lite responses.
let active = false;
export function setDataSaverActive(on: boolean) {
  active = on;
}
export function dataSaverHeaders(): Record<string, string> {
  return active ? { 'save-data': 'on' } : {};
}
export function isDataSaverActive() {
  return active;
}
export { dataSaverActive };

// ── Data used this session ────────────────────────────────────────────────
/**
 * An estimate of the bytes of photos, videos and other media loaded since the
 * page opened, from the browser's resource timing. Media from another origin
 * counts only when it allows timing (the API's /media does).
 */
let sessionBytes = 0;
let observing = false;
const listeners = new Set<(bytes: number) => void>();

/** Photos, videos, stream segments, audio and captions: from YAPILAPI's /media, or anything with a media file name. */
function isMedia(e: PerformanceResourceTiming) {
  return /\/media\//.test(e.name) || /\.(webp|jpe?g|png|gif|avif|mp4|m3u8|ts|m4a|mp3|vtt)(\?|$)/i.test(e.name);
}

function count(entries: PerformanceEntryList) {
  let added = 0;
  // transferSize is what came over the network: 0 for files served from the browser's cache, which cost no data.
  for (const e of entries as PerformanceResourceTiming[]) if (isMedia(e) && e.transferSize > 0) added += e.transferSize;
  if (!added) return;
  sessionBytes += added;
  for (const l of listeners) l(sessionBytes);
}

export function startMeasuringData() {
  if (observing || typeof PerformanceObserver === 'undefined') return;
  observing = true;
  try {
    const po = new PerformanceObserver((list) => count(list.getEntries()));
    po.observe({ type: 'resource', buffered: true });
  } catch {
    observing = false;
  }
}

export function onSessionBytes(fn: (bytes: number) => void): () => void {
  listeners.add(fn);
  fn(sessionBytes);
  return () => void listeners.delete(fn);
}

// ── Uploads ──────────────────────────────────────────────────────────────
/**
 * On Data saver, photos are made smaller in the browser before they upload:
 * the longest side at most 1600 pixels, as JPEG (or WebP when the original has
 * transparency) at quality 0.8. GIFs keep their animation and are left alone,
 * as is anything the browser can't decode or that is already small.
 */
export async function shrinkPhotoForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file; // HEIC and other formats the browser can't read: the server converts them.
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, DATA_SAVER_UPLOAD.maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const type = file.type === 'image/png' || file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, DATA_SAVER_UPLOAD.quality));
    // Keep the original when it is already smaller (a small, well-compressed photo).
    if (!blob || blob.size >= file.size) return file;
    const ext = type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + `.${ext}`, { type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

/** Shrink a photo when Data saver is on; anything else is returned as is. */
export function prepareUpload(file: File): Promise<File> {
  return active ? shrinkPhotoForUpload(file) : Promise.resolve(file);
}
