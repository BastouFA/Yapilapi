'use client';

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Switch, useModalFocus } from '@yapilapi/design-system';
import {
  ADJUSTMENT_KEYS,
  ADJUSTMENT_RANGES,
  cssFilter,
  effectiveAdjustments,
  FILTERS,
  NEUTRAL_ADJUSTMENTS,
  sharpenAmount,
  TEXT_COLOR_NAMES,
  TEXT_COLORS,
  TEXT_FONT_CSS,
  TEXT_FONTS,
  textBoxColor,
  vignetteAlpha,
  vignetteCss,
  type AdjustmentKey,
  type Adjustments,
  type FilterId,
  type TextOverlay,
} from '@yapilapi/shared';

export const ADJUSTMENT_LABELS: Record<AdjustmentKey, string> = {
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  warmth: 'Warmth',
  fade: 'Fade',
  vignette: 'Vignette',
  sharpen: 'Sharpen',
};

export const DEFAULT_TEXT: TextOverlay = { value: '', font: 'bold', color: '#FFFFFF', x: 0.5, y: 0.5, size: 0.07, background: false };

// ─── History ───────────────────────────────────────────────────────────

/**
 * Editor state with undo. Changes that share a `group` within a moment of each other
 * (one slider drag, one text drag) become a single undo step.
 */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState({ list: [initial], index: 0 });
  const last = useRef<{ group: string | null; at: number }>({ group: null, at: 0 });
  const set = useCallback((next: T | ((cur: T) => T), group: string | null = null) => {
    setState((s) => {
      const cur = s.list[s.index]!;
      const value = typeof next === 'function' ? (next as (c: T) => T)(cur) : next;
      const now = Date.now();
      const merge = group !== null && last.current.group === group && now - last.current.at < 800;
      last.current = { group, at: now };
      const base = s.list.slice(0, merge ? s.index : s.index + 1);
      return { list: [...base, value].slice(-100), index: Math.min(base.length, 99) };
    });
  }, []);
  const undo = useCallback(() => {
    last.current = { group: null, at: 0 };
    setState((s) => ({ ...s, index: Math.max(0, s.index - 1) }));
  }, []);
  const reset = useCallback(() => {
    last.current = { group: null, at: 0 };
    setState((s) => (s.index === 0 && s.list.length === 1 ? s : { list: [...s.list.slice(0, s.index + 1), s.list[0]!], index: s.index + 1 }));
  }, []);
  /** Start over from a new first state, with no history (e.g. once a video's length is known). */
  const replace = useCallback((value: T) => {
    last.current = { group: null, at: 0 };
    setState({ list: [value], index: 0 });
  }, []);
  const value = state.list[state.index]!;
  return { value, set, undo, reset, replace, canUndo: state.index > 0, changed: value !== state.list[0] };
}

// ─── Shell ─────────────────────────────────────────────────────────────

/** Full-screen editor: title and actions on top, the picture in the middle, tools below. */
export function EditorShell({
  title,
  onCancel,
  onDone,
  doneLabel = 'Done',
  canUndo,
  onUndo,
  onReset,
  busy,
  stage,
  tools,
}: {
  title: string;
  onCancel: () => void;
  onDone: () => void;
  doneLabel?: string;
  canUndo: boolean;
  onUndo: () => void;
  onReset: () => void;
  busy?: boolean;
  stage: ReactNode;
  tools: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(ref, true, busy ? undefined : onCancel);
  // Keep the page behind from scrolling.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <div
      ref={ref}
      className="ed"
      role="dialog"
      aria-modal
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        const mod = e.metaKey || e.ctrlKey;
        const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
        if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing) {
          e.preventDefault();
          onUndo();
        }
      }}
    >
      <div className="ed__bar">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <h2 id={titleId} className="ed__title">
          {title}
        </h2>
        <div className="row" style={{ gap: 4 }}>
          <Button variant="ghost" size="sm" onClick={onUndo} disabled={!canUndo || busy} aria-keyshortcuts="Control+Z Meta+Z">
            Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={onReset} disabled={!canUndo || busy}>
            Reset
          </Button>
          <Button size="sm" onClick={onDone} loading={busy}>
            {doneLabel}
          </Button>
        </div>
      </div>
      <div className="ed__stage">{stage}</div>
      <div className="ed__tools">{tools}</div>
    </div>
  );
}

// ─── Sharpen preview ───────────────────────────────────────────────────

/** The 3×3 sharpen kernel the canvas render uses, previewed as an SVG filter. */
export const sharpenKernel = (amount: number) => {
  const k = amount * 0.6;
  return [0, -k, 0, -k, 1 + 4 * k, -k, 0, -k, 0];
};

/** CSS filter for a preview: the look's chain plus, when sharpening, an SVG convolution. */
export function previewFilter(filter: FilterId, adjustments: Adjustments, sharpenId: string) {
  const css = cssFilter(filter, adjustments);
  const sharpen = sharpenAmount(effectiveAdjustments(filter, adjustments));
  if (sharpen <= 0) return css;
  return `${css === 'none' ? '' : `${css} `}url(#${sharpenId})`;
}

export function SharpenFilterDef({ id, amount }: { id: string; amount: number }) {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      <filter id={id} colorInterpolationFilters="sRGB">
        <feConvolveMatrix order="3" kernelMatrix={sharpenKernel(amount).join(' ')} preserveAlpha="true" edgeMode="duplicate" />
      </filter>
    </svg>
  );
}

/** Sharpen RGBA pixels in place with the same kernel (edges repeat). */
export function sharpenPixels(img: ImageData, amount: number) {
  if (amount <= 0) return;
  const { width: w, height: h, data } = img;
  const src = new Uint8ClampedArray(data);
  const k = amount * 0.6;
  const c = 1 + 4 * k;
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const left = x > 0 ? x - 1 : x;
      const right = x < w - 1 ? x + 1 : x;
      const i = (row + x) * 4;
      for (let ch = 0; ch < 3; ch++)
        data[i + ch] =
          c * src[i + ch]! - k * (src[(up + x) * 4 + ch]! + src[(down + x) * 4 + ch]! + src[(row + left) * 4 + ch]! + src[(row + right) * 4 + ch]!);
    }
  }
}

/** The vignette over a preview, the same gradient the render and the server draw. */
export function VignetteOverlay({ filter, adjustments }: { filter: FilterId; adjustments: Adjustments }) {
  const alpha = vignetteAlpha(effectiveAdjustments(filter, adjustments));
  if (alpha <= 0) return null;
  return <div className="ed__vignette" aria-hidden style={{ background: vignetteCss(alpha) }} />;
}

/** Draw the vignette on a canvas of w × h. */
export function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(w, h);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.SQRT1_2);
  g.addColorStop(0.45, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(-0.5, -0.5, 1, 1);
  ctx.restore();
}

/** Draw text centred at (x, y) fractions, kept inside the picture, as the API does for videos. */
export async function drawText(ctx: CanvasRenderingContext2D, t: TextOverlay, w: number, h: number) {
  const f = TEXT_FONT_CSS[t.font];
  const px = Math.max(8, Math.round(t.size * w));
  const font = `${f.weight} ${px}px ${f.family}`;
  await document.fonts?.load(font, t.value).catch(() => undefined);
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const m = ctx.measureText(t.value);
  const tw = m.width;
  const ascent = m.actualBoundingBoxAscent || px * 0.75;
  const descent = m.actualBoundingBoxDescent || px * 0.2;
  const th = ascent + descent;
  const left = Math.min(Math.max(0, w - tw), Math.max(0, t.x * w - tw / 2));
  const top = Math.min(Math.max(0, h - th), Math.max(0, t.y * h - th / 2));
  if (t.background) {
    const pad = Math.round(px * 0.25);
    ctx.fillStyle = textBoxColor(t.color);
    ctx.fillRect(left - pad, top - pad, tw + pad * 2, th + pad * 2);
  }
  ctx.fillStyle = t.color;
  ctx.fillText(t.value, left, top + ascent);
  ctx.restore();
}

// ─── Text on the stage ─────────────────────────────────────────────────

/**
 * The text overlay on a preview: drag it with a pointer, or focus it and use the arrow keys
 * (Shift for bigger steps). `width` is the preview's width in CSS pixels, for the font size.
 */
export function TextOnStage({ text, width, onMove }: { text: TextOverlay; width: number; onMove: (x: number, y: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const f = TEXT_FONT_CSS[text.font];
  const clampTo = (x: number, y: number) => {
    const el = ref.current;
    const box = el?.parentElement?.getBoundingClientRect();
    if (!el || !box || !box.width || !box.height) return { x, y };
    const hw = el.offsetWidth / 2 / box.width;
    const hh = el.offsetHeight / 2 / box.height;
    return { x: Math.min(Math.max(x, Math.min(0.5, hw)), Math.max(0.5, 1 - hw)), y: Math.min(Math.max(y, Math.min(0.5, hh)), Math.max(0.5, 1 - hh)) };
  };
  const move = (x: number, y: number) => {
    const c = clampTo(x, y);
    onMove(Math.round(c.x * 1000) / 1000, Math.round(c.y * 1000) / 1000);
  };
  const style: CSSProperties = {
    left: `${text.x * 100}%`,
    top: `${text.y * 100}%`,
    fontFamily: f.family,
    fontWeight: f.weight,
    fontSize: Math.max(8, text.size * width),
    color: text.color,
    background: text.background ? textBoxColor(text.color) : 'transparent',
    padding: text.background ? `${text.size * width * 0.25}px` : 0,
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    drag.current = { dx: (e.clientX - box.left) / box.width - text.x, dy: (e.clientY - box.top) / box.height - text.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    move((e.clientX - box.left) / box.width - drag.current.dx, (e.clientY - box.top) / box.height - drag.current.dy);
  };
  return (
    <div
      ref={ref}
      className="ed__text"
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`Text: ${text.value}. Drag, or use the arrow keys, to move it.`}
      aria-roledescription="movable text"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.05 : 0.01;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        move(text.x + d[0]!, text.y + d[1]!);
      }}
    >
      {text.value}
    </div>
  );
}

/** Watch an element's size (for the preview's width). */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e!.contentRect.width, height: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Fit a W × H box inside the element `ref` points at. */
export function useFit(W: number, H: number) {
  const [ref, box] = useElementSize<HTMLDivElement>();
  const scale = box.width && box.height && W && H ? Math.min(box.width / W, box.height / H) : 0;
  return { ref, width: W * scale, height: H * scale };
}

// ─── Tool panels ───────────────────────────────────────────────────────

/** The looks, each shown on a small copy of the picture. */
export function FilterStrip({ thumb, value, onChange }: { thumb: string | null; value: FilterId; onChange: (f: FilterId) => void }) {
  return (
    <div className="ed__filters" role="group" aria-label="Filters">
      {FILTERS.map((f) => (
        <button key={f.id} type="button" className="ed__filter" aria-pressed={f.id === value} onClick={() => onChange(f.id)}>
          <span className="ed__filter-thumb">
            {thumb ? <img src={thumb} alt="" style={{ filter: cssFilter(f.id) }} /> : null}
            {thumb && f.extra?.vignette ? (
              <span className="ed__vignette" style={{ background: vignetteCss(vignetteAlpha({ ...NEUTRAL_ADJUSTMENTS, ...f.extra })) }} />
            ) : null}
          </span>
          <span className="ed__filter-name">{f.name}</span>
        </button>
      ))}
    </div>
  );
}

/** One labelled slider per adjustment, each with its own reset. */
export function AdjustPanel({ value, onChange }: { value: Adjustments; onChange: (key: AdjustmentKey, v: number) => void }) {
  const base = useId();
  return (
    <div className="ed__sliders">
      {ADJUSTMENT_KEYS.map((k) => {
        const r = ADJUSTMENT_RANGES[k];
        const v = value[k];
        const id = `${base}-${k}`;
        return (
          <div key={k} className="ed__slider">
            <label htmlFor={id}>{ADJUSTMENT_LABELS[k]}</label>
            <input
              id={id}
              type="range"
              min={r.min}
              max={r.max}
              step={1}
              value={v}
              aria-valuetext={r.min < 0 && v > 0 ? `+${v}` : String(v)}
              onChange={(e) => onChange(k, Number(e.currentTarget.value))}
              onDoubleClick={() => onChange(k, 0)}
            />
            <output htmlFor={id} className="ed__value">
              {r.min < 0 && v > 0 ? `+${v}` : v}
            </output>
            <Button variant="ghost" size="sm" onClick={() => onChange(k, 0)} disabled={v === 0} aria-label={`Reset ${ADJUSTMENT_LABELS[k].toLowerCase()}`}>
              Reset
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Add, change or remove the text on the picture. */
export function TextPanel({ text, onChange }: { text: TextOverlay | null; onChange: (t: TextOverlay | null, group?: string) => void }) {
  const base = useId();
  if (!text)
    return (
      <div className="stack-sm">
        <p className="muted" style={{ margin: 0 }}>
          Add a few words on top of your picture. You can drag them where you want.
        </p>
        <Button variant="secondary" icon="plus" onClick={() => onChange({ ...DEFAULT_TEXT, value: 'Your text' })} style={{ alignSelf: 'flex-start' }}>
          Add text
        </Button>
      </div>
    );
  return (
    <div className="stack-sm ed__text-panel">
      <div className="yp-field">
        <label className="yp-field__label" htmlFor={`${base}-value`}>
          Text
        </label>
        <input
          id={`${base}-value`}
          className="yp-input"
          type="text"
          value={text.value}
          maxLength={100}
          onChange={(e) => onChange({ ...text, value: e.currentTarget.value }, 'text-value')}
        />
      </div>
      <div className="row" role="group" aria-label="Font">
        {TEXT_FONTS.map((f) => (
          <button
            key={f}
            type="button"
            className="ed__chip"
            aria-pressed={text.font === f}
            style={{ fontFamily: TEXT_FONT_CSS[f].family, fontWeight: TEXT_FONT_CSS[f].weight }}
            onClick={() => onChange({ ...text, font: f })}
          >
            {TEXT_FONT_CSS[f].name}
          </button>
        ))}
      </div>
      <div className="row" role="group" aria-label="Color">
        {TEXT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="ed__swatch"
            aria-pressed={text.color === c}
            aria-label={TEXT_COLOR_NAMES[c]}
            title={TEXT_COLOR_NAMES[c]}
            style={{ background: c }}
            onClick={() => onChange({ ...text, color: c })}
          />
        ))}
      </div>
      <div className="ed__slider">
        <label htmlFor={`${base}-size`}>Size</label>
        <input
          id={`${base}-size`}
          type="range"
          min={0.03}
          max={0.2}
          step={0.005}
          value={text.size}
          aria-valuetext={`${Math.round(text.size * 100)} percent of the width`}
          onChange={(e) => onChange({ ...text, size: Number(e.currentTarget.value) }, 'text-size')}
        />
        <output htmlFor={`${base}-size`} className="ed__value">
          {Math.round(text.size * 100)}
        </output>
      </div>
      <div className="row">
        <Switch label="Box behind the text" checked={text.background} onChange={(v) => onChange({ ...text, background: v })} />
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...text, x: 0.5, y: 0.5 })}>
          Center it
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Remove text
        </Button>
      </div>
    </div>
  );
}

/** 83.4 → "1:23.4" */
export function clock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
