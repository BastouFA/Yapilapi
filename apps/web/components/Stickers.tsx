'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { BottomSheet, Button, Checkbox, Icon } from '@yapilapi/design-system';
import { IMAGE_ACCEPT, STICKER_CAPTION_MAX, STICKER_SIZE, type Message, type Sticker } from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';

// ── Your stickers ─────────────────────────────────────────────────────────
// Loaded once per page and shared: the Stickers tab lists them, and a sticker someone sent says
// "In your stickers" when it's already one of yours.
let mine: Sticker[] | null = null;
let failed = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
function load(again = false) {
  if (loading || (mine && !again)) return;
  failed = false;
  changed();
  loading = api.stickers.list().then(
    (r) => {
      mine = r.items;
      loading = null;
      changed();
    },
    () => {
      failed = true;
      loading = null;
      changed();
    },
  );
}
function keep(s: Sticker) {
  mine = [s, ...(mine ?? []).filter((x) => x.id !== s.id)];
  changed();
}
function drop(id: string) {
  mine = (mine ?? []).filter((x) => x.id !== id);
  changed();
}

/** Your stickers, newest first (null while they load), and whether loading them failed. */
export function useMyStickers(): { items: Sticker[] | null; failed: boolean; retry: () => void } {
  useEffect(() => load(), []);
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (failed ? 'failed' : mine),
    () => null,
  );
  return { items: snapshot === 'failed' ? null : snapshot, failed: snapshot === 'failed', retry: () => load(true) };
}

/** Whether a photo someone sent (an attachment's mediaId) is already one of your stickers. */
const isMine = (items: Sticker[] | null, mediaId: string | undefined) => !!mediaId && !!items?.some((s) => s.media.id === mediaId || s.fromMediaId === mediaId);

/**
 * The Stickers tab beside the emojis: "Make a sticker" first, then your stickers, newest first.
 * Tapping one sends it (onPick). "Remove stickers" turns each into a remove button; a right-click
 * or long press on one does too.
 */
export function StickerPicker({ onPick, onMake }: { onPick: (s: Sticker) => void; onMake: () => void }) {
  const { t, toast } = useSession();
  const { items, failed, retry } = useMyStickers();
  const [removing, setRemoving] = useState(false);

  async function remove(s: Sticker) {
    try {
      await api.stickers.remove(s.id);
      drop(s.id);
      toast(t('sticker.removed'));
      if ((mine ?? []).length === 0) setRemoving(false);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <div className="sticker-panel">
      <div className="sticker-panel__body">
        {failed ? (
          <p className="gif-panel__note" role="status">
            {t('sticker.error')}{' '}
            <Button size="sm" variant="ghost" onClick={retry}>
              {t('m.common.retry')}
            </Button>
          </p>
        ) : (
          <div className="sticker-panel__grid">
            <button type="button" className="sticker-panel__make" onClick={onMake}>
              <Icon name="plus" size={24} />
              <span>{t('sticker.make')}</span>
            </button>
            {(items ?? []).map((s, i) =>
              removing ? (
                <button
                  key={s.id}
                  type="button"
                  className="sticker-panel__sticker sticker-panel__sticker--remove"
                  aria-label={t('sticker.remove', { n: i + 1 })}
                  onClick={() => void remove(s)}
                >
                  <img src={s.media.url} alt="" loading="lazy" decoding="async" />
                  <span className="sticker-panel__x" aria-hidden>
                    <Icon name="x" size={16} />
                  </span>
                </button>
              ) : (
                <button
                  key={s.id}
                  type="button"
                  className="sticker-panel__sticker"
                  aria-label={t('sticker.send', { n: i + 1 })}
                  onClick={() => onPick(s)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRemoving(true);
                  }}
                >
                  <img src={s.media.url} alt="" loading="lazy" decoding="async" />
                </button>
              ),
            )}
          </div>
        )}
        {items && !items.length ? (
          <p className="gif-panel__note" role="status">
            {t('sticker.empty')}
          </p>
        ) : null}
      </div>
      {items?.length ? (
        <div className="sticker-panel__foot">
          <Button size="sm" variant="ghost" icon={removing ? 'check' : 'trash'} aria-pressed={removing} onClick={() => setRemoving((r) => !r)}>
            {removing ? t('m.common.done') : t('sticker.manage')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A sticker in a chat: the picture on its own, with no bubble. Someone else's opens a small sheet
 * to add it to your stickers.
 */
export function StickerMessage({ message, mine: own }: { message: Message; mine: boolean }) {
  const { t, toast, locale } = useSession();
  const a = message.attachments[0]!;
  const { items } = useMyStickers();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const have = isMine(items, a.mediaId);
  const img = <img src={a.url} alt={t('sticker.preview')} className="chat-sticker__img" loading="lazy" decoding="async" />;
  if (own) return <span className="chat-sticker">{img}</span>;

  async function save() {
    setSaving(true);
    try {
      keep((await api.stickers.save(message.id)).sticker);
      toast(t('sticker.added'));
      setOpen(false);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" className="chat-sticker chat-sticker--button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {img}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t('sticker.preview')} locale={locale}>
        <div className="sticker-view">
          <img src={a.url} alt={t('sticker.preview')} className="sticker-view__img" />
          {have ? (
            <p className="sticker-view__have" role="status">
              <Icon name="check" size={18} /> {t('sticker.have')}
            </p>
          ) : (
            <Button icon="plus" block loading={saving} onClick={() => void save()}>
              {t('sticker.add')}
            </Button>
          )}
        </div>
      </BottomSheet>
    </>
  );
}

/** "Add to my stickers" for a message's menu: undefined when it's not a sticker someone else sent, or it's already yours. */
export function useSaveSticker() {
  const { t, toast } = useSession();
  const { items } = useMyStickers();
  return (m: Message, own: boolean) => {
    const a = m.attachments[0];
    if (!m.sticker || own || m.unsent || !a || a.removed || isMine(items, a.mediaId)) return undefined;
    return async () => {
      try {
        keep((await api.stickers.save(m.id)).sticker);
        toast(t('sticker.added'));
      } catch (e) {
        toast(errorMessage(e));
      }
    };
  };
}

// ── The sticker maker ─────────────────────────────────────────────────────
type Shape = 'circle' | 'rounded' | 'whole';
interface Look {
  shape: Shape;
  zoom: number;
  /** Where the photo is moved to, in sticker pixels (0 to STICKER_SIZE). */
  x: number;
  y: number;
  caption: string;
  outline: boolean;
}
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
/** Room around the shape for the white outline. */
const PAD = 22;

/** A GIF with more than one frame, or a WebP marked animated: these can be kept as they are, still moving. */
async function isAnimated(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  const ascii = (from: number, n: number) => String.fromCharCode(...head.slice(from, from + n));
  if (ascii(0, 4) === 'GIF8') {
    // A graphic control extension (21 F9 04) comes before each frame.
    let frames = 0;
    for (let i = 0; i < head.length - 2 && frames < 2; i++) if (head[i] === 0x21 && head[i + 1] === 0xf9 && head[i + 2] === 0x04) frames++;
    return frames > 1;
  }
  return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && ascii(12, 4) === 'VP8X' && ((head[20] ?? 0) & 0x02) !== 0;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    img.src = url;
  });
}

function shapePath(c: CanvasRenderingContext2D, shape: Shape, box: { x: number; y: number; w: number; h: number }) {
  c.beginPath();
  if (shape === 'circle') c.arc(box.x + box.w / 2, box.y + box.h / 2, Math.min(box.w, box.h) / 2, 0, Math.PI * 2);
  else if (shape === 'rounded') c.roundRect(box.x, box.y, box.w, box.h, box.w * 0.22);
  else c.rect(box.x, box.y, box.w, box.h);
}

/** Words on one or two lines, as big as they fit (bold white with a dark edge, like a meme). */
function drawCaption(c: CanvasRenderingContext2D, text: string, size: number) {
  const words = text.trim();
  if (!words) return;
  const max = size - PAD * 2 - 24;
  let font = 64;
  let lines = [words];
  const font$ = (px: number) => `800 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  for (; font >= 30; font -= 4) {
    c.font = font$(font);
    if (c.measureText(words).width <= max) {
      lines = [words];
      break;
    }
    // Two lines, split at the space nearest the middle.
    const spaces = [...words.matchAll(/ /g)].map((m) => m.index!);
    if (spaces.length) {
      const mid = spaces.reduce((a, b) => (Math.abs(b - words.length / 2) < Math.abs(a - words.length / 2) ? b : a));
      const two = [words.slice(0, mid), words.slice(mid + 1)];
      if (two.every((l) => c.measureText(l).width <= max)) {
        lines = two;
        break;
      }
    }
  }
  font = Math.max(font, 30);
  c.font = font$(font);
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(6, font / 6);
  c.strokeStyle = '#141414';
  c.fillStyle = '#ffffff';
  const lineHeight = font * 1.08;
  let y = size - PAD - 22 - (lines.length - 1) * lineHeight;
  for (const line of lines) {
    c.strokeText(line, size / 2, y, max);
    c.fillText(line, size / 2, y, max);
    y += lineHeight;
  }
}

/** Draws the sticker: transparent around the shape, the photo inside it, the outline and the caption. */
function drawSticker(canvas: HTMLCanvasElement, img: HTMLImageElement, look: Look) {
  const size = STICKER_SIZE;
  const c = canvas.getContext('2d');
  if (!c) return;
  c.clearRect(0, 0, size, size);
  const inner = size - PAD * 2;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  // A shape is filled by the photo; the whole photo fits inside the square.
  const base = look.shape === 'whole' ? Math.min(inner / iw, inner / ih) : Math.max(inner / iw, inner / ih);
  const w = iw * base * look.zoom;
  const h = ih * base * look.zoom;
  const px = look.x - w / 2;
  const py = look.y - h / 2;
  let box = { x: PAD, y: PAD, w: inner, h: inner };
  if (look.shape === 'whole') {
    // The part of the photo inside the square, outlined as it is.
    const x0 = Math.max(PAD, px);
    const y0 = Math.max(PAD, py);
    const x1 = Math.min(size - PAD, px + w);
    const y1 = Math.min(size - PAD, py + h);
    box = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
  if (look.outline && box.w > 0 && box.h > 0) {
    c.save();
    shapePath(c, look.shape, box);
    c.shadowColor = 'rgba(0, 0, 0, 0.28)';
    c.shadowBlur = 6;
    c.lineJoin = 'round';
    c.lineWidth = PAD * 1.3;
    c.strokeStyle = '#ffffff';
    c.fillStyle = '#ffffff';
    c.stroke();
    c.fill();
    c.restore();
  }
  c.save();
  shapePath(c, look.shape, box);
  c.clip();
  c.drawImage(img, px, py, w, h);
  c.restore();
  drawCaption(c, look.caption, size);
}

/** The sticker as a file: WebP where the browser can make one (Safari can't, and gives a PNG instead), else PNG. */
async function exportSticker(canvas: HTMLCanvasElement): Promise<File> {
  const blob = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  const webp = await blob('image/webp');
  if (webp?.type === 'image/webp') return new File([webp], 'sticker.webp', { type: 'image/webp' });
  const png = webp?.type === 'image/png' ? webp : await blob('image/png');
  if (!png) throw new Error('export');
  return new File([png], 'sticker.png', { type: 'image/png' });
}

/**
 * Make a sticker from a photo: a shape (circle, rounded square or the whole photo), moved by
 * dragging (or the arrow keys) and zoomed by pinching, the mouse wheel, the slider or + and −,
 * with a caption and a white outline if you like. It's saved as a 512 × 512 picture with a
 * transparent background, uploaded as your photo and added to your stickers. An animated GIF or
 * WebP can also be kept as it is, still moving.
 */
export function StickerMaker({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (s: Sticker) => void }) {
  const { t, toast, locale } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [animated, setAnimated] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const center = STICKER_SIZE / 2;
  const [look, setLook] = useState<Look>({ shape: 'circle', zoom: 1, x: center, y: center, caption: '', outline: true });
  const canvas = useRef<HTMLCanvasElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const ids = { shape: useId(), zoom: useId(), caption: useId(), hint: useId() };

  // A fresh start each time it opens.
  useEffect(() => {
    if (open) return;
    setFile(null);
    setImg(null);
    setAnimated(false);
    setProblem(null);
    setLook({ shape: 'circle', zoom: 1, x: center, y: center, caption: '', outline: true });
  }, [open, center]);
  useEffect(() => () => void (img && URL.revokeObjectURL(img.src)), [img]);
  useEffect(() => {
    if (img && canvas.current) drawSticker(canvas.current, img, look);
  }, [img, look]);

  async function choose(f: File | undefined) {
    if (!f) return;
    setProblem(null);
    try {
      const [image, moving] = await Promise.all([loadImage(f), isAnimated(f).catch(() => false)]);
      setFile(f);
      setImg(image);
      setAnimated(moving);
      setLook((l) => ({ ...l, zoom: 1, x: center, y: center }));
    } catch {
      setProblem(t('sticker.maker.unreadable'));
    }
  }

  async function store(f: File) {
    setSaving(true);
    try {
      const { media } = await api.media.upload(f, t('sticker.preview'));
      const { sticker } = await api.stickers.add(media.id);
      keep(sticker);
      onSaved(sticker);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!canvas.current || !img) return;
    // Drawn again at full size, in case the preview was mid-gesture.
    drawSticker(canvas.current, img, look);
    try {
      await store(await exportSticker(canvas.current));
    } catch {
      setProblem(t('sticker.maker.unreadable'));
    }
  }

  /** Screen pixels to sticker pixels. */
  const scale = () => STICKER_SIZE / (canvas.current?.getBoundingClientRect().width || STICKER_SIZE);
  const move = (dx: number, dy: number) =>
    setLook((l) => ({
      ...l,
      x: Math.min(STICKER_SIZE * 1.5, Math.max(-STICKER_SIZE / 2, l.x + dx)),
      y: Math.min(STICKER_SIZE * 1.5, Math.max(-STICKER_SIZE / 2, l.y + dy)),
    }));
  const zoomBy = (f: number) => setLook((l) => ({ ...l, zoom: clampZoom(l.zoom * f) }));

  function onPointerDown(e: PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: look.zoom };
    }
  }
  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const start = pinch.current;
      if (start.distance > 0) setLook((l) => ({ ...l, zoom: clampZoom((start.zoom * d) / start.distance) }));
      return;
    }
    const k = scale();
    move((e.clientX - last.x) * k, (e.clientY - last.y) * k);
  }
  function onPointerUp(e: PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }
  // The mouse wheel or a trackpad zooms (a listener of its own: React's can't keep the sheet from scrolling).
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      setLook((l) => ({ ...l, zoom: clampZoom(l.zoom * Math.exp(-e.deltaY / 400)) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [img]);
  function onKeyDown(e: KeyboardEvent<HTMLCanvasElement>) {
    const step = e.shiftKey ? 32 : 8;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => move(-step, 0),
      ArrowRight: () => move(step, 0),
      ArrowUp: () => move(0, -step),
      ArrowDown: () => move(0, step),
      '+': () => zoomBy(1.1),
      '=': () => zoomBy(1.1),
      '-': () => zoomBy(1 / 1.1),
      _: () => zoomBy(1 / 1.1),
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  }

  const shapes: { value: Shape; label: string }[] = [
    { value: 'circle', label: t('sticker.maker.circle') },
    { value: 'rounded', label: t('sticker.maker.rounded') },
    { value: 'whole', label: t('sticker.maker.whole') },
  ];

  return (
    <BottomSheet open={open} onClose={onClose} title={t('sticker.make')} locale={locale}>
      <div className="sticker-maker">
        <input
          ref={picker}
          type="file"
          accept={IMAGE_ACCEPT}
          className="sticker-maker__file"
          // Opened by the "Choose a photo" buttons, which are what screen readers and the keyboard reach.
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            void choose(e.currentTarget.files?.[0]);
            e.currentTarget.value = '';
          }}
        />
        {problem ? (
          <p className="sticker-maker__problem" role="alert">
            {problem}
          </p>
        ) : null}
        {!img ? (
          <Button icon="image" block onClick={() => picker.current?.click()}>
            {t('sticker.maker.pick')}
          </Button>
        ) : (
          <>
            <div className="sticker-maker__stage">
              <canvas
                ref={canvas}
                width={STICKER_SIZE}
                height={STICKER_SIZE}
                className="sticker-maker__canvas"
                role="img"
                tabIndex={0}
                aria-label={t('sticker.maker.area')}
                aria-describedby={ids.hint}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={onKeyDown}
              />
            </div>
            <p id={ids.hint} className="sticker-maker__hint">
              {t('sticker.maker.move')}
            </p>
            {animated && file ? (
              <div className="sticker-maker__animated">
                <p>{t('sticker.maker.animated')}</p>
                {/* Kept as it is: the file itself, still moving (the server says when it's over 5 MB). */}
                <Button variant="secondary" loading={saving} onClick={() => void store(file)}>
                  {t('sticker.maker.useAsIs')}
                </Button>
              </div>
            ) : null}
            <fieldset className="sticker-maker__shapes">
              <legend id={ids.shape}>{t('sticker.maker.shape')}</legend>
              {shapes.map((s) => (
                <label key={s.value} className="sticker-maker__shape">
                  <input
                    type="radio"
                    name={ids.shape}
                    value={s.value}
                    checked={look.shape === s.value}
                    onChange={() => setLook((l) => ({ ...l, shape: s.value }))}
                  />
                  <span>{s.label}</span>
                </label>
              ))}
            </fieldset>
            <div className="yp-field">
              <label className="yp-field__label" htmlFor={ids.zoom}>
                {t('sticker.maker.zoom')}
              </label>
              <input
                id={ids.zoom}
                type="range"
                className="sticker-maker__zoom"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={0.05}
                value={look.zoom}
                onChange={(e) => {
                  const zoom = clampZoom(Number(e.currentTarget.value));
                  setLook((l) => ({ ...l, zoom }));
                }}
              />
            </div>
            <div className="yp-field">
              <label className="yp-field__label" htmlFor={ids.caption}>
                {t('sticker.maker.caption')}
              </label>
              <input
                id={ids.caption}
                className="yp-input"
                value={look.caption}
                maxLength={STICKER_CAPTION_MAX}
                enterKeyHint="done"
                onChange={(e) => {
                  const caption = e.currentTarget.value.slice(0, STICKER_CAPTION_MAX);
                  setLook((l) => ({ ...l, caption }));
                }}
              />
            </div>
            <Checkbox
              label={t('sticker.maker.outline')}
              checked={look.outline}
              onChange={(e) => {
                const outline = e.currentTarget.checked;
                setLook((l) => ({ ...l, outline }));
              }}
            />
            <div className="sticker-maker__actions">
              <Button variant="ghost" icon="image" onClick={() => picker.current?.click()}>
                {t('sticker.maker.another')}
              </Button>
              <Button icon="check" loading={saving} onClick={() => void save()}>
                {t('sticker.maker.save')}
              </Button>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
