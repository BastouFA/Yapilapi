/** Where the Appearance choice is kept in the browser (see lib/theme.ts). */
export const THEME_KEY = 'ypl_theme';

/**
 * Runs in <head> before the page paints (app/layout.tsx), so a saved Light or Dark choice never
 * flashes the other theme first. Kept out of the 'use client' module so the server layout can
 * inline it.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
