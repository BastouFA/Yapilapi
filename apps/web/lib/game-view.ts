'use client';

import { useSyncExternalStore } from 'react';

/**
 * The 3D view of game boards in chats: off (flat boards) unless you turn it on. The choice is kept
 * in this browser only (never sent), and every board follows it, in this tab and others.
 */
const KEY = 'yp.games.3d';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let current: boolean | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    listeners.forEach((l) => l());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

const snapshot = () => (current ??= read());

function setGame3D(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Private windows can refuse storage: the choice still lasts for this visit.
  }
  current = on;
  listeners.forEach((l) => l());
}

/** `const [threeD, setThreeD] = useGame3D()`. Flat on the server and until the page has loaded. */
export function useGame3D(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, snapshot, () => false), setGame3D];
}
