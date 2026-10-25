import { api } from './api';
import { currentSubscription } from './push';

/**
 * More than one account in this browser (components/AccountMenu.tsx). The API keeps every
 * account's session in an httpOnly cookie and switches between them (apps/api/src/modules/
 * browser-accounts.ts): the page never holds a token. After a switch the page loads again from
 * the start, so nothing of the other account stays in memory (its feed, chats, counts, the
 * realtime socket), and what this browser kept for the other account goes.
 */

/** Where to land after switching: Yap mode stays in Yap mode. */
export function homeFor(path: string): string {
  return path.startsWith('/yap') ? '/yap' : '/home';
}

/** Browser storage that belongs to the account in use, not to the browser. */
function forgetAccountData() {
  try {
    localStorage.removeItem('yp.search.recent');
    localStorage.removeItem('yp.suggest.hidden');
  } catch {
    // Storage turned off: nothing was kept.
  }
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('ypl-ingest-') || k === 'ypl_beat') sessionStorage.removeItem(k);
  } catch {
    // As above.
  }
}

/**
 * This browser's notifications follow the account in use: the subscription it already has moves
 * to it (the API keeps one account per subscription). Nothing happens when notifications are off.
 */
async function movePush() {
  const sub = await currentSubscription().catch(() => null);
  if (!sub || Notification.permission !== 'granted') return;
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.push.subscribe({ kind: 'webpush', endpoint: json.endpoint, keys: json.keys }).catch(() => {});
}

/** Another account is now in use (switched, added, or took over after a log out): start the page again as it. */
export async function startAs(dest: string) {
  forgetAccountData();
  await Promise.race([movePush(), new Promise((r) => setTimeout(r, 2500))]);
  location.replace(dest);
}

/** Log in or Sign up, keeping where you were going and whether an account is being added. */
export function authHref(page: '/login' | '/signup', next: string | null, adding: boolean): string {
  const q = new URLSearchParams({ ...(next ? { next } : {}), ...(adding ? { add: '1' } : {}) }).toString();
  return q ? `${page}?${q}` : page;
}

/** Use another account signed in on this browser. Throws when its session has ended (it leaves the list). */
export async function switchAccount(userId: string, dest: string) {
  await api.auth.switchAccount(userId);
  await startAs(dest);
}
