import { preferredLocale, RTL_LOCALES, SUPPORTED_LOCALES } from '@yapilapi/shared';

/** Where this browser remembers the signed-in reader's language (app/providers.tsx sets and clears it). */
export const LOCALE_KEY = 'ypl_locale';
/** A language someone chose here without an account (the language picker on signed-out pages). */
export const LOCALE_CHOICE_KEY = 'ypl_locale_choice';
/** On <html> while the page waits for its language, so nothing shows in English first. */
export const LOCALE_PENDING_ATTR = 'data-locale-pending';

/**
 * Runs in <head> before the page paints (app/layout.tsx). The page starts in the language it will
 * show: a returning reader's (the account's, remembered), else a language chosen here without an
 * account, else the first of the browser's languages the app has, else English. It goes on
 * <html lang> and its direction on <html dir>, so Arabic never paints left to right first. Until
 * that language's text has loaded the page stays hidden (globals.css), for three seconds at most.
 * Same order as startLocale() below; the account's language still decides once it arrives. Kept
 * out of the 'use client' modules so the server layout can inline it.
 */
export const LOCALE_SCRIPT = `try{var d=document.documentElement,S=${JSON.stringify(SUPPORTED_LOCALES)},l=null,c=null;try{l=localStorage.getItem('${LOCALE_KEY}');c=localStorage.getItem('${LOCALE_CHOICE_KEY}')}catch(e){}if(!l||!/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(l))l=c&&S.indexOf(c)>=0?c:null;if(!l){var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];for(var i=0;i<n.length&&!l;i++){var b=String(n[i]||'').replace(/_/g,'-').split('-')[0].toLowerCase();if(S.indexOf(b)>=0)l=b}}l=l||'en';var g=l.split('-')[0];d.lang=l;d.dir=${JSON.stringify([...RTL_LOCALES])}.indexOf(g)>=0?'rtl':'ltr';if(g!=='en'&&S.indexOf(g)>=0){d.setAttribute('${LOCALE_PENDING_ATTR}','');setTimeout(function(){d.removeAttribute('${LOCALE_PENDING_ATTR}')},3000)}}catch(e){}`;

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

/** The language for someone without an account: the one they chose here, else the browser's. */
export function visitorLocale(): string {
  try {
    const chosen = localStorage.getItem(LOCALE_CHOICE_KEY);
    if (chosen && SUPPORTED_LOCALES.includes(chosen)) return chosen;
  } catch {
    // Storage blocked: the browser's languages.
  }
  return preferredLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** The language a page starts in, before the account is known (the order LOCALE_SCRIPT uses). */
export function startLocale(): string {
  const hint = readLocaleHint();
  return hint && /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(hint) ? hint : visitorLocale();
}

/** Remember the language someone chose without an account. */
export function writeLocaleChoice(locale: string) {
  try {
    localStorage.setItem(LOCALE_CHOICE_KEY, locale);
  } catch {
    // Storage blocked: the choice lasts until the page is closed.
  }
}

/** The page's language has loaded and shows: stop hiding it. */
export function revealLocale() {
  document.documentElement.removeAttribute(LOCALE_PENDING_ATTR);
}
