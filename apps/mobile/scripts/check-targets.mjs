// Flags tappable elements whose touch area is under 44 × 44 points, from what the code says in
// literals: a Pressable's (or Touchable's) width, height, minWidth, minHeight and padding, the size
// of an icon that is its only content, and its hitSlop. It is conservative: a size that comes from
// text, a variable or the layout around it isn't known, so it isn't flagged. Where a smaller target
// is meant (the room is taken by a bigger target around it, say), put `// targets-ok: why` on the
// line above the element.
// Run: node scripts/check-targets.mjs (from apps/mobile). Exits 1 when something is flagged.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require('typescript');
} catch {
  // The phone keeps its own node_modules; the workspace root has TypeScript too.
  ts = require(new URL('../../../node_modules/typescript/lib/typescript.js', import.meta.url).pathname);
}

const MIN = 44;
const root = new URL('..', import.meta.url).pathname;
const TAGS = new Set(['Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback']);
const ICONS = new Set(['Icon', 'Ionicons']);
const tokens = JSON.parse(readFileSync(new URL('../../../packages/design-system/tokens.json', import.meta.url), 'utf8'));
// space[1] … space[8], as lib/theme.ts reads them.
const SPACE = Object.fromEntries(tokens.spacing.tokens.map((t) => [t.name.replace('space-', ''), parseInt(t.value, 10)]));

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

/** A number written in the code: 32, -4, space[3], space[3] + 2, 2 * 8. Anything else: undefined. */
function num(node) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return num(node.expression);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const v = num(node.operand);
    return v === undefined ? undefined : -v;
  }
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'space') {
    const k = node.argumentExpression;
    if (ts.isNumericLiteral(k)) return SPACE[k.text];
  }
  if (ts.isBinaryExpression(node)) {
    const a = num(node.left);
    const b = num(node.right);
    if (a === undefined || b === undefined) return undefined;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return a + b;
      case ts.SyntaxKind.MinusToken:
        return a - b;
      case ts.SyntaxKind.AsteriskToken:
        return a * b;
      case ts.SyntaxKind.SlashToken:
        return a / b;
    }
  }
  return undefined;
}

function propName(p) {
  const n = p.name;
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return undefined;
}

/** StyleSheet.create({ name: {...} }) in this file: `s.name` → its object literal. */
function sheets(sf) {
  const map = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(sf) === 'StyleSheet.create' &&
      node.initializer.arguments[0] &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      for (const p of node.initializer.arguments[0].properties) {
        const k = propName(p);
        if (k && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) map.set(`${node.name.text}.${k}`, p.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/**
 * The style an expression gives, as one or more alternatives (a condition gives each branch), each
 * a map of the size properties written as numbers. Parts that can't be read are left out.
 */
function styles(node, sheet, sf) {
  if (!node) return [{}];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) return styles(node.expression, sheet, sf);
  if (ts.isArrowFunction(node)) {
    if (ts.isBlock(node.body)) {
      const ret = node.body.statements.find(ts.isReturnStatement);
      return ret ? styles(ret.expression, sheet, sf) : [{}];
    }
    return styles(node.body, sheet, sf);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) Object.assign(out, styles(p.expression, sheet, sf)[0]);
      const k = propName(p);
      if (k && ts.isPropertyAssignment(p)) {
        const v = num(p.initializer);
        if (v !== undefined) out[k] = v;
        // A size that isn't a literal: what it is isn't known, so it overrides what came before.
        else out[k] = null;
      }
    }
    return [out];
  }
  if (ts.isPropertyAccessExpression(node)) {
    const lit = sheet.get(node.getText(sf));
    return lit ? styles(lit, sheet, sf) : [{}];
  }
  if (ts.isConditionalExpression(node)) return [...styles(node.whenTrue, sheet, sf), ...styles(node.whenFalse, sheet, sf)];
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
    // `on && {…}`: with it, or without it.
    return [...styles(node.right, sheet, sf), {}];
  }
  if (ts.isArrayLiteralExpression(node)) {
    let acc = [{}];
    for (const el of node.elements) {
      const parts = ts.isSpreadElement(el) ? styles(el.expression, sheet, sf) : styles(el, sheet, sf);
      const next = [];
      for (const a of acc) for (const b of parts) next.push({ ...a, ...b });
      // Many conditions multiply the alternatives; a few dozen are plenty to judge from.
      acc = next.slice(0, 64);
    }
    return acc;
  }
  return [{}];
}

/** How far the touch area reaches past the element on each axis, from hitSlop. */
function slop(attr) {
  if (!attr) return { x: 0, y: 0 };
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return undefined;
  const e = init.expression;
  const n = num(e);
  if (n !== undefined) return { x: 2 * n, y: 2 * n };
  if (ts.isObjectLiteralExpression(e)) {
    const side = {};
    for (const p of e.properties) {
      const k = propName(p);
      if (!k || !ts.isPropertyAssignment(p)) return undefined;
      const v = num(p.initializer);
      if (v === undefined) return undefined;
      side[k] = v;
    }
    return { x: (side.left ?? side.start ?? 0) + (side.right ?? side.end ?? 0), y: (side.top ?? 0) + (side.bottom ?? 0) };
  }
  return undefined;
}

/** The size of an icon that is the element's only content, when it is written as a number. */
function iconSize(el, sf) {
  const kids = ts.isJsxElement(el) ? el.children.filter((c) => !(ts.isJsxText(c) && !c.text.trim())) : [];
  if (kids.length !== 1) return undefined;
  const k = kids[0];
  const open = ts.isJsxSelfClosingElement(k) ? k : ts.isJsxElement(k) ? k.openingElement : undefined;
  if (!open || !ICONS.has(open.tagName.getText(sf))) return undefined;
  const size = open.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'size');
  if (!size) return open.tagName.getText(sf) === 'Icon' ? 22 : undefined;
  return size.initializer && ts.isJsxExpression(size.initializer) ? num(size.initializer.expression) : undefined;
}

function pad(st, axis) {
  const p = st.padding ?? 0;
  if (axis === 'y') return (st.paddingTop ?? st.paddingVertical ?? p) + (st.paddingBottom ?? st.paddingVertical ?? p);
  return (st.paddingStart ?? st.paddingLeft ?? st.paddingHorizontal ?? p) + (st.paddingEnd ?? st.paddingRight ?? st.paddingHorizontal ?? p);
}

/** The element's smallest size on an axis that the code fixes, or undefined when it isn't known. */
function size(st, axis, icon) {
  const [dim, min] = axis === 'y' ? ['height', 'minHeight'] : ['width', 'minWidth'];
  if (st[dim] === null || st[min] === null || st.flex === null || (st.flex ?? 0) > 0) return undefined;
  if (axis === 'y' ? st.aspectRatio !== undefined : st.aspectRatio !== undefined) return undefined;
  const fixed = st[dim];
  const least = st[min];
  if (fixed !== undefined) return Math.max(fixed, least ?? 0);
  // Without a fixed size: the icon inside plus the padding, at least the minimum.
  if (icon === undefined) return least !== undefined && least >= MIN ? least : undefined;
  const pads = [st.padding, st.paddingTop, st.paddingBottom, st.paddingVertical, st.paddingHorizontal, st.paddingStart, st.paddingEnd, st.paddingLeft, st.paddingRight];
  if (pads.includes(null)) return undefined;
  return Math.max(icon + pad(st, axis), least ?? 0);
}

const problems = [];
for (const file of [...files(join(root, 'app')), ...files(join(root, 'lib'))]) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sheet = sheets(sf);
  const lines = text.split('\n');
  const visit = (node) => {
    const open = ts.isJsxSelfClosingElement(node) ? node : ts.isJsxElement(node) ? node.openingElement : undefined;
    if (open && TAGS.has(open.tagName.getText(sf))) {
      const attrs = Object.fromEntries(open.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(sf), a]));
      const spread = open.attributes.properties.some(ts.isJsxSpreadAttribute);
      const line = sf.getLineAndCharacterOfPosition(open.getStart(sf)).line;
      const ok = /targets-ok/.test(lines[line - 1] ?? '') || /targets-ok/.test(lines[line] ?? '');
      const reach = slop(attrs.hitSlop);
      if (!ok && !spread && reach) {
        const styleExpr = attrs.style?.initializer && ts.isJsxExpression(attrs.style.initializer) ? attrs.style.initializer.expression : undefined;
        const icon = iconSize(node, sf);
        let worst;
        for (const st of styles(styleExpr, sheet, sf)) {
          const w = size(st, 'x', icon);
          const h = size(st, 'y', icon);
          const tw = w === undefined ? undefined : w + reach.x;
          const th = h === undefined ? undefined : h + reach.y;
          if ((tw !== undefined && tw < MIN) || (th !== undefined && th < MIN)) worst = { tw, th };
        }
        if (worst)
          problems.push(
            `${relative(root, file)}:${line + 1}: <${open.tagName.getText(sf)}> touch area ${worst.tw ?? '?'} × ${worst.th ?? '?'} (needs ${MIN} × ${MIN})`,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} touch target(s) under ${MIN} × ${MIN}.`);
  process.exit(1);
}
console.log(`Touch targets: nothing under ${MIN} × ${MIN} found.`);
