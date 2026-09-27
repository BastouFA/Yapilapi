import type { MusicLicence, MusicSource, MusicSourceInfo } from '@yapilapi/shared';

/**
 * A music catalogue provider. Each one maps its own catalogue to these tracks and the licence each
 * comes with; the catalogue (catalog.ts) caches the metadata, checks licences and never keeps audio.
 *
 * Providers without credentials are simply off (`enabled` false): they are listed as unavailable
 * and never called.
 */
export interface ProviderTrack {
  /** The provider's own id for the song. */
  externalId: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  coverUrl: string | null;
  /**
   * Where players get the audio: the provider's preview or stream URL. Players load it themselves and
   * play only the licensed part; it is never proxied or copied here.
   */
  previewUrl: string | null;
  licence: MusicLicence;
}

export interface ProviderQuery {
  limit: number;
  /** Only songs cleared for commercial use (business accounts). */
  commercialOnly: boolean;
  /** The person's country, when known: providers that license by territory filter on it. */
  country: string | null;
}

export interface MusicProvider {
  id: Exclude<MusicSource, 'library'>;
  label: string;
  kind: MusicSourceInfo['kind'];
  enabled: boolean;
  search(q: string, opts: ProviderQuery): Promise<ProviderTrack[]>;
  trending(opts: ProviderQuery): Promise<ProviderTrack[]>;
  /** One song as the provider has it now, or null when it was withdrawn (or never existed). */
  getTrack(externalId: string): Promise<ProviderTrack | null>;
}

/** Thrown when a provider can't be reached or answers with something unexpected. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
  }
}

/** The product's own ceiling: no provider's licence makes a part longer than this here. */
export const PRODUCT_MAX_CLIP_SECONDS = 30;

/** Clamp what a licence says to what the product plays. */
export const clipSeconds = (n: unknown, fallback = PRODUCT_MAX_CLIP_SECONDS) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(5, Math.min(PRODUCT_MAX_CLIP_SECONDS, v));
};

/** Two-letter country codes only, upper case. */
export const countryList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((c) => String(c).toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))] : [];

/** http(s) URLs only. */
export const httpUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null);
