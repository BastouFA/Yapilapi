// Compiles tokens.json (the YAPILAPI design system source of truth) into src/tokens.css.
// Light is the default; dark applies with prefers-color-scheme unless data-theme="light",
// and always with data-theme="dark". Run: pnpm --filter @yapilapi/design-system build:tokens
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const t = JSON.parse(readFileSync(path.join(root, 'tokens.json'), 'utf8'));

const themed = [...t.color.tokens, ...(t.shadow?.tokens ?? [])];
const val = (tok, theme) => (typeof tok.value === 'string' ? tok.value : (tok.value[theme] ?? tok.value.light));
const decls = (theme) => themed.map((tok) => `  --${tok.name}: ${val(tok, theme)};`).join('\n');

const flat = ['spacing', 'radius', 'size', 'duration'].flatMap((k) => t[k]?.tokens ?? []);
const fonts = Object.entries(t.type.families).map(([k, v]) => `  --font-${k}: ${v};`).join('\n');

const styles = t.type.groups
  .flatMap((g) =>
    g.styles.map((s) => {
      const lines = [`  font-family: var(--font-${s.family ?? g.family});`, `  font-size: ${s.fontSize};`, `  line-height: ${s.lineHeight};`, `  font-weight: ${s.fontWeight};`];
      if (s.letterSpacing) lines.push(`  letter-spacing: ${s.letterSpacing};`);
      return `.type-${s.name} {\n${lines.join('\n')}\n}`;
    }),
  )
  .join('\n');

const css = `/* Generated from tokens.json by scripts/build-tokens.mjs. Do not edit by hand. */
:root {
  color-scheme: light;
${decls('light')}
${flat.map((tok) => `  --${tok.name}: ${tok.value};`).join('\n')}
${fonts}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
${decls('dark').replace(/^/gm, '  ')}
  }
}
:root[data-theme='dark'] {
  color-scheme: dark;
${decls('dark')}
}
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-base: 0ms;
  }
}
${styles}
`;
writeFileSync(path.join(root, 'src/tokens.css'), css);
console.log('wrote src/tokens.css');
