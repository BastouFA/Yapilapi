import { I18nManager, View, type ViewStyle } from 'react-native';
import { NAV_GLYPH_DIRECTIONAL, NAV_GLYPH_STROKE, NAV_GLYPHS, radii, type GlyphShape, type NavGlyphName } from '../../../packages/shared/src/nav-glyphs';

/**
 * The navigation's own symbols (Pulse, Wander, Spark, Yap), from the same geometry as the web
 * app's icons (packages/shared/src/nav-glyphs.ts), drawn with plain Views: rounded boxes with a
 * border, dots, and a pin (a square with three round corners, turned 45°).
 *
 * - `line`: the outline (inactive tabs)
 * - `duo`: the outline over a soft fill of the same colour (the current tab)
 * - `solid`: filled shapes (the Spark button)
 */
export function NavGlyph({ name, size = 24, color, tone = 'line' }: { name: NavGlyphName; size?: number; color: string; tone?: 'line' | 'duo' | 'solid' }) {
  const k = size / 24;
  const mirror = I18nManager.isRTL && NAV_GLYPH_DIRECTIONAL.has(name);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      // Shapes are placed with physical left/top: lay them out left to right, then mirror on purpose.
      style={{ width: size, height: size, direction: 'ltr', transform: mirror ? [{ scaleX: -1 }] : undefined }}
    >
      {NAV_GLYPHS[name].map((s, i) => (
        <Shape key={i} shape={s} k={k} color={color} tone={tone} />
      ))}
    </View>
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
