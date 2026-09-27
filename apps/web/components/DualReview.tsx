'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { dualInsetBox, nearestDualCorner, type DualCorner } from '@yapilapi/shared';

export interface DualShots {
  back: HTMLCanvasElement;
  front: HTMLCanvasElement;
  backUrl: string;
  frontUrl: string;
}

const CORNER_NAMES: Record<DualCorner, string> = {
  'top-left': 'top left',
  'top-right': 'top right',
  'bottom-left': 'bottom left',
  'bottom-right': 'bottom right',
};

/**
 * Check a "Both sides" photo before using it: the back camera photo with the front one in a
 * corner. Drag the small photo (or use the arrow keys) to move it to another corner.
 */
export function DualReview({
  shots,
  corner,
  onCorner,
  onRetake,
  onUse,
  busy,
}: {
  shots: DualShots;
  corner: DualCorner;
  onCorner: (c: DualCorner) => void;
  onRetake: () => void;
  onUse: () => void;
  busy: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const use = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(0);
  const [drag, setDrag] = useState<{ pointer: number; dx: number; dy: number; x0: number; y0: number } | null>(null);

  // The frame's width on screen, to size the white edge and the rounded corners like the finished photo.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setShown(el.clientWidth));
    ro.observe(el);
    setShown(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => use.current?.focus(), []);

  const W = shots.back.width;
  const H = shots.back.height;
  const box = dualInsetBox(W, H, shots.front.width, shots.front.height, corner);
  const scale = shown / W || 0;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ pointer: e.pointerId, dx: 0, dy: 0, x0: e.clientX, y0: e.clientY });
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointer !== e.pointerId) return;
    setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 });
  };
  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointer !== e.pointerId) return;
    const rect = frame.current?.getBoundingClientRect();
    if (rect && rect.width && rect.height) {
      // Where the middle of the small photo was dropped, as a share of the picture.
      const cx = (box.left + box.width / 2) / W + drag.dx / rect.width;
      const cy = (box.top + box.height / 2) / H + drag.dy / rect.height;
      onCorner(nearestDualCorner(cx, cy));
    }
    setDrag(null);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const [v, h] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
    const next =
      e.key === 'ArrowLeft'
        ? `${v}-left`
        : e.key === 'ArrowRight'
          ? `${v}-right`
          : e.key === 'ArrowUp'
            ? `top-${h}`
            : e.key === 'ArrowDown'
              ? `bottom-${h}`
              : null;
    if (!next) return;
    e.preventDefault();
    onCorner(next as DualCorner);
  };

  return (
    <div className="cam__dual" role="dialog" aria-modal="true" aria-labelledby="dual-title">
      <div>
        <h2 id="dual-title" className="cam__dual-title">
          Both sides
        </h2>
        <p className="cam__dual-hint">Drag the small photo to any corner.</p>
      </div>
      <div className="cam__dual-stage">
        <div ref={frame} className="cam__dual-frame">
          <img src={shots.backUrl} alt="Back camera photo" draggable={false} />
          <button
            type="button"
            className={`cam__dual-inset${drag ? ' cam__dual-inset--dragging' : ''}`}
            style={{
              left: pct(box.left, W),
              top: pct(box.top, H),
              width: pct(box.width, W),
              height: pct(box.height, H),
              borderWidth: box.border * scale,
              borderRadius: box.radius * scale,
              transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
            }}
            aria-label={`Front camera photo, ${CORNER_NAMES[corner]} corner. Drag it or use the arrow keys to move it to another corner.`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}
            onKeyDown={onKey}
          >
            <img src={shots.frontUrl} alt="" draggable={false} style={{ borderRadius: Math.max(0, box.radius - box.border) * scale }} />
          </button>
        </div>
      </div>
      <div className="cam__dual-actions">
        <button type="button" className="cam__pill cam__pill--ghost" onClick={onRetake} disabled={busy}>
          Retake
        </button>
        <button ref={use} type="button" className="cam__pill" onClick={onUse} disabled={busy} aria-busy={busy}>
          {busy ? 'Putting it together…' : 'Use photo'}
        </button>
      </div>
    </div>
  );
}
