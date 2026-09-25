import type { AppConfig } from '@yapilapi/config';

/** Public URL for a stored object: CDN when configured, otherwise the API's media base URL. */
export function mediaUrl(config: AppConfig, storageKey: string): string {
  const base = config.CDN_BASE_URL ?? config.MEDIA_PUBLIC_BASE_URL;
  return `${base.replace(/\/$/, '')}/${storageKey}`;
}
