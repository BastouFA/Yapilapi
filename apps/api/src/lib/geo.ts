/** Great-circle helpers shared by events and places (no PostGIS dependency). */

export const EARTH_RADIUS_KM = 6371.0088;

const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** SQL expression (double precision, km) for the haversine distance between column pair and the given parameter placeholders. */
export function haversineSql(
  latCol: string,
  lngCol: string,
  latParam: string,
  lngParam: string,
): string {
  return `(${EARTH_RADIUS_KM} * 2 * asin(sqrt(least(1.0, power(sin(radians(${latCol} - ${latParam}::float8) / 2), 2)
    + cos(radians(${latParam}::float8)) * cos(radians(${latCol})) * power(sin(radians(${lngCol} - ${lngParam}::float8) / 2), 2)))))`;
}

export interface GeoBounds {
  latMin: number;
  latMax: number;
  /** One or two longitude ranges (two when the box crosses the antimeridian); null = all longitudes. */
  lngRanges: Array<[number, number]> | null;
}

/** Bounding box that contains every point within `km` of the centre. Used as an index-friendly prefilter before the exact haversine test. */
export function geoBounds(lat: number, lng: number, km: number): GeoBounds {
  const dLat = (km / EARTH_RADIUS_KM) * (180 / Math.PI);
  const latMin = Math.max(-90, lat - dLat);
  const latMax = Math.min(90, lat + dLat);
  if (latMin <= -90 || latMax >= 90) return { latMin, latMax, lngRanges: null };
  const dLng =
    (Math.asin(Math.min(1, Math.sin(dLat * (Math.PI / 180)) / Math.cos(rad(lat)))) * 180) / Math.PI;
  if (!Number.isFinite(dLng) || dLng >= 180) return { latMin, latMax, lngRanges: null };
  const lo = lng - dLng;
  const hi = lng + dLng;
  if (lo < -180)
    return {
      latMin,
      latMax,
      lngRanges: [
        [lo + 360, 180],
        [-180, hi],
      ],
    };
  if (hi > 180)
    return {
      latMin,
      latMax,
      lngRanges: [
        [lo, 180],
        [-180, hi - 360],
      ],
    };
  return { latMin, latMax, lngRanges: [[lo, hi]] };
}

/**
 * Append bounding-box conditions to a parameter list and return the SQL fragment.
 * `params` is mutated (values pushed); placeholders continue from params.length.
 */
export function boundsSql(latCol: string, lngCol: string, b: GeoBounds, params: unknown[]): string {
  params.push(b.latMin, b.latMax);
  const parts = [`${latCol} BETWEEN $${params.length - 1} AND $${params.length}`];
  if (b.lngRanges) {
    const ors = b.lngRanges.map(([a, z]) => {
      params.push(a, z);
      return `${lngCol} BETWEEN $${params.length - 1} AND $${params.length}`;
    });
    parts.push(`(${ors.join(' OR ')})`);
  }
  return parts.join(' AND ');
}
