import * as SecureStore from 'expo-secure-store';

/** Recent searches stay on this phone only, like the web app's (localStorage there). */
const KEY = 'ypl_recent_searches';
const MAX = 8;
/** Keeps the stored list well under the 2 KB a secure-store value should stay within. */
const MAX_LENGTH = 60;

export async function readRecent(): Promise<string[]> {
  try {
    const list = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

async function write(list: string[]) {
  try {
    if (list.length) await SecureStore.setItemAsync(KEY, JSON.stringify(list));
    else await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Not remembered; searching still works.
  }
}

/** Puts a term first (once), keeping the newest eight. Returns the new list. */
export async function rememberSearch(term: string): Promise<string[]> {
  const clean = term.trim().slice(0, MAX_LENGTH);
  if (!clean) return readRecent();
  const next = [clean, ...(await readRecent()).filter((x) => x !== clean)].slice(0, MAX);
  await write(next);
  return next;
}

export async function forgetSearch(term: string): Promise<string[]> {
  const next = (await readRecent()).filter((x) => x !== term);
  await write(next);
  return next;
}

export async function clearRecent(): Promise<void> {
  await write([]);
}
