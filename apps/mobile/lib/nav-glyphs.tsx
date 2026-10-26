import type { ReactNode } from 'react';
import { Animated, Easing, I18nManager, View, type ViewStyle } from 'react-native';
import {
  NAV_GLYPH_DIRECTIONAL,
  NAV_GLYPH_STROKE,
  NAV_GLYPHS,
  radii,
  starSideRadius,
  type GlyphShape,
  type NavGlyphName,
} from '../../../packages/shared/src/nav-glyphs';
import { curve } from './motion';

type Star = Extract<GlyphShape, { kind: 'star' }>;

/**
 * The navigation's own symbols (Pulse, Wander, Spark, Chats), from the same geometry as the web
 * app's icons (packages/shared/src/nav-glyphs.ts), drawn with plain Views: rounded boxes with a
 * border, dots, a pin (a square with three round corners, turned 45°) and a star (four quarters,
 * each a ring clipped to its square so that only the curved-in side shows).
 *
 * - `line`: the outline (inactive tabs)
 * - `duo`: the outline over a soft fill of the same colour (the current tab)
 * - `solid`: filled shapes (the Spark button)
 *
 * `tap` (0 to 1, once per tap) gives a star a quarter turn with a swell (it looks the same after one)
 * and circles the dots once around it, back to where they started.
 */
export function NavGlyph({
  name,
  size = 24,
  color,
  tone = 'line',
  tap,
}: {
  name: NavGlyphName;
  size?: number;
  color: string;
  tone?: 'line' | 'duo' | 'solid';
  tap?: Animated.Value;
}) {
  const k = size / 24;
  const star = NAV_GLYPHS[name].find((s): s is Star => s.kind === 'star');
  const mirror = I18nManager.isRTL && NAV_GLYPH_DIRECTIONAL.has(name);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      // Shapes are placed with physical left/top: lay them out left to right, then mirror on purpose.
      style={{ width: size, height: size, direction: 'ltr', transform: mirror ? [{ scaleX: -1 }] : undefined }}
    >
      {NAV_GLYPHS[name].map((s, i) =>
        tap && star && (s.kind === 'star' || s.kind === 'dot') ? (
          <Turn key={i} around={star} size={size} value={tap} orbit={s.kind === 'dot'}>
            <Shape shape={s} k={k} color={color} tone={tone} />
          </Turn>
        ) : (
          <Shape key={i} shape={s} k={k} color={color} tone={tone} />
        ),
      )}
    </View>
  );
}

const settle = Easing.inOut(Easing.quad);

/** Turns its shape around the star's centre: the star itself turns and swells, a dot circles it. */
function Turn({ around, size, value, orbit, children }: { around: Star; size: number; value: Animated.Value; orbit: boolean; children: ReactNode }) {
  const k = size / 24;
  // A box twice the glyph's size centred on the star, so it turns around the star's centre.
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: around.cx * k - size,
        top: around.cy * k - size,
        width: size * 2,
        height: size * 2,
        opacity: orbit ? value.interpolate({ inputRange: [0, 0.4, 0.82, 1], outputRange: [1, 0.75, 1, 1] }) : 1,
        transform: orbit
          ? [{ rotate: value.interpolate(curve([0, 0.82, 1], [0, 374, 360], settle, 'deg')) }]
          : [
              { rotate: value.interpolate(curve([0, 0.45, 0.75, 1], [0, 80, 95, 90], settle, 'deg')) },
              { scale: value.interpolate(curve([0, 0.45, 0.75, 1], [1, 1.2, 0.97, 1], settle)) },
            ],
      }}
    >
      <View style={{ position: 'absolute', left: size - around.cx * k, top: size - around.cy * k, width: size, height: size }}>{children}</View>
    </Animated.View>
  );
}

/**
 * A star, always filled: one square per quarter, from the centre out to two of its points, showing
 * only what lies outside the circle that carves that side (a thick ring around the circle, clipped
 * to the square). Two thin bars along the axes, as far out as the arms are wider than them, cover
 * the lines where the quarters meet.
 */
function StarShape({ star, k, color }: { star: Star; k: number; color: string }) {
  const { cx, cy, r, c } = star;
  const side = starSideRadius(star);
  // The ring reaches from the circle to past the star's centre, the farthest point in its square.
  const ring = c * Math.SQRT2 - side + 1;
  const outer = side + ring;
  const bar = 0.4;
  // Out to where the arm is half as wide again as the bar, so its ends stay inside the star.
  const reach = c - Math.sqrt(side * side - (c - bar * 1.5) ** 2);
  return (
    <>
      {([1, -1] as const).flatMap((sx) =>
        ([1, -1] as const).map((sy) => {
          const left = sx > 0 ? cx : cx - r;
          const top = sy > 0 ? cy : cy - r;
          return (
            <View key={`${sx}${sy}`} style={{ position: 'absolute', left: left * k, top: top * k, width: r * k, height: r * k, overflow: 'hidden' }}>
              <View
                style={{
                  position: 'absolute',
                  left: (cx + sx * c - outer - left) * k,
                  top: (cy + sy * c - outer - top) * k,
                  width: outer * 2 * k,
                  height: outer * 2 * k,
                  borderRadius: outer * k,
                  borderWidth: ring * k,
                  borderColor: color,
                }}
              />
            </View>
          );
        }),
      )}
      <View style={{ position: 'absolute', left: (cx - reach) * k, top: (cy - bar) * k, width: reach * 2 * k, height: bar * 2 * k, backgroundColor: color }} />
      <View style={{ position: 'absolute', left: (cx - bar) * k, top: (cy - reach) * k, width: bar * 2 * k, height: reach * 2 * k, backgroundColor: color }} />
    </>
  );
}

function Shape({ shape, k, color, tone }: { shape: GlyphShape; k: number; color: string; tone: 'line' | 'duo' | 'solid' }) {
  const sw = NAV_GLYPH_STROKE;
  if (shape.kind === 'dot') {
    const d = shape.d * k;
    return (
      <View
        style={{
          position: 'absolute',
          left: (shape.cx - shape.d / 2) * k,
          top: (shape.cy - shape.d / 2) * k,
          width: d,
          height: d,
          borderRadius: d / 2,
          backgroundColor: color,
        }}
      />
    );
  }
  if (shape.kind === 'star') return <StarShape star={shape} k={k} color={color} />;
  const solid = shape.fill === 'solid' || tone === 'solid';
  // A stroke is centred on the outline (as in SVG): the box grows by half the stroke on every side.
  const pad = shape.fill === 'solid' ? 0 : sw / 2;
  if (shape.kind === 'drop') {
    const side = (shape.r + pad) * 2 * k;
    const round = side / 2;
    const box: ViewStyle = {
      position: 'absolute',
      left: (shape.cx - shape.r - pad) * k,
      top: (shape.cy - shape.r - pad) * k,
      width: side,
      height: side,
      borderTopLeftRadius: round,
      borderTopRightRadius: round,
      borderBottomLeftRadius: round,
      // The point: rounded a little, like SVG's round line join.
      borderBottomRightRadius: pad * k,
      transform: [{ rotate: '45deg' }],
    };
    return <Outline style={box} color={color} solid={solid} duo={tone === 'duo'} width={sw * k} />;
  }
  const [tl, tr, br, bl] = radii(shape.r);
  const box: ViewStyle = {
    position: 'absolute',
    left: (shape.x - pad) * k,
    top: (shape.y - pad) * k,
    width: (shape.w + pad * 2) * k,
    height: (shape.h + pad * 2) * k,
    borderTopLeftRadius: (tl + pad) * k,
    borderTopRightRadius: (tr + pad) * k,
    borderBottomRightRadius: (br + pad) * k,
    borderBottomLeftRadius: (bl + pad) * k,
  };
  return <Outline style={box} color={color} solid={solid} duo={tone === 'duo'} width={sw * k} />;
}

function Outline({ style, color, solid, duo, width }: { style: ViewStyle; color: string; solid: boolean; duo: boolean; width: number }) {
  if (solid) return <View style={[style, { backgroundColor: color }]} />;
  return (
    <>
      {duo ? <View style={[style, { backgroundColor: color, opacity: 0.22 }]} /> : null}
      <View style={[style, { borderWidth: width, borderColor: color }]} />
    </>
  );
}
