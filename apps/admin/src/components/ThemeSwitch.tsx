'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n';

type Theme = 'system' | 'light' | 'dark';
const COOKIE = 'yl_admin_theme';

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  document.cookie = `${COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
}

/** Light / dark / follow-the-system. The choice is a cookie so the server renders the right theme with no flash. */
export function ThemeSwitch() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    setTheme(attr === 'light' || attr === 'dark' ? attr : 'system');
  }, []);
  return (
    <label className="theme-switch">
      <span className="yl-sr-only">{t('theme.label')}</span>
      <select
        className="yl-input yl-select theme-switch__select"
        value={theme}
        onChange={(e) => {
          const v = e.target.value as Theme;
          setTheme(v);
          apply(v);
        }}
      >
        <option value="system">{t('theme.system')}</option>
        <option value="light">{t('theme.light')}</option>
        <option value="dark">{t('theme.dark')}</option>
      </select>
    </label>
  );
}
