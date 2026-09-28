import { RTL_LOCALES } from '@yapilapi/shared';

/** Where this browser remembers the signed-in reader's language (app/providers.tsx sets and clears it). */
export const LOCALE_KEY = 'ypl_locale';

/**
 * Runs in <head> before the page paints (app/layout.tsx): a returning reader's page starts with
 * their language on <html lang> and its direction on <html dir>, so Arabic never paints left to
 * right first. The account's language still decides once it arrives. Kept out of the 'use client'
 * modules so the server layout can inline it.
 */
export const LOCALE_SCRIPT = `try{var l=localStorage.getItem('${LOCALE_KEY}');if(l&&/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(l)){var r=document.documentElement;r.lang=l;r.dir=${JSON.stringify([...RTL_LOCALES])}.indexOf(l.split('-')[0])>=0?'rtl':'ltr'}}catch(e){}`;

/** The language this browser last showed a signed-in reader, if any. */
export function readLocaleHint(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

/** Remember the signed-in reader's language, or forget it (null) once nobody is signed in. */
export function writeLocaleHint(locale: string | null) {
  try {
    if (locale) localStorage.setItem(LOCALE_KEY, locale);
    else localStorage.removeItem(LOCALE_KEY);
  } catch {
    // Storage blocked: pages start in English's direction until the account arrives, as before.
  }
}
