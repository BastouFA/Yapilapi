/**
 * Token registry. The CSS file is the source of truth; this module names the tokens for TypeScript consumers and
 * declares which pairs must satisfy which contrast level (enforced by tokens.test.ts against the real CSS).
 */

export const colorRoles = [
  'bg',
  'surface',
  'surface-subtle',
  'surface-sunken',
  'overlay',
  'text',
  'text-muted',
  'text-subtle',
  'text-inverse',
  'border',
  'border-strong',
  'primary',
  'primary-hover',
  'primary-active',
  'on-primary',
  'primary-text',
  'primary-soft',
  'on-primary-soft',
  'secondary',
  'secondary-hover',
  'on-secondary',
  'secondary-soft',
  'on-secondary-soft',
  'accent',
  'on-accent',
  'success',
  'success-soft',
  'warning',
  'warning-soft',
  'danger',
  'danger-soft',
  'info',
  'info-soft',
  'focus',
  'focus-halo',
] as const;
export type ColorRole = (typeof colorRoles)[number];

/** `var(--yl-color-…)` reference for use in inline styles or CSS-in-JS. */
export const color = (role: ColorRole): string => `var(--yl-color-${role})`;
export const space = (n: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16): string =>
  `var(--yl-space-${n})`;

export const breakpoints = { sm: 480, md: 768, lg: 1024, xl: 1280 } as const;

export type ContrastLevel = 'text' | 'ui' | 'aaa';

/** [foreground role, background role, required level]. Checked for light, dark and both high-contrast variants. */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [ColorRole, ColorRole, ContrastLevel]> = [
  ['text', 'bg', 'text'],
  ['text', 'surface', 'text'],
  ['text', 'surface-subtle', 'text'],
  ['text', 'surface-sunken', 'text'],
  ['text-muted', 'bg', 'text'],
  ['text-muted', 'surface', 'text'],
  ['text-muted', 'surface-subtle', 'text'],
  ['text-subtle', 'bg', 'text'],
  ['text-subtle', 'surface', 'text'],
  ['text-subtle', 'surface-subtle', 'text'],
  ['text-subtle', 'surface-sunken', 'text'],
  ['on-primary', 'primary', 'text'],
  ['on-primary', 'primary-hover', 'text'],
  ['on-primary', 'primary-active', 'text'],
  ['primary-text', 'bg', 'text'],
  ['primary-text', 'surface', 'text'],
  ['primary-text', 'surface-subtle', 'text'],
  ['on-primary-soft', 'primary-soft', 'text'],
  ['on-secondary', 'secondary', 'text'],
  ['on-secondary', 'secondary-hover', 'text'],
  ['on-secondary-soft', 'secondary-soft', 'text'],
  ['secondary', 'bg', 'text'],
  ['secondary', 'surface', 'text'],
  ['on-accent', 'accent', 'text'],
  ['success', 'surface', 'text'],
  ['success', 'success-soft', 'text'],
  ['warning', 'surface', 'text'],
  ['warning', 'warning-soft', 'text'],
  ['danger', 'surface', 'text'],
  ['danger', 'danger-soft', 'text'],
  ['info', 'surface', 'text'],
  ['info', 'info-soft', 'text'],
  ['border-strong', 'surface', 'ui'],
  ['border-strong', 'bg', 'ui'],
  ['focus', 'bg', 'ui'],
  ['focus', 'surface', 'ui'],
  ['primary', 'bg', 'ui'], // accent is decorative only: it always carries on-accent text and is never the sole indicator
];
