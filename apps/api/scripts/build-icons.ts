// Draws every app icon from one place, so YAPILAPI and Yap look like one family everywhere:
// the web favicon and brand mark, the home-screen icons (web "Add to Home Screen" for YAPILAPI and
// for Yap mode) and the phone app's icon, Android adaptive icon and splash.
// Run: pnpm --filter @yapilapi/api exec tsx scripts/build-icons.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { glyphPath, NAV_GLYPHS } from '@yapilapi/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const web = (f: string) => path.join(root, 'apps/web', f);
const phone = (f: string) => path.join(root, 'apps/mobile/assets', f);

/** The brand gradient: the accent (--yapi) warming into saffron, as in the light theme. */
const STOPS = [
  ['0', '#B42A4E'],
  ['.55', '#D2453E'],
  ['1', '#E9A537'],
] as const;
const ACCENT = STOPS[0][1];
const gradient = (size: number) =>
  `<linearGradient id="g" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">${STOPS.map(
    ([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`,
  ).join('')}</linearGradient>`;

/** YAPILAPI's mark: three rounded tiles, on a 48 grid. */
const yapilapiMark = `<g fill="#fff"><rect x="11" y="11" width="11" height="11" rx="3.5"/><rect x="26" y="11" width="11" height="11" rx="3.5"/><rect x="18.5" y="25" width="11" height="13" rx="3.5"/></g>`;

/**
 * Yap's mark: the same bubble and sound bars as the Yap tab in the app's navigation
 * (NAV_GLYPHS.yap, a 24 grid), drawn solid and centred on the 48 grid.
 */
function yapMark(): string {
  const [bubble, ...bars] = NAV_GLYPHS.yap as Exclude<(typeof NAV_GLYPHS.yap)[number], { kind: 'dot' }>[];
  const scale = 1.5;
  const cx = bubble!.kind === 'box' ? bubble!.x + bubble!.w / 2 : 12;
  const cy = bubble!.kind === 'box' ? bubble!.y + bubble!.h / 2 : 12;
  const t = `translate(${24 - cx * scale} ${24 - cy * scale}) scale(${scale})`;
  return `<g transform="${t}"><path d="${glyphPath(bubble!)}" fill="#fff"/>${bars.map((b) => `<path d="${glyphPath(b)}" fill="${ACCENT}"/>`).join('')}</g>`;
}

/** A tile: rounded for in-app use and favicons, full-bleed for home screens (the system rounds them). */
const tile = (mark: string, rounded: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"><defs>${gradient(48)}</defs>` +
  (rounded ? `<rect x="2" y="2" width="44" height="44" rx="14" fill="url(#g)"/>` : `<rect width="48" height="48" fill="url(#g)"/>`) +
  mark +
  `</svg>`;

/** Only the mark, in white on transparency, with room for Android's adaptive-icon mask. */
const foreground = (mark: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 72 72" width="72" height="72">${mark}</svg>`;

async function png(svg: string, size: number, file: string, opts: { flatten?: boolean } = {}) {
  let img = sharp(Buffer.from(svg), { density: 2400 }).resize(size, size);
  // iOS app icons must have no transparency.
  if (opts.flatten) img = img.flatten({ background: ACCENT });
  await img.png().toFile(file);
}

const yapilapiRounded = tile(yapilapiMark, true);
const yapilapiBleed = tile(yapilapiMark, false);
const yapRounded = tile(yapMark(), true);
const yapBleed = tile(yapMark(), false);

// Web: favicon and brand mark (rounded), home-screen icons (full bleed).
writeFileSync(web('app/icon.svg'), yapilapiRounded);
writeFileSync(web('public/mark.svg'), yapilapiRounded);
writeFileSync(web('public/yap-icon.svg'), yapRounded);
for (const size of [180, 192, 512]) {
  await png(yapilapiBleed, size, web(`public/yapilapi-icon-${size}.png`));
  await png(yapBleed, size, web(`public/yap-icon-${size}.png`));
}

// Phone app: icon, Android adaptive icon (foreground + background), splash.
await png(yapilapiBleed, 1024, phone('icon.png'), { flatten: true });
await png(foreground(yapilapiMark), 1024, phone('adaptive-icon.png'));
await png(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs>${gradient(48)}</defs><rect width="48" height="48" fill="url(#g)"/></svg>`,
  1024,
  phone('adaptive-background.png'),
);
await png(yapilapiRounded, 1024, phone('splash-icon.png'));

console.log('icons written');
