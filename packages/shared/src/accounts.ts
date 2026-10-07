/**
 * The accounts signed in on one phone (the mobile app's account switcher), as plain data. The
 * app keeps each account's session token in the keychain; the decisions about the list itself
 * live here so they can be tested: what is kept, what leaves past the limit, who takes over when
 * the account in use logs out, and when a failed check means the session really ended.
 */

export const MAX_DEVICE_ACCOUNTS = 5;

/** An account on this phone: enough to show it in the switcher (never its token). */
export interface DeviceAccount {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * An account signed in on this browser (the website's account switcher, GET /v1/auth/accounts).
 * The API keeps the sessions in an httpOnly cookie and switches between them; the page never
 * sees a token. `unread`: its unread notifications, for the accounts not in use (0 for the one in use).
 */
export interface BrowserAccount extends DeviceAccount {
  current: boolean;
  unread: number;
}

function isAccount(a: unknown): a is DeviceAccount {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return typeof x.id === 'string' && !!x.id && typeof x.username === 'string' && typeof x.displayName === 'string';
}

/**
 * The saved list, from what was stored: anything unreadable is dropped, each account appears once
 * (its first entry wins), and there are at most `max`.
 */
export function parseDeviceAccounts(raw: string | null | undefined, max = MAX_DEVICE_ACCOUNTS): DeviceAccount[] {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: DeviceAccount[] = [];
  for (const a of list) {
    if (!isAccount(a) || out.some((x) => x.id === a.id)) continue;
    out.push({ id: a.id, username: a.username, displayName: a.displayName, avatarUrl: typeof a.avatarUrl === 'string' ? a.avatarUrl : null });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The account in use joins the list, or its name and photo are updated where it already is (its
 * place doesn't change). A new account past the limit makes the oldest others leave this phone:
 * `evicted` are their ids, whose tokens should be deleted. The account in use never leaves.
 */
export function upsertDeviceAccount(list: DeviceAccount[], entry: DeviceAccount, max = MAX_DEVICE_ACCOUNTS): { list: DeviceAccount[]; evicted: string[] } {
  const at = list.findIndex((a) => a.id === entry.id);
  const next = at >= 0 ? list.map((a, i) => (i === at ? entry : a)) : [...list, entry];
  const evicted: string[] = [];
  const limit = Math.max(1, max);
  while (next.length > limit) {
    const i = next.findIndex((a) => a.id !== entry.id);
    if (i < 0) break;
    evicted.push(next.splice(i, 1)[0]!.id);
  }
  return { list: next, evicted };
}

/** The list without one account. */
export function withoutDeviceAccount(list: DeviceAccount[], id: string): DeviceAccount[] {
  return list.filter((a) => a.id !== id);
}

/**
 * Who to try, in order, when the account in use goes away (logged out here or elsewhere): every
 * other account on the phone, in the order they were added. The one leaving is never tried.
 */
export function takeOverCandidates(list: DeviceAccount[], leavingId?: string | null): DeviceAccount[] {
  return list.filter((a) => a.id !== leavingId);
}

/**
 * What a failed "who am I" check means for a saved session:
 * - 'ended': the API said the session is no longer valid (401). Forget it.
 * - 'offline': the API couldn't be reached. Keep everything and check again once it can.
 * - 'unavailable': the API answered with something else (a server error, too many requests). The
 *   session may well be fine: keep it and check again later, never sign the person out for it.
 */
export type SessionCheckFailure = 'ended' | 'offline' | 'unavailable';

export function sessionCheckFailure(e: unknown): SessionCheckFailure {
  const err = e as { status?: unknown; code?: unknown } | null;
  if (err && err.code === 'network') return 'offline';
  if (err && err.status === 401) return 'ended';
  return 'unavailable';
}

/** What trying the other accounts came to (see takeOver). */
export type TakeOverResult<U> =
  /** This account is now in use, and the API confirmed who it is. */
  | { kind: 'switched'; account: DeviceAccount; user: U }
  /** This account is now in use, but the API couldn't confirm it yet: keep loading and check again. */
  | { kind: 'pending'; account: DeviceAccount; reason: 'offline' | 'unavailable' }
  /** No account on this phone has a working session: back to the welcome screen. */
  | { kind: 'none' };

/**
 * Make the next account with a working session the one in use. Accounts whose token is gone, or
 * whose session the API says has ended, are forgotten on the way. When the API can't be reached
 * (or has a problem), the account stays in use and nothing is forgotten: showing the welcome
 * screen then would sign the person out of an account that is still signed in.
 */
export async function takeOver<U>(
  candidates: DeviceAccount[],
  deps: { activate: (id: string) => Promise<boolean>; whoAmI: () => Promise<U>; forget: (id: string) => Promise<unknown> },
): Promise<TakeOverResult<U>> {
  for (const account of candidates) {
    if (!(await deps.activate(account.id))) {
      await deps.forget(account.id);
      continue;
    }
    try {
      return { kind: 'switched', account, user: await deps.whoAmI() };
    } catch (e) {
      const failure = sessionCheckFailure(e);
      if (failure !== 'ended') return { kind: 'pending', account, reason: failure };
      await deps.forget(account.id);
    }
  }
  return { kind: 'none' };
}
