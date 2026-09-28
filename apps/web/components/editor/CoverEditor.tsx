'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Alert, Avatar, Button, Tabs } from '@yapilapi/design-system';
import {
  COVER_MAX_STRAIGHTEN,
  COVER_MAX_ZOOM,
  COVER_RATIO,
  coverLayout,
  coverRatioOk,
  coverZoom,
  cssFilter,
  defaultCoverRecipe,
  effectiveAdjustments,
  fitCoverCrop,
  flipCoverCrop,
  moveCoverCrop,
  NEUTRAL_ADJUSTMENTS,
  profileAccentColors,
  sharpenAmount,
  straightenScale,
  THEME_SURFACES,
  turnCoverRecipe,
  turnedSize,
  vignetteAlpha,
  vignetteCss,
  zoomCoverCrop,
  type Adjustments,
  type CoverRecipe,
  type Profile,
  type ThemeName,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { AdjustPanel, EditorShell, FilterStrip, SharpenFilterDef, useElementSize, useHistory } from './parts';

export type CoverEditorTab = 'frame' | 'look' | 'adjust' | 'preview';
type Size = { width: number; height: number };

/** The recipe to start from: the saved one when it still fits this photo, otherwise the widest centred crop. */
function startRecipe(saved: CoverRecipe | null | undefined, size: Size): CoverRecipe {
  if (!saved) return defaultCoverRecipe(size.width, size.height);
  const { W, H } = turnedSize(size.width, size.height, saved.rotate);
  return coverRatioOk(saved.crop, W, H) ? saved : { ...saved, crop: fitCoverCrop(W, H) };
}

const adjustmentsOf = (r: CoverRecipe): Adjustments => ({ ...NEUTRAL_ADJUSTMENTS, ...r.adjustments });

/** The CSS filter for a recipe's look (at its strength) and adjustments, with the sharpen convolution when there is one. */
function recipeFilter(r: CoverRecipe, sharpenId: string) {
  const strength = r.filterStrength / 100;
  const css = cssFilter(r.filter, r.adjustments, strength);
  const sharpen = sharpenAmount(effectiveAdjustments(r.filter, r.adjustments, strength));
  return sharpen > 0 ? `${css === 'none' ? '' : `${css} `}url(#${sharpenId})` : css;
}

/**
 * The cover as it will look: the photo turned, flipped and straightened, with the crop filling
 * an 8:3 band `width` pixels wide. The same order the server renders in (lib/media-edit.ts).
 */
export function CoverView({
  src,
  size,
  recipe,
  width,
  filterCss,
  className,
  children,
  ...rest
}: {
  src: string;
  size: Size;
  recipe: CoverRecipe;
  width: number;
  filterCss: string;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const { W, H } = turnedSize(size.width, size.height, recipe.rotate);
  const l = coverLayout(recipe.crop, width);
  const quarter = recipe.rotate === 90 || recipe.rotate === 270;
  const s = straightenScale(W, H, recipe.straighten);
  const img: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: quarter ? l.height : l.width,
    height: quarter ? l.width : l.height,
    maxWidth: 'none',
    transform: `translate(-50%, -50%) rotate(${recipe.straighten}deg) scale(${s}) scale(${recipe.flipH ? -1 : 1}, ${recipe.flipV ? -1 : 1}) rotate(${recipe.rotate}deg)`,
    filter: filterCss,
  };
  const alpha = vignetteAlpha(effectiveAdjustments(recipe.filter, recipe.adjustments, recipe.filterStrength / 100));
  return (
    <div {...rest} className={`cover-view${className ? ` ${className}` : ''}`} style={{ width, height: width / COVER_RATIO, ...rest.style }}>
      <div className="cover-view__frame" style={{ left: l.left, top: l.top, width: l.width, height: l.height }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" draggable={false} style={img} />
      </div>
      {alpha > 0 ? <div className="ed__vignette" aria-hidden style={{ background: vignetteCss(alpha) }} /> : null}
      {children}
    </div>
  );
}

/**
 * Edit a cover: frame it in the cover's shape (drag, a zoom slider, the arrow keys), turn, flip
 * and straighten it, pick a look and how strongly, adjust it, and see it behind the profile
 * header in light and dark. Nothing is rendered here: `onDone` gets the recipe, and the server
 * renders the cover from the original photo.
 */
export function CoverEditor({
  src,
  profile,
  initial,
  initialTab = 'frame',
  title,
  busy,
  error,
  onDone,
  onCancel,
}: {
  /** The original photo (an upload's processed size, or a local file's address). */
  src: string;
  profile: Profile;
  initial?: CoverRecipe | null;
  initialTab?: CoverEditorTab;
  title?: string;
  busy?: boolean;
  error?: string | null;
  onDone: (recipe: CoverRecipe) => void;
  onCancel: () => void;
}) {
  const { t } = useSession();
  const [size, setSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<CoverEditorTab>(initialTab);
  const h = useHistory<CoverRecipe | null>(null);
  const r = h.value;
  const sharpenId = `yp-cover-sharpen-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    let live = true;
    setFailed(false);
    const el = new Image();
    el.onload = () => {
      if (!live) return;
      const s = { width: el.naturalWidth, height: el.naturalHeight };
      setSize(s);
      h.replace(startRecipe(initial, s));
    };
    el.onerror = () => live && setFailed(true);
    el.src = src;
    return () => {
      live = false;
    };
    // The saved recipe only matters when the photo first opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const set = (fn: (cur: CoverRecipe) => CoverRecipe, group: string | null = null) => h.set((cur) => (cur ? fn(cur) : cur), group);
  const dims = size && r ? turnedSize(size.width, size.height, r.rotate) : null;
  const filterCss = r ? recipeFilter(r, sharpenId) : 'none';

  let tools: ReactNode = null;
  if (r && size && dims) {
    const zoom = coverZoom(r.crop, dims.W, dims.H);
    tools = (
      <>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Tabs
          value={tab}
          onChange={(v) => setTab(v as CoverEditorTab)}
          tabs={[
            {
              id: 'frame',
              label: t('coverEditor.tab.frame'),
              content: (
                <div className="stack-sm">
                  <RangeRow
                    label={t('coverEditor.zoom')}
                    min={1}
                    max={COVER_MAX_ZOOM}
                    step={0.01}
                    value={Math.round(zoom * 100) / 100}
                    display={`${(Math.round(zoom * 10) / 10).toString()}×`}
                    onChange={(v) => set((cur) => ({ ...cur, crop: zoomCoverCrop(cur.crop, dims.W, dims.H, v) }), 'zoom')}
                    onReset={() => set((cur) => ({ ...cur, crop: zoomCoverCrop(cur.crop, dims.W, dims.H, 1) }))}
                    resetLabel={t('coverEditor.zoomReset')}
                    isDefault={zoom <= 1.001}
                  />
                  <RangeRow
                    label={t('coverEditor.straighten')}
                    min={-COVER_MAX_STRAIGHTEN}
                    max={COVER_MAX_STRAIGHTEN}
                    step={0.5}
                    value={r.straighten}
                    display={`${r.straighten > 0 ? '+' : ''}${r.straighten}°`}
                    onChange={(v) => set((cur) => ({ ...cur, straighten: v }), 'straighten')}
                    onReset={() => set((cur) => ({ ...cur, straighten: 0 }))}
                    resetLabel={t('coverEditor.straightenReset')}
                    isDefault={r.straighten === 0}
                  />
                  <div className="row">
                    <Button variant="secondary" size="sm" onClick={() => set((cur) => turnCoverRecipe(cur, size.width, size.height, -1))}>
                      {t('m.editor.turnLeft')}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => set((cur) => turnCoverRecipe(cur, size.width, size.height, 1))}>
                      {t('m.editor.turnRight')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-pressed={r.flipH}
                      onClick={() => set((cur) => ({ ...cur, flipH: !cur.flipH, crop: flipCoverCrop(cur.crop, 'h') }))}
                    >
                      {t('photoEditor.flipAcross')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-pressed={r.flipV}
                      onClick={() => set((cur) => ({ ...cur, flipV: !cur.flipV, crop: flipCoverCrop(cur.crop, 'v') }))}
                    >
                      {t('photoEditor.flipUpsideDown')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        set((cur) => ({ ...cur, crop: zoomCoverCrop({ ...cur.crop, x: 0.5 - cur.crop.w / 2, y: 0.5 - cur.crop.h / 2 }, dims.W, dims.H, zoom) }))
                      }
                    >
                      {t('coverEditor.centre')}
                    </Button>
                  </div>
                  <p className="muted ed__hint" id={`${sharpenId}-hint`}>
                    {t('coverEditor.frameHint')}
                  </p>
                </div>
              ),
            },
            {
              id: 'look',
              label: t('m.editor.tab.filters'),
              content: (
                <div className="stack-sm">
                  <FilterStrip thumb={src} value={r.filter} onChange={(filter) => set((cur) => ({ ...cur, filter }))} />
                  {r.filter !== 'original' ? (
                    <RangeRow
                      label={t('coverEditor.strength')}
                      min={0}
                      max={100}
                      step={1}
                      value={r.filterStrength}
                      display={String(r.filterStrength)}
                      onChange={(v) => set((cur) => ({ ...cur, filterStrength: v }), 'strength')}
                      onReset={() => set((cur) => ({ ...cur, filterStrength: 100 }))}
                      resetLabel={t('coverEditor.strengthReset')}
                      isDefault={r.filterStrength === 100}
                    />
                  ) : null}
                </div>
              ),
            },
            {
              id: 'adjust',
              label: t('m.editor.tab.adjust'),
              content: (
                <AdjustPanel
                  value={adjustmentsOf(r)}
                  onChange={(k, v) => set((cur) => ({ ...cur, adjustments: { ...cur.adjustments, [k]: v } }), `adj-${k}`)}
                />
              ),
            },
            {
              id: 'preview',
              label: t('coverEditor.tab.preview'),
              content: (
                <div className="stack-sm">
                  <p className="muted ed__hint">{t('coverEditor.previewNote')}</p>
                  <div className="style-previews">
                    {(['light', 'dark'] as const).map((theme) => (
                      <CoverHeaderPreview key={theme} theme={theme} profile={profile} src={src} size={size} recipe={r} filterCss={filterCss} />
                    ))}
                  </div>
                </div>
              ),
            },
          ]}
        />
      </>
    );
  }

  return (
    <EditorShell
      title={title ?? t('m.cover.edit')}
      onCancel={onCancel}
      onDone={() => r && onDone(cleanRecipe(r))}
      doneLabel={t('common.save')}
      canUndo={h.canUndo}
      onUndo={h.undo}
      onReset={h.reset}
      busy={busy}
      tools={tools}
      stage={
        failed ? (
          <p className="ed__notice">{t('coverEditor.cantOpen')}</p>
        ) : !r || !size || !dims ? (
          <p className="ed__notice" role="status">
            {t('photoEditor.opening')}
          </p>
        ) : (
          <>
            <SharpenFilterDef id={sharpenId} amount={sharpenAmount(effectiveAdjustments(r.filter, r.adjustments, r.filterStrength / 100))} />
            <FrameStage
              src={src}
              size={size}
              recipe={r}
              filterCss={filterCss}
              hintId={`${sharpenId}-hint`}
              onCrop={(crop, group) => set((cur) => ({ ...cur, crop }), group)}
              onZoom={(z) => set((cur) => ({ ...cur, crop: zoomCoverCrop(cur.crop, dims.W, dims.H, z) }), 'zoom')}
            />
          </>
        )
      }
    />
  );
}

/** Only the adjustments that change something, so an unchanged photo sends a short recipe. */
function cleanRecipe(r: CoverRecipe): CoverRecipe {
  const adjustments = Object.fromEntries(Object.entries(r.adjustments).filter(([, v]) => v)) as Partial<Adjustments>;
  return { ...r, adjustments };
}

/** A labelled slider with its value and a reset. */
function RangeRow({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
  onReset,
  resetLabel,
  isDefault,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
  onReset: () => void;
  resetLabel: string;
  isDefault: boolean;
}) {
  const id = useId();
  const { t } = useSession();
  return (
    <div className="ed__slider">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        onDoubleClick={onReset}
      />
      <output htmlFor={id} className="ed__value">
        {display}
      </output>
      <Button variant="ghost" size="sm" onClick={onReset} disabled={isDefault} aria-label={resetLabel}>
        {t('m.editor.reset')}
      </Button>
    </div>
  );
}

/**
 * The cover band on the stage: drag the photo to frame it, or focus it and use the arrow keys
 * (Shift for bigger steps) and + / − to zoom. The band is as wide as the stage allows.
 */
function FrameStage({
  src,
  size,
  recipe: r,
  filterCss,
  hintId,
  onCrop,
  onZoom,
}: {
  src: string;
  size: Size;
  recipe: CoverRecipe;
  filterCss: string;
  hintId: string;
  onCrop: (crop: CoverRecipe['crop'], group: string | null) => void;
  onZoom: (zoom: number) => void;
}) {
  const { t, locale } = useSession();
  const [ref, box] = useElementSize<HTMLDivElement>();
  const width = box.width && box.height ? Math.min(box.width, box.height * COVER_RATIO) : 0;
  const { W, H } = turnedSize(size.width, size.height, r.rotate);
  const drag = useRef<{ x: number; y: number; crop: CoverRecipe['crop'] } | null>(null);
  const l = width ? coverLayout(r.crop, width) : null;
  const zoom = coverZoom(r.crop, W, H);
  const pct = (v: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, crop: r.crop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !l) return;
    // Moving the photo right shows more of its left side.
    onCrop(moveCoverCrop(d.crop, -(e.clientX - d.x) / l.width, -(e.clientY - d.y) / l.height), 'drag');
  };
  const end = () => (drag.current = null);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      return onZoom(zoom + 0.1);
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      return onZoom(zoom - 0.1);
    }
    // A step is a share of what's in the frame, so it feels the same at any zoom.
    const step = (e.shiftKey ? 0.1 : 0.02) * r.crop.w;
    const stepY = (e.shiftKey ? 0.1 : 0.02) * r.crop.h;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -stepY], ArrowDown: [0, stepY] }[e.key];
    if (!d) return;
    e.preventDefault();
    onCrop(moveCoverCrop(r.crop, d[0]!, d[1]!), 'keys');
  };

  return (
    <div ref={ref} className="ed__fit">
      {width ? (
        <CoverView
          src={src}
          size={size}
          recipe={r}
          width={width}
          filterCss={filterCss}
          className="cover-view--stage"
          role="application"
          aria-roledescription={t('coverEditor.frameRole')}
          aria-label={t('coverEditor.frameLabel', { zoom: `${(Math.round(zoom * 10) / 10).toString()}×`, x: pct(r.crop.x), y: pct(r.crop.y) })}
          aria-describedby={hintId}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={onKeyDown}
        >
          <span className="ed__grid" aria-hidden />
        </CoverView>
      ) : null}
    </div>
  );
}

/** The cover behind a small copy of the profile header in one theme: the fade, the avatar overlapping it, the name. */
function CoverHeaderPreview({
  theme,
  profile,
  src,
  size,
  recipe,
  filterCss,
}: {
  theme: ThemeName;
  profile: Profile;
  src: string;
  size: Size;
  recipe: CoverRecipe;
  filterCss: string;
}) {
  const { t } = useSession();
  const [ref, box] = useElementSize<HTMLDivElement>();
  const s = THEME_SURFACES[theme];
  const c = profileAccentColors(profile.style?.accent ?? null, theme);
  const muted = theme === 'dark' ? '#9AA0BC' : '#555B75';
  return (
    <figure className="style-preview cover-preview" style={{ background: s.ground, color: s.ink, borderColor: theme === 'dark' ? '#262A40' : '#E3E5EF' }}>
      <div ref={ref} className="cover-preview__band">
        {box.width ? (
          <CoverView src={src} size={size} recipe={recipe} width={box.width} filterCss={filterCss}>
            <span
              className="cover-preview__fade"
              aria-hidden
              style={{ background: `linear-gradient(to bottom, transparent 45%, ${s.ground}4d 75%, ${s.ground}cc)` }}
            />
          </CoverView>
        ) : null}
      </div>
      <div className="cover-preview__head">
        <span className="cover-preview__avatar" style={{ boxShadow: `0 0 0 3px ${s.ground}` }}>
          <Avatar name={profile.displayName} src={profile.avatarUrl} size="lg" />
        </span>
        <div className="style-preview__name">
          <bdi style={{ fontWeight: 800, fontSize: 16 }}>{profile.displayName}</bdi>
          <bdi style={{ color: muted, fontSize: 12 }}>@{profile.username}</bdi>
        </div>
        <span
          className="style-preview__button"
          style={{ background: `linear-gradient(120deg, ${c.accent}, ${c.accentStrong} 50%, ${c.gradEnd})`, color: c.onAccent }}
        >
          {t('profile.follow')}
        </span>
      </div>
      <figcaption className="style-preview__caption" style={{ color: muted }}>
        {t(theme === 'dark' ? 'st.appearance.dark' : 'st.appearance.light')}
      </figcaption>
    </figure>
  );
}
