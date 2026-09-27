'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Alert, Button, Segments, Tabs } from '@yapilapi/design-system';
import {
  applyColorMatrix,
  colorMatrix,
  effectiveAdjustments,
  NEUTRAL_ADJUSTMENTS,
  sharpenAmount,
  vignetteAlpha,
  type Adjustments,
  type FilterId,
  type MessageKey,
  type TextOverlay,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import {
  AdjustPanel,
  drawText,
  drawVignette,
  EditorShell,
  FilterStrip,
  previewFilter,
  SharpenFilterDef,
  sharpenPixels,
  TextOnStage,
  TextPanel,
  useFit,
  useHistory,
  VignetteOverlay,
} from './parts';
import { TagHint, TagLayer, TagPersonSearch, useTagEditing, type DraftTag } from '../PhotoTags';

type Turn = 0 | 90 | 180 | 270;
type Crop = { x: number; y: number; w: number; h: number };
/** Shapes with a word for a name carry its message key; the others show their ratio as it is. */
const ASPECTS: readonly { id: 'free' | '1:1' | '4:5' | '9:16' | '16:9'; label: MessageKey | null; ratio: number | null }[] = [
  { id: 'free', label: 'photoEditor.free', ratio: null },
  { id: '1:1', label: 'm.editor.shape.square', ratio: 1 },
  { id: '4:5', label: null, ratio: 4 / 5 },
  { id: '9:16', label: null, ratio: 9 / 16 },
  { id: '16:9', label: null, ratio: 16 / 9 },
];
type Aspect = (typeof ASPECTS)[number]['id'];

interface PhotoState {
  rotate: Turn;
  flipH: boolean;
  flipV: boolean;
  aspect: Aspect;
  /** Fractions of the turned and flipped picture. */
  crop: Crop;
  filter: FilterId;
  adjustments: Adjustments;
  text: TextOverlay | null;
}

const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
const INITIAL: PhotoState = {
  rotate: 0,
  flipH: false,
  flipV: false,
  aspect: 'free',
  crop: FULL,
  filter: 'original',
  adjustments: NEUTRAL_ADJUSTMENTS,
  text: null,
};
/** The rendered photo's longest side. */
const MAX_EDGE = 4096;
const MIN_CROP = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The largest centred crop with this ratio (width / height, in pixels) in a W × H picture. */
function fitCrop(ratio: number | null, W: number, H: number): Crop {
  if (!ratio) return FULL;
  const w = (ratio * H) / W;
  return w <= 1 ? { x: (1 - w) / 2, y: 0, w, h: 1 } : { x: 0, y: (1 - 1 / w) / 2, w: 1, h: 1 / w };
}

/** Draw the picture turned and flipped, filling a canvas of the turned size × scale. */
function drawTurned(ctx: CanvasRenderingContext2D, img: HTMLImageElement, s: Pick<PhotoState, 'rotate' | 'flipH' | 'flipV'>, scale: number) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const turned = s.rotate === 90 || s.rotate === 270;
  const TW = (turned ? H : W) * scale;
  const TH = (turned ? W : H) * scale;
  ctx.save();
  ctx.translate(TW / 2, TH / 2);
  ctx.scale(s.flipH ? -1 : 1, s.flipV ? -1 : 1);
  ctx.rotate((s.rotate * Math.PI) / 180);
  ctx.drawImage(img, (-W * scale) / 2, (-H * scale) / 2, W * scale, H * scale);
  ctx.restore();
}

function turnedSize(img: HTMLImageElement, rotate: Turn) {
  return rotate === 90 || rotate === 270 ? { W: img.naturalHeight, H: img.naturalWidth } : { W: img.naturalWidth, H: img.naturalHeight };
}

/** Render the edited photo at full resolution (up to 4096 pixels on the long side) as a JPEG file. */
async function renderPhoto(img: HTMLImageElement, s: PhotoState, name: string): Promise<File> {
  const { W, H } = turnedSize(img, s.rotate);
  const cw = Math.max(1, Math.round(s.crop.w * W));
  const ch = Math.max(1, Math.round(s.crop.h * H));
  const scale = Math.min(1, MAX_EDGE / Math.max(cw, ch));
  const outW = Math.max(1, Math.round(cw * scale));
  const outH = Math.max(1, Math.round(ch * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.save();
  ctx.translate(-s.crop.x * W * scale, -s.crop.y * H * scale);
  drawTurned(ctx, img, s, scale);
  ctx.restore();
  const adj = effectiveAdjustments(s.filter, s.adjustments);
  const cm = colorMatrix(s.filter, s.adjustments);
  const sharpen = sharpenAmount(adj);
  if (cm.m.some((v, i) => v !== [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) || cm.o.some((v) => v !== 0) || sharpen > 0) {
    const pixels = ctx.getImageData(0, 0, outW, outH);
    applyColorMatrix(pixels.data, cm);
    sharpenPixels(pixels, sharpen);
    ctx.putImageData(pixels, 0, 0);
  }
  drawVignette(ctx, outW, outH, vignetteAlpha(adj));
  if (s.text?.value.trim()) await drawText(ctx, { ...s.text, value: s.text.value.trim() }, outW, outH);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('render failed');
  return new File([blob], name.replace(/\.[^.]+$/, '') + '-edited.jpg', { type: 'image/jpeg' });
}

/**
 * Photo editor: crop (free or a fixed shape), turn and flip, a look, adjustments and text.
 * Everything renders in the browser at full size, so the uploaded file is already edited.
 */
export function PhotoEditor({
  file,
  title,
  onDone,
  onCancel,
}: {
  file: File;
  title?: string;
  /** The edited photo, and anyone tagged in it (spots on the finished, cropped photo). */
  onDone: (f: File, tags: DraftTag[]) => void;
  onCancel: () => void;
}) {
  const { t } = useSession();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState('crop');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const h = useHistory<PhotoState>(INITIAL);
  const s = h.value;
  const sharpenId = `yp-sharpen-${useId().replace(/:/g, '')}`;
  // Tags sit on the finished photo as fractions of its size, so a later crop keeps each spot.
  const [tags, setTags] = useState<DraftTag[]>([]);
  const tagging = useTagEditing(tags, setTags);

  useEffect(() => {
    // Results from a load that was cancelled (the file changed, or React mounted twice) are ignored.
    let live = true;
    setFailed(false);
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => live && setImg(el);
    el.onerror = () => live && setFailed(true);
    el.src = url;
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // A small copy of the cropped picture for the filter thumbnails.
  const thumb = useMemo(() => {
    if (!img) return null;
    const { W, H } = turnedSize(img, s.rotate);
    const cw = s.crop.w * W;
    const ch = s.crop.h * H;
    const scale = 120 / Math.max(cw, ch);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cw * scale));
    c.height = Math.max(1, Math.round(ch * scale));
    const ctx = c.getContext('2d')!;
    ctx.translate(-s.crop.x * W * scale, -s.crop.y * H * scale);
    drawTurned(ctx, img, s, scale);
    return c.toDataURL('image/jpeg', 0.8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, s.rotate, s.flipH, s.flipV, s.crop]);

  const turn = (dir: 1 | -1) =>
    h.set((cur) => {
      const rotate = ((((cur.rotate + dir * 90) % 360) + 360) % 360) as Turn;
      const size = img ? turnedSize(img, rotate) : { W: 1, H: 1 };
      const ratio = ASPECTS.find((a) => a.id === cur.aspect)!.ratio;
      // Keep a free crop on the same part of the picture; refit a fixed shape.
      const c = cur.crop;
      const crop = ratio
        ? fitCrop(ratio, size.W, size.H)
        : dir === 1
          ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }
          : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
      return { ...cur, rotate, crop };
    });
  const flip = (axis: 'h' | 'v') =>
    h.set((cur) =>
      axis === 'h'
        ? { ...cur, flipH: !cur.flipH, crop: { ...cur.crop, x: 1 - cur.crop.x - cur.crop.w } }
        : { ...cur, flipV: !cur.flipV, crop: { ...cur.crop, y: 1 - cur.crop.y - cur.crop.h } },
    );
  const setAspect = (aspect: Aspect) => {
    if (!img) return;
    const { W, H } = turnedSize(img, s.rotate);
    h.set((cur) => ({ ...cur, aspect, crop: fitCrop(ASPECTS.find((a) => a.id === aspect)!.ratio, W, H) }));
  };

  async function done() {
    if (!img) return;
    if (!h.changed) return onDone(file, tags);
    setBusy(true);
    setError(null);
    try {
      onDone(await renderPhoto(img, s, file.name), tags);
    } catch {
      setError(t('photoEditor.saveFailed'));
      setBusy(false);
    }
  }

  const adj = effectiveAdjustments(s.filter, s.adjustments);
  const tools = (
    <>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'crop',
            label: t('m.editor.tab.crop'),
            content: (
              <div className="stack-sm">
                <Segments
                  label={t('photoEditor.cropShape')}
                  value={s.aspect}
                  onChange={setAspect}
                  options={ASPECTS.map((a) => ({ id: a.id, label: a.label ? t(a.label) : a.id }))}
                />
                <div className="row">
                  <Button variant="secondary" size="sm" onClick={() => turn(-1)}>
                    {t('m.editor.turnLeft')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => turn(1)}>
                    {t('m.editor.turnRight')}
                  </Button>
                  <Button variant="secondary" size="sm" aria-pressed={s.flipH} onClick={() => flip('h')}>
                    {t('photoEditor.flipAcross')}
                  </Button>
                  <Button variant="secondary" size="sm" aria-pressed={s.flipV} onClick={() => flip('v')}>
                    {t('photoEditor.flipUpsideDown')}
                  </Button>
                </div>
                <p className="muted ed__hint">{t('photoEditor.cropHint')}</p>
              </div>
            ),
          },
          {
            id: 'filters',
            label: t('m.editor.tab.filters'),
            content: <FilterStrip thumb={thumb} value={s.filter} onChange={(filter) => h.set((cur) => ({ ...cur, filter }))} />,
          },
          {
            id: 'adjust',
            label: t('m.editor.tab.adjust'),
            content: (
              <AdjustPanel value={s.adjustments} onChange={(k, v) => h.set((cur) => ({ ...cur, adjustments: { ...cur.adjustments, [k]: v } }), `adj-${k}`)} />
            ),
          },
          {
            id: 'text',
            label: t('m.post.text'),
            content: <TextPanel text={s.text} onChange={(text, group) => h.set((cur) => ({ ...cur, text }), group ?? null)} />,
          },
          {
            id: 'tag',
            label: t('m.tags.add'),
            content: tagging.pending ? <TagPersonSearch {...tagging.searchProps} /> : <TagHint count={tags.length} />,
          },
        ]}
      />
    </>
  );

  return (
    <EditorShell
      title={title ?? t('m.editor.photoTitle')}
      onCancel={onCancel}
      onDone={done}
      doneLabel={t(h.changed ? 'm.common.done' : 'm.camera.dualUse')}
      canUndo={h.canUndo}
      onUndo={h.undo}
      onReset={h.reset}
      busy={busy}
      tools={tools}
      stage={
        failed ? (
          <p className="ed__notice">{t('photoEditor.cantOpen')}</p>
        ) : !img ? (
          <p className="ed__notice" role="status">
            {t('photoEditor.opening')}
          </p>
        ) : (
          <>
            <SharpenFilterDef id={sharpenId} amount={sharpenAmount(adj)} />
            {tab === 'crop' ? (
              <CropStage
                img={img}
                state={s}
                filterCss={previewFilter(s.filter, s.adjustments, sharpenId)}
                onCrop={(crop) => h.set((cur) => ({ ...cur, crop }), 'crop')}
              />
            ) : (
              <PhotoPreview
                img={img}
                state={s}
                filterCss={previewFilter(s.filter, s.adjustments, sharpenId)}
                onMoveText={(x, y) => h.set((cur) => (cur.text ? { ...cur, text: { ...cur.text, x, y } } : cur), 'text-move')}
                overlay={tab === 'tag' ? <TagLayer {...tagging.layerProps} /> : null}
              />
            )}
          </>
        )
      }
    />
  );
}

/** Draw into a canvas sized for the screen's pixel density. */
function usePreviewCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, width: number, height: number, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !width || !height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    draw(ctx, c.width, c.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, ...deps]);
  return ref;
}

/** The cropped picture with its look, vignette and movable text: what will be posted. */
function PhotoPreview({
  img,
  state: s,
  filterCss,
  onMoveText,
  overlay,
}: {
  img: HTMLImageElement;
  state: PhotoState;
  filterCss: string;
  onMoveText: (x: number, y: number) => void;
  /** Drawn over the picture, the same size (the photo tags). */
  overlay?: ReactNode;
}) {
  const { t } = useSession();
  const { W, H } = turnedSize(img, s.rotate);
  const fit = useFit(s.crop.w * W, s.crop.h * H);
  const canvas = usePreviewCanvas(
    (ctx, w) => {
      const scale = w / (s.crop.w * W);
      ctx.translate(-s.crop.x * W * scale, -s.crop.y * H * scale);
      drawTurned(ctx, img, s, scale);
    },
    fit.width,
    fit.height,
    [img, s.rotate, s.flipH, s.flipV, s.crop],
  );
  return (
    <div ref={fit.ref} className="ed__fit">
      <div className="ed__frame" style={{ width: fit.width, height: fit.height }}>
        <canvas ref={canvas} role="img" aria-label={t('photoEditor.preview')} style={{ width: '100%', height: '100%', filter: filterCss }} />
        <VignetteOverlay filter={s.filter} adjustments={s.adjustments} />
        {s.text?.value.trim() ? <TextOnStage text={s.text} width={fit.width} onMove={onMoveText} /> : null}
        {overlay}
      </div>
    </div>
  );
}

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
const HANDLE_LABELS: Record<Exclude<Handle, 'move'>, MessageKey> = {
  nw: 'photoEditor.handle.nw',
  ne: 'photoEditor.handle.ne',
  sw: 'photoEditor.handle.sw',
  se: 'photoEditor.handle.se',
};

/** Resize or move the crop frame from one corner, keeping a fixed shape when one is chosen. */
function adjustCrop(c: Crop, handle: Handle, dx: number, dy: number, ratio: number | null, W: number, H: number): Crop {
  if (handle === 'move') return { ...c, x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h) };
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  // The fixed corner opposite the one being dragged.
  const fx = west ? c.x + c.w : c.x;
  const fy = north ? c.y + c.h : c.y;
  let w = clamp(c.w + (west ? -dx : dx), MIN_CROP, west ? fx : 1 - fx);
  let h = clamp(c.h + (north ? -dy : dy), MIN_CROP, north ? fy : 1 - fy);
  if (ratio) {
    // In fractions, width / height = ratio × H / W. Follow the larger change, then fit inside.
    const k = (ratio * H) / W;
    if (Math.abs(dx) >= Math.abs(dy)) h = w / k;
    else w = h * k;
    const maxW = west ? fx : 1 - fx;
    const maxH = north ? fy : 1 - fy;
    if (w > maxW) ((w = maxW), (h = w / k));
    if (h > maxH) ((h = maxH), (w = h * k));
  }
  return { x: west ? fx - w : fx, y: north ? fy - h : fy, w, h };
}

/** The whole turned picture with the crop frame on top. */
function CropStage({ img, state: s, filterCss, onCrop }: { img: HTMLImageElement; state: PhotoState; filterCss: string; onCrop: (c: Crop) => void }) {
  const { t, locale } = useSession();
  const { W, H } = turnedSize(img, s.rotate);
  const fit = useFit(W, H);
  const ratio = ASPECTS.find((a) => a.id === s.aspect)!.ratio;
  const canvas = usePreviewCanvas(
    (ctx, w) => {
      drawTurned(ctx, img, s, w / W);
    },
    fit.width,
    fit.height,
    [img, s.rotate, s.flipH, s.flipV],
  );
  const drag = useRef<{ handle: Handle; x: number; y: number; crop: Crop } | null>(null);
  const start = (handle: Handle) => (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    drag.current = { handle, x: e.clientX, y: e.clientY, crop: s.crop };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !fit.width) return;
    onCrop(adjustCrop(d.crop, d.handle, (e.clientX - d.x) / fit.width, (e.clientY - d.y) / fit.height, ratio, W, H));
  };
  const end = () => (drag.current = null);
  const keys = (handle: Handle) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onCrop(adjustCrop(s.crop, handle, d[0]!, d[1]!, ratio, W, H));
  };
  const c = s.crop;
  const pct = (v: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);
  return (
    <div ref={fit.ref} className="ed__fit">
      <div className="ed__frame ed__frame--crop" style={{ width: fit.width, height: fit.height }}>
        <canvas ref={canvas} role="img" aria-label={t('photoEditor.cropCanvas')} style={{ width: '100%', height: '100%', filter: filterCss }} />
        <div
          className="ed__crop"
          style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}
          role="button"
          tabIndex={0}
          aria-label={t('photoEditor.cropFrame', { width: pct(c.w), height: pct(c.h), x: pct(c.x), y: pct(c.y) })}
          onPointerDown={start('move')}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={keys('move')}
        >
          <span className="ed__grid" aria-hidden />
        </div>
        {(['nw', 'ne', 'sw', 'se'] as const).map((k) => (
          <span
            key={k}
            className="ed__handle"
            style={{ left: `${(k === 'nw' || k === 'sw' ? c.x : c.x + c.w) * 100}%`, top: `${(k === 'nw' || k === 'ne' ? c.y : c.y + c.h) * 100}%` }}
            role="button"
            tabIndex={0}
            aria-label={t(HANDLE_LABELS[k])}
            onPointerDown={start(k)}
            onPointerMove={onMove}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={keys(k)}
          />
        ))}
      </div>
    </div>
  );
}
