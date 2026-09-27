// Whether the API can be reached, worked out from the requests the app makes (there is no
// network-status module in the app, and none may be added). A request that fails before any
// answer comes back (fetch throws) marks the app offline; any answer at all, even an error
// status, marks it online again. While offline, a light check runs now and then so the banner
// goes away on its own once the connection is back. No imports from the rest of the app, so
// lib/api.ts can use it without a require cycle.
import { useSyncExternalStore } from 'react';

let online = true;
const listeners = new Set<() => void>();
const backOnline = new Set<() => void>();
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let probeDelay = 5000;
let probeUrl: string | null = null;

function set(next: boolean) {
  if (next === online) return;
  online = next;
  listeners.forEach((l) => l());
  if (next) {
    clearTimeout(probeTimer);
    probeDelay = 5000;
    backOnline.forEach((l) => l());
  } else scheduleProbe();
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    void checkConnection().then((ok) => {
      if (!ok) {
        // Every 5, 10, 20, then 30 seconds: often enough to notice, light on the battery.
        probeDelay = Math.min(30_000, probeDelay * 2);
        scheduleProbe();
      }
    });
  }, probeDelay);
}

/** Where the light check goes (the API's liveness endpoint). Set once by lib/api.ts. */
export function setProbeUrl(url: string) {
  probeUrl = url;
}

/** A fetch that reports whether the network answered. Pass it to the API client. */
export const trackedFetch: typeof fetch = async (input, init) => {
  try {
    const res = await fetch(input, init);
    set(true);
    return res;
  } catch (e) {
    // A request cancelled on purpose says nothing about the connection.
    if (!(e instanceof Error && e.name === 'AbortError')) set(false);
    throw e;
  }
};

/** Try the API once now. Resolves true when it answered (and clears the offline state). */
export async function checkConnection(): Promise<boolean> {
  if (!probeUrl) return online;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(probeUrl, { method: 'GET', signal: ctrl.signal });
    set(true);
    return true;
  } catch {
    set(false);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const isOnline = () => online;

/** true while the API answers; false after a request could not reach it. */
export function useOnline() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => online,
  );
}

/** Runs `fn` each time the app gets its connection back. Returns an unsubscribe function. */
export function onBackOnline(fn: () => void) {
  backOnline.add(fn);
  return () => void backOnline.delete(fn);
}
