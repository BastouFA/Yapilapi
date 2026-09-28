'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Dialog, Segments } from '@yapilapi/design-system';
import {
  cellRect,
  COLLAGE_BACKGROUNDS,
  COLLAGE_GAPS,
  COLLAGE_MAX_ZOOM,
  COLLAGE_RADII,
  COLLAGE_SHAPES,
  COLLAGE_SIZES,
  collageInk,
  collageLayout,
  collageLayoutsFor,
  coverBox,
  defaultCollage,
  dragFocus,
  swapCells,
  withLayout,
  type CollageLayout,
  type CollageShape,
  type CollageSpec,
  type MessageKey,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/** A photo that can go in a collage: one of your uploads. */
export interface CollagePhoto {
  id: string;
  url: string;
}

/** The collage made on the server: used in the post or story like an uploaded photo. */
export interface MadeCollage {
  id: string;
  url: string;
  altText: string | null;
}

interface Loaded {
  src: string;
  width: number;
  height: number;
}

const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A small drawing of a layout for the picker (plain boxes, turned for a scrapbook). */
function LayoutThumb({ layout, shape }: { layout: CollageLayout; shape: CollageShape }) {
  const { width, height } = COLLAGE_SIZES[shape];
  return (
    <span className="collage__thumb" style={{ aspectRatio: `${width} / ${height}` }} aria-hidden>
      {layout.cells.map((c, i) => (
        <span
          key={i}
          style={{
            left: `${c.x * 100}%`,
            top: `${c.y * 100}%`,
            width: `${c.w * 100}%`,
            height: `${c.h * 100}%`,
            transform: c.rotate ? `rotate(${c.rotate}deg)` : undefined,
          }}
        />
      ))}
    </span>
  );
}

/**
 * The collage editor: pick a layout, shape, gap, corners and background; tap a photo then another to
 * swap them; drag a photo (or use the arrow keys) to choose the part that shows, and plus and minus to
 * zoom. The preview is drawn with the same arithmetic as the server (@yapilapi/shared collage.ts),
 * and "Use collage" has it made there (POST /v1/media/collage).
 */
export function CollageEditor({
  photos,
  shape: initialShape = 'square',
  onDone,
  onCancel,
}: {
  photos: CollagePhoto[];
  shape?: CollageShape;
  onDone: (media: MadeCollage) => void;
  onCancel: () => void;
}) {
  const { t, toast } = useSession();
  const [spec, setSpec] = useState<CollageSpec>(() =>
    defaultCollage(
      photos.map((p) => p.id),
      initialShape,
    )!,
  );
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; index: number; x0: number; y0: number; focus: { x: number; y: number }; moved: boolean } | null>(null);
  const dragged = useRef(false);
  // One key per version of the collage: sending the same one again (a retry) gives back the same result.
  const specJson = JSON.stringify(spec);
  const clientKey = useMemo(() => newKey(), [specJson]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server only takes photos its media job has finished with; wait for each, and use its sizes.
  useEffect(() => {
    const stop = new AbortController();
    for (const p of photos)
      api.media.waitUntilProcessed(p.id, { signal: stop.signal }).then(
        (m) =>
          setLoaded((cur) => ({
            ...cur,
            [p.id]: { src: m.variants.large ?? m.variants.medium ?? m.url ?? p.url, width: m.width ?? 1, height: m.height ?? 1 },
          })),
        (e) => {
          if (!stop.signal.aborted) setFailed(errorMessage(e));
        },
      );
    return () => stop.abort();
  }, [photos]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setShown(el.clientWidth));
    ro.observe(el);
    setShown(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const layout = collageLayout(spec.layout)!;
  const size = COLLAGE_SIZES[spec.shape];
  const scale = shown / size.width || 0;
  const ready = photos.every((p) => loaded[p.id]);
  const photoNumber = (mediaId: string) => photos.findIndex((p) => p.id === mediaId) + 1;
  const layouts = collageLayoutsFor(photos.length);

  const setCell = (i: number, change: Partial<CollageSpec['cells'][number]>) =>
    setSpec((s) => ({ ...s, cells: s.cells.map((c, j) => (j === i ? { ...c, ...change } : c)) }));

  function pick(i: number) {
    if (selected === null) return setSelected(i);
    if (selected === i) return setSelected(null);
    setSpec((s) => swapCells(s, selected, i));
    setSaid(t('collage.swapped', { a: selected + 1, b: i + 1 }));
    setSelected(null);
  }

  const onDown = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    const c = spec.cells[i]!;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, index: i, x0: e.clientX, y0: e.clientY, focus: { x: c.focusX, y: c.focusY }, moved: false };
    dragged.current = false;
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || !scale) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    const img = loaded[spec.cells[d.index]!.mediaId];
    if (!img) return;
    const r = cellRect(layout, d.index, size.width, size.height, spec.gap, spec.radius);
    const f = dragFocus(d.focus, dx / scale, dy / scale, img, r, spec.cells[d.index]!.zoom ?? 1);
    setCell(d.index, { focusX: f.x, focusY: f.y });
  };
  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointer !== e.pointerId) return;
    dragged.current = drag.current.moved;
    drag.current = null;
  };

  function zoomBy(i: number, step: number) {
    const z = Math.min(COLLAGE_MAX_ZOOM, Math.max(1, Math.round(((spec.cells[i]!.zoom ?? 1) + step) * 100) / 100));
    setCell(i, { zoom: z });
  }
  const onKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const c = spec.cells[i]!;
    const step = e.shiftKey ? 0.2 : 0.05;
    // Arrow keys move the photo like dragging it: right shows more of its left side.
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      setCell(i, { focusX: clamp01(c.focusX + m[0]), focusY: clamp01(c.focusY + m[1]) });
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(i, 0.25);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomBy(i, -0.25);
    } else if (e.key === 'Escape' && selected !== null) {
      e.preventDefault();
      e.stopPropagation();
      setSelected(null);
    }
  };

  async function use() {
    setBusy(true);
    try {
      const { media } = await api.media.collage({ clientKey, ...spec, altText: t('collage.alt', { count: photos.length }) });
      onDone({ id: media.id, url: media.url, altText: media.altText });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const background = COLLAGE_BACKGROUNDS.find((b) => b.id === spec.background)!;
  const ink = collageInk(spec.background);

  return (
    <Dialog
      open
      onClose={busy ? undefined : onCancel}
      title={t('collage.make')}
      className="collage"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {t('collage.cancel')}
          </Button>
          <Button loading={busy} disabled={!ready || busy} onClick={use}>
            {busy ? t('collage.working') : t('collage.use')}
          </Button>
        </>
      }
    >
      <div className="collage__body">
        <div className="collage__preview">
          <p className="collage__hint">{t('collage.hint')}</p>
          <p className="collage__hint">{t('collage.hintKeys')}</p>
          <div
            ref={stage}
            className="collage__canvas"
            role="group"
            aria-label={t('collage.preview')}
            style={{
              aspectRatio: `${size.width} / ${size.height}`,
              // Tall shapes are narrower, so the whole picture fits on the screen.
              maxWidth: `min(100%, calc((100dvh - 300px) * ${size.width / size.height}))`,
              background: background.hex,
              color: ink,
            }}
          >
            {failed ? (
              <p className="collage__status" role="alert">
                {failed}
              </p>
            ) : !ready ? (
              <p className="collage__status" role="status">
                {t('collage.preparing')}
              </p>
            ) : (
              spec.cells.map((c, i) => {
                const img = loaded[c.mediaId]!;
                const r = cellRect(layout, i, size.width, size.height, spec.gap, spec.radius);
                const fit = coverBox(img.width, img.height, r.width, r.height, c.focusX, c.focusY, c.zoom ?? 1);
                const chosen = selected === i;
                return (
                  <button
                    key={`${i}-${c.mediaId}`}
                    type="button"
                    className={`collage__cell${chosen ? ' collage__cell--chosen' : ''}`}
                    aria-pressed={chosen}
                    aria-label={t(chosen ? 'collage.cellChosen' : 'collage.cell', { cell: i + 1, photo: photoNumber(c.mediaId) })}
                    style={{
                      left: (r.left - r.frame) * scale,
                      top: (r.top - r.frame) * scale,
                      width: (r.width + 2 * r.frame) * scale,
                      height: (r.height + 2 * r.frame) * scale,
                      borderWidth: r.frame * scale,
                      borderRadius: r.radius * scale,
                      transform: r.rotate ? `rotate(${r.rotate}deg)` : undefined,
                      zIndex: chosen ? 2 : 1,
                    }}
                    onClick={() => {
                      if (dragged.current) {
                        dragged.current = false;
                        return;
                      }
                      pick(i);
                    }}
                    onKeyDown={onKey(i)}
                    onPointerDown={onDown(i)}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                  >
                    <span className="collage__photo" style={{ borderRadius: Math.max(0, r.radius - r.frame) * scale }}>
                      <img
                        src={img.src}
                        alt=""
                        draggable={false}
                        style={{ left: fit.left * scale, top: fit.top * scale, width: fit.width * scale, height: fit.height * scale }}
                      />
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="row collage__cell-tools">
            <Button size="sm" variant="secondary" disabled={selected === null} onClick={() => selected !== null && zoomBy(selected, 0.25)}>
              {t('collage.zoomIn')}
            </Button>
            <Button size="sm" variant="secondary" disabled={selected === null} onClick={() => selected !== null && zoomBy(selected, -0.25)}>
              {t('collage.zoomOut')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selected === null}
              onClick={() => selected !== null && setCell(selected, { focusX: 0.5, focusY: 0.5, zoom: 1 })}
            >
              {t('collage.recentre')}
            </Button>
          </div>
          <p className="yp-visually-hidden" role="status" aria-live="polite">
            {said}
          </p>
        </div>

        <div className="collage__controls">
          <fieldset className="collage__group">
            <legend>{t('collage.layouts')}</legend>
            <div className="collage__layouts">
              {layouts.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="collage__layout"
                  aria-pressed={l.id === spec.layout}
                  aria-label={t('collage.layoutLabel', { name: t(l.name) })}
                  title={t(l.name)}
                  onClick={() => setSpec((s) => withLayout(s, l.id))}
                >
                  <LayoutThumb layout={l} shape={spec.shape} />
                </button>
              ))}
            </div>
          </fieldset>
          <div className="collage__group">
            <span className="collage__label">{t('collage.shape')}</span>
            <Segments
              label={t('collage.shape')}
              value={spec.shape}
              onChange={(shape) => setSpec((s) => ({ ...s, shape }))}
              options={COLLAGE_SHAPES.map((id) => ({ id, label: t(`collage.shape.${id}` as MessageKey) }))}
            />
          </div>
          {!layout.scrapbook ? (
            <div className="collage__group">
              <span className="collage__label">{t('collage.gap')}</span>
              <Segments
                label={t('collage.gap')}
                value={spec.gap}
                onChange={(gap) => setSpec((s) => ({ ...s, gap }))}
                options={COLLAGE_GAPS.map((id) => ({ id, label: t(`collage.gap.${id}` as MessageKey) }))}
              />
            </div>
          ) : null}
          <div className="collage__group">
            <span className="collage__label">{t('collage.radius')}</span>
            <Segments
              label={t('collage.radius')}
              value={spec.radius}
              onChange={(radius) => setSpec((s) => ({ ...s, radius }))}
              options={COLLAGE_RADII.map((id) => ({ id, label: t(`collage.radius.${id}` as MessageKey) }))}
            />
          </div>
          <fieldset className="collage__group">
            <legend>{t('collage.background')}</legend>
            <div className="collage__swatches">
              {COLLAGE_BACKGROUNDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="collage__swatch"
                  aria-pressed={b.id === spec.background}
                  aria-label={t('collage.bgLabel', { name: t(`collage.bg.${b.id}` as MessageKey) })}
                  title={t(`collage.bg.${b.id}` as MessageKey)}
                  style={{ background: b.hex, color: collageInk(b.id) }}
                  onClick={() => setSpec((s) => ({ ...s, background: b.id }))}
                >
                  {b.id === spec.background ? (
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                      <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </div>
    </Dialog>
  );
}
