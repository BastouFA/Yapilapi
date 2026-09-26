/**
 * Share images (Open Graph / X cards) drawn with next/og's ImageResponse:
 * the YAPILAPI look, dark ground, the warm pink to orange gradient from the
 * app's mark and profile cover, and the person or thing being shared.
 * Server only. Uses ImageResponse's built-in font.
 */
import { ImageResponse } from 'next/og';
import { API_ORIGIN } from './public';

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

const GROUND = '#0B0C14';
const SURFACE = '#151726';
const INK = '#F2F3FA';
const MUTED = '#9AA0BC';
const GRADIENT = 'linear-gradient(135deg, #E0204F 0%, #FF5C4A 60%, #FFB020 100%)';

const MAX_IMAGE_BYTES = 4_000_000;
const EMBEDDABLE = /^image\/(png|jpe?g|gif)$/i;

/** Origins the server may fetch images from: our own API and media hosts, never an arbitrary URL from a post. */
function trustedOrigins(): Set<string> {
  const list = [
    API_ORIGIN,
    process.env.NEXT_PUBLIC_API_URL,
    process.env.PUBLIC_API_URL,
    process.env.SITE_URL,
    ...(process.env.OG_IMAGE_ORIGINS ?? '').split(','),
  ];
  const out = new Set<string>();
  for (const v of list) {
    try {
      if (v?.trim()) out.add(new URL(v.trim()).origin);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Fetch an image to embed in a card, as a data URI. Returns null (and the card
 * is drawn without it) when the URL isn't one of ours, the format isn't one the
 * renderer reads (PNG, JPEG, GIF), it's too big, or it doesn't arrive quickly.
 */
export async function embeddableImage(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const target = new URL(url, API_ORIGIN);
    if (!/^https?:$/.test(target.protocol) || !trustedOrigins().has(target.origin)) return null;
    const res = await fetch(target, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!res.ok || !EMBEDDABLE.test(type)) return null;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Shorten on a word boundary so long text never overflows the card. */
export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

function Mark({ size }: { size: number }) {
  const cell = size * 0.23;
  const r = size * 0.075;
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.3, backgroundImage: GRADIENT, display: 'flex', position: 'relative' }}>
      <div style={{ position: 'absolute', left: size * 0.23, top: size * 0.23, width: cell, height: cell, borderRadius: r, background: '#fff' }} />
      <div style={{ position: 'absolute', left: size * 0.54, top: size * 0.23, width: cell, height: cell, borderRadius: r, background: '#fff' }} />
      <div style={{ position: 'absolute', left: size * 0.385, top: size * 0.52, width: cell, height: size * 0.27, borderRadius: r, background: '#fff' }} />
    </div>
  );
}

function Avatar({ src, name, size }: { src: string | null; name: string; size: number }) {
  if (src) return <img src={src} width={size} height={size} alt="" style={{ width: size, height: size, borderRadius: size, objectFit: 'cover' }} />;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size,
        backgroundImage: GRADIENT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: size * 0.44,
      }}
    >
      {(name.trim()[0] ?? 'Y').toUpperCase()}
    </div>
  );
}

export interface CardProps {
  /** Small label above the title, e.g. "Reel" or "Event". */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  body?: string;
  /** A short line at the bottom, e.g. "1.2K followers". */
  footer?: string;
  avatar?: { src: string | null; name: string } | null;
  /** Picture shown beside the text (a photo from the post, or a video's poster). */
  image?: string | null;
}

/** The card: brand bar, optional avatar and picture, title, subtitle, text, footer. */
export function card({ eyebrow, title, subtitle, body, footer, avatar, image }: CardProps): ImageResponse {
  const textWidth = image ? 640 : 1040;
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', background: GROUND, color: INK, position: 'relative', fontSize: 32 }}>
      {/* Warm glow, like the profile cover. */}
      <div
        style={{
          position: 'absolute',
          right: -220,
          top: -260,
          width: 760,
          height: 620,
          borderRadius: 620,
          backgroundImage: 'radial-gradient(circle, rgba(255,92,74,0.45) 0%, rgba(224,32,79,0.18) 45%, rgba(11,12,20,0) 70%)',
          display: 'flex',
        }}
      />
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 14, backgroundImage: GRADIENT, display: 'flex' }} />
      <div style={{ display: 'flex', flexDirection: 'column', padding: '56px 64px 52px 80px', width: '100%', height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Mark size={48} />
          <div style={{ fontSize: 30, letterSpacing: 2, color: INK }}>YAPILAPI</div>
          {eyebrow ? (
            <div style={{ marginLeft: 12, padding: '6px 16px', borderRadius: 999, background: SURFACE, color: MUTED, fontSize: 22, display: 'flex' }}>
              {eyebrow}
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 48, marginTop: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: textWidth, gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              {avatar ? <Avatar src={avatar.src} name={avatar.name} size={96} /> : null}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: avatar ? textWidth - 120 : textWidth }}>
                <div style={{ fontSize: title.length > 40 ? 46 : 56, lineHeight: 1.1, color: INK }}>{clip(title, 70)}</div>
                {subtitle ? <div style={{ fontSize: 28, color: MUTED }}>{clip(subtitle, 80)}</div> : null}
              </div>
            </div>
            {body ? <div style={{ fontSize: 34, lineHeight: 1.35, color: INK, opacity: 0.92 }}>{clip(body, image ? 150 : 200)}</div> : null}
          </div>
          {image ? (
            <div style={{ display: 'flex', width: 400, height: 440, borderRadius: 32, overflow: 'hidden', background: SURFACE, flexShrink: 0 }}>
              <img src={image} width={400} height={440} alt="" style={{ width: 400, height: 440, objectFit: 'cover' }} />
            </div>
          ) : null}
        </div>
        {footer ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 26, color: MUTED }}>
            <div style={{ width: 40, height: 6, borderRadius: 6, backgroundImage: GRADIENT, display: 'flex' }} />
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    { ...OG_SIZE, headers: { 'cache-control': 'public, max-age=300' } },
  );
}

/** The site-wide card, also used when something isn't public. */
export function siteCard(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 96px',
        background: GROUND,
        color: INK,
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          right: -200,
          top: -240,
          width: 820,
          height: 700,
          borderRadius: 700,
          backgroundImage: 'radial-gradient(circle, rgba(255,92,74,0.5) 0%, rgba(224,32,79,0.2) 45%, rgba(11,12,20,0) 70%)',
          display: 'flex',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Mark size={96} />
        <div style={{ fontSize: 64, letterSpacing: 4 }}>YAPILAPI</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 48, fontSize: 72, lineHeight: 1.1 }}>
        <div style={{ display: 'flex' }}>Your social world.</div>
        <div style={{ display: 'flex', backgroundImage: GRADIENT, backgroundClip: 'text', color: 'transparent' }}>One place.</div>
      </div>
      <div style={{ display: 'flex', marginTop: 32, fontSize: 30, color: MUTED }}>
        People, communities, events and places you love, in one place you control.
      </div>
      <div style={{ position: 'absolute', left: 0, bottom: 0, right: 0, height: 14, backgroundImage: GRADIENT, display: 'flex' }} />
    </div>,
    { ...OG_SIZE, headers: { 'cache-control': 'public, max-age=86400' } },
  );
}

/** Compact counts for a card footer, e.g. 1.2K. */
export function compact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function plural(n: number, one: string, many: string): string {
  return `${compact(n)} ${n === 1 ? one : many}`;
}
