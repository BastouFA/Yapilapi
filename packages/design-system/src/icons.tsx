import { glyphPath, NAV_GLYPH_DIRECTIONAL, NAV_GLYPH_STROKE, NAV_GLYPHS, type NavGlyphName } from '@yapilapi/shared';

/** 24px outline icons, 1.5px stroke, drawn in currentColor. */
const PATHS = {
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M20 20l-4.8-4.8'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.5v.01'],
  'check-circle': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 12.5l2.8 2.8L16 10'],
  alert: ['M12 3.5L2.5 20h19L12 3.5z', 'M12 10v4.5', 'M12 17.2v.01'],
  'x-circle': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9 9l6 6', 'M15 9l-6 6'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14a6.5 6.5 0 0 1 3.5 6'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19 12l2-1.2-2-3.5-2.2.6a7 7 0 0 0-1.6-.9L14.6 4.8h-4l-.6 2.2a7 7 0 0 0-1.6.9l-2.2-.6-2 3.5L6 12l-2 1.2 2 3.5 2.2-.6c.5.4 1 .7 1.6.9l.6 2.2h4l.6-2.2c.6-.2 1.1-.5 1.6-.9l2.2.6 2-3.5L19 12z',
  ],
  database: [
    'M12 8c4.1 0 7.5-1.3 7.5-3S16.1 2 12 2 4.5 3.3 4.5 5s3.4 3 7.5 3z',
    'M4.5 5v14c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5',
    'M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3',
  ],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z', 'M10 20.5a2 2 0 0 0 4 0'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  home: ['M4 10.5L12 4l8 6.5V20h-5v-6H9v6H4v-9.5z'],
  compass: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M15.5 8.5l-2 5-5 2 2-5 5-2z'],
  create: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M12 8v8', 'M8 12h8'],
  inbox: ['M4 13l2.5-8h11L20 13v6H4v-6z', 'M4 13h5l1 2h4l1-2h5'],
  heart: ['M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.2 4.5 4.5 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z'],
  message: ['M4 5h16v11H9l-5 4V5z'],
  bookmark: ['M6 4h12v16l-6-4-6 4V4z'],
  repost: ['M4 11V9a3 3 0 0 1 3-3h12', 'M16 3l3 3-3 3', 'M20 13v2a3 3 0 0 1-3 3H5', 'M8 21l-3-3 3-3'],
  volume: ['M11 5 6 9H3v6h3l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
  'volume-off': ['M11 5 6 9H3v6h3l5 4V5z', 'M22 9l-6 6', 'M16 9l6 6'],
  link: ['M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 19h14'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  send: ['M4 12l16-8-6 16-3-7-7-1z'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
  'mic-off': ['M9 9v3a3 3 0 0 0 5.1 2.1', 'M15 9.3V6a3 3 0 0 0-5.7-1.3', 'M5 11a7 7 0 0 0 11.4 5.4', 'M19 11a7 7 0 0 1-.6 2.8', 'M12 18v3', 'M3 3l18 18'],
  /** A raised hand, for asking to speak in a room. */
  hand: [
    'M8 13V5.5a1.5 1.5 0 0 1 3 0V11',
    'M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5',
    'M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13',
    'M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.1L4 14.8a1.5 1.5 0 0 1 2.2-2L8 14.5',
  ],
  stop: ['M7 7h10v10H7z'],
  music: ['M9 18V5l11-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  duet: ['M3.5 5h7.5v14H3.5z', 'M13 5h7.5v14H13z'],
  play: ['M8 5v14l11-7z'],
  pause: ['M8 5h3v14H8z', 'M13 5h3v14h-3z'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  'map-pin': ['M12 21s-6.5-6-6.5-11a6.5 6.5 0 1 1 13 0c0 5-6.5 11-6.5 11z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z', 'M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.5h.01'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9L12 3.5z'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  bag: ['M5 8h14l-1 12H6L5 8z', 'M9 8V6a3 3 0 0 1 6 0v2'],
  poll: ['M5 20V11', 'M12 20V5', 'M19 20v-6'],
  logout: ['M10 5H5v14h5', 'M14 8l4 4-4 4', 'M18 12H9'],
  shield: ['M12 3l7.5 3v6c0 4.5-3.2 7.8-7.5 9-4.3-1.2-7.5-4.5-7.5-9V6L12 3z'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  'eye-off': [
    'M10.6 5.6A9.7 9.7 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.6 3.4',
    'M6.2 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.3-.5 4.6-1.3',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
    'M3 3l18 18',
  ],
  sun: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M12 2.5v2',
    'M12 19.5v2',
    'M4.6 4.6l1.4 1.4',
    'M18 18l1.4 1.4',
    'M2.5 12h2',
    'M19.5 12h2',
    'M4.6 19.4L6 18',
    'M18 6l1.4-1.4',
  ],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  /** A screen: "match your device". */
  device: ['M3.5 5h17v11h-17z', 'M9 20h6', 'M12 16v4'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6', 'M12 17v.01'],
  key: ['M8 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M11.5 12H21', 'M18 12v3', 'M15 12v2'],
  palette: ['M12 21a9 9 0 1 1 9-9c0 2.2-1.8 3.5-3.8 3.5H15a1.8 1.8 0 0 0-1.3 3.1c.5.5.3 2.4-1.7 2.4z', 'M7.5 11.5h.01', 'M10 7.5h.01', 'M14.5 7.5h.01'],
  /** Signal bars: data saver. */
  signal: ['M5 20v-3', 'M10 20v-7', 'M15 20V9', 'M20 20V5'],
  /** A person with a plus: add an account. */
  'user-plus': ['M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M3 20a7 7 0 0 1 12.5-4.3', 'M19 14v6', 'M16 17h6'],
  /** Two arrows: switch between things. */
  switch: ['M4 8h14', 'M15 5l3 3-3 3', 'M20 16H6', 'M9 13l-3 3 3 3'],
  /** A clock face: send later, times. */
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.5 2'],
  /** A game controller: games in chats. */
  game: [
    'M7 8h10a4 4 0 0 1 4 4v1.5a3 3 0 0 1-5.4 1.8L14.5 14h-5l-1.1 1.3A3 3 0 0 1 3 13.5V12a4 4 0 0 1 4-4z',
    'M8 10.5v3',
    'M6.5 12h3',
    'M15.5 11h.01',
    'M17.5 13h.01',
  ],
} as const;

export type IconName = keyof typeof PATHS | NavGlyphName;
export const ICON_NAMES = [...Object.keys(PATHS), ...Object.keys(NAV_GLYPHS)] as IconName[];

/** Icons that point along the reading direction; they mirror in right-to-left layouts. */
const DIRECTIONAL = new Set<IconName>(['chevron-right', 'chevron-left', 'arrow-left', 'send', 'logout', ...NAV_GLYPH_DIRECTIONAL]);

const isGlyph = (name: IconName): name is NavGlyphName => name in NAV_GLYPHS;

/**
 * The navigation's own symbols (pulse, wander, spark, yap), from geometry shared with the mobile
 * app. 1.75px stroke; `filled` is the duotone active state (a soft fill behind the line). The
 * `yp-glyph__fill` parts can be made solid from CSS (`fill-opacity: 1`), as the Spark button does.
 */
function Glyph({ name, filled }: { name: NavGlyphName; filled?: boolean }) {
  return NAV_GLYPHS[name].map((s, i) =>
    s.kind === 'dot' ? (
      <circle key={i} cx={s.cx} cy={s.cy} r={s.d / 2} fill="currentColor" stroke="none" />
    ) : s.fill === 'solid' ? (
      <path key={i} d={glyphPath(s)} fill="currentColor" stroke="none" />
    ) : (
      <path key={i} className="yp-glyph__fill" d={glyphPath(s)} fill="currentColor" fillOpacity={filled ? 0.22 : 0} />
    ),
  );
}

export function Icon({ name, size = 20, label, className, filled }: { name: IconName; size?: number; label?: string; className?: string; filled?: boolean }) {
  const glyph = isGlyph(name);
  return (
    <svg
      className={DIRECTIONAL.has(name) ? [className, 'yp-icon--directional'].filter(Boolean).join(' ') : className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled && !glyph ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={glyph ? NAV_GLYPH_STROKE : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {glyph ? <Glyph name={name} filled={filled} /> : PATHS[name].map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
