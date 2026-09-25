/** Great-circle distance in km (haversine, via the spherical law of cosines with clamping) as a SQL expression. */
export function haversineSql(
  latParam: string,
  lngParam: string,
  latCol: string,
  lngCol: string,
): string {
  return `(6371 * acos(LEAST(1, GREATEST(-1, cos(radians(${latParam})) * cos(radians(${latCol})) * cos(radians(${lngCol}) - radians(${lngParam})) + sin(radians(${latParam})) * sin(radians(${latCol}))))))`;
}

/** Same distance in JS (for post-hoc `distanceKm` on hydrated rows). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const c =
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lng2 - lng1) * rad) +
    Math.sin(lat1 * rad) * Math.sin(lat2 * rad);
  return 6371 * Math.acos(Math.min(1, Math.max(-1, c)));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Cheap rectangular pre-filter that lets Postgres use the (latitude, longitude) btree indexes before the exact
 * haversine check. Returns null when the box would cross the antimeridian or a pole (then use haversine only).
 */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox | null {
  const dLat = radiusKm / 111.32;
  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  if (minLat <= -90 || maxLat >= 90) return null;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const minLng = lng - dLng;
  const maxLng = lng + dLng;
  if (minLng < -180 || maxLng > 180) return null;
  return { minLat, maxLat, minLng, maxLng };
}
