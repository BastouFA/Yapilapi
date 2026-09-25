/**
 * Opt-in, coarse location. The flag lives in localStorage (it is a consent preference, not a credential);
 * coordinates are never persisted by the client, only sent with the request that needs them.
 */
const KEY = 'yl_local_optin';

export function hasLocationOptIn(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
export function setLocationOptIn(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the choice simply lasts for this page view */
  }
}

/** Round to two decimals (about 1 km) so a precise position is never sent or stored. */
export function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

export type CoarsePosition = { latitude: number; longitude: number };
export type GeoResult =
  | { ok: true; position: CoarsePosition }
  | { ok: false; reason: 'denied' | 'unavailable' | 'timeout' };

export function requestCoarsePosition(): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, reason: 'unavailable' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          ok: true,
          position: {
            latitude: roundCoord(p.coords.latitude),
            longitude: roundCoord(p.coords.longitude),
          },
        }),
      (e) =>
        resolve({
          ok: false,
          reason:
            e.code === e.PERMISSION_DENIED
              ? 'denied'
              : e.code === e.TIMEOUT
                ? 'timeout'
                : 'unavailable',
        }),
      { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 10_000 },
    );
  });
}
