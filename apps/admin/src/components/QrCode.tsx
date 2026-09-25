'use client';

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Renders a QR code locally (no third-party service ever sees the secret) as one SVG path. */
export function QrCode({
  value,
  label,
  size = 176,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.isDark(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && qr.isDark(r, c)) c++;
        d += `M${start + 4} ${r + 4}h${c - start}v1h-${c - start}z`;
      }
    }
    return { path: d, count: n + 8 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      className="qr"
      shapeRendering="crispEdges"
    >
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
