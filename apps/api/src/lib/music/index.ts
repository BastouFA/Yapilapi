import type { Pool } from 'pg';
import type { Config } from '../../config.ts';
import { MusicCatalog } from './catalog.ts';
import { devProvider } from './dev.ts';
import { jamendoProvider } from './jamendo.ts';
import { licensedProvider } from './licensed.ts';

export { MusicCatalog, type PreparedMusic } from './catalog.ts';

/**
 * The music catalogue from configuration. Each provider is on only with its credentials:
 * - library (in-app sounds): always;
 * - jamendo: JAMENDO_CLIENT_ID;
 * - licensed: MUSIC_LICENSED_API_URL and MUSIC_LICENSED_API_KEY (a signed licensing deal);
 * - dev tones: outside production, unless MUSIC_DEV_PROVIDER=false.
 * See docs/operations/music.md.
 */
export function musicCatalogFromConfig(config: Config, db: Pool, opts: { fetch?: typeof fetch; log?: (msg: string, err?: unknown) => void } = {}) {
  return new MusicCatalog(
    db,
    [
      jamendoProvider({ clientId: config.JAMENDO_CLIENT_ID, baseUrl: config.JAMENDO_API_URL, fetch: opts.fetch }),
      licensedProvider({
        baseUrl: config.MUSIC_LICENSED_API_URL,
        apiKey: config.MUSIC_LICENSED_API_KEY,
        name: config.MUSIC_LICENSED_NAME,
        fetch: opts.fetch,
      }),
      devProvider({ enabled: config.MUSIC_DEV_PROVIDER, publicApiUrl: config.PUBLIC_API_URL }),
    ],
    opts.log,
  );
}
