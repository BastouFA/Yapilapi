import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';

/**
 * The 3D view of game boards in chats: flat unless you turn it on. The choice stays on this phone
 * (never sent), like the web app's (localStorage there), and every open board follows it.
 */
const KEY = 'ypl_games_3d';

let current: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

function load() {
  if (current !== null) return;
  SecureStore.getItemAsync(KEY)
    .then((v) => {
      if (current !== null) return;
      current = v === '1';
      listeners.forEach((l) => l(current!));
    })
    .catch(() => {});
}

function setGame3D(on: boolean) {
  current = on;
  listeners.forEach((l) => l(on));
  (on ? SecureStore.setItemAsync(KEY, '1') : SecureStore.deleteItemAsync(KEY)).catch(() => {
    // Not remembered; the choice still lasts while the app is open.
  });
}

/** `const [threeD, setThreeD] = useGame3D()`. */
export function useGame3D(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(current ?? false);
  useEffect(() => {
    listeners.add(setOn);
    load();
    if (current !== null) setOn(current);
    return () => void listeners.delete(setOn);
  }, []);
  return [on, setGame3D];
}
