import { Linking } from 'react-native';
import { webUrl } from '../../mobile/lib/api';

/**
 * Phone app paths whose page on the web has another name (the reverse of RENAMED in
 * apps/mobile/lib/links.ts). Everything else has the same path in both.
 */
const ON_WEB: Record<string, string> = {
  board: 'boards',
  room: 'rooms',
  chapter: 'chapters',
  event: 'events',
  drop: 'drops',
  place: 'places',
  chat: 'inbox',
  discover: 'search',
};

/** A phone app path (`/u/ada`, `/p/1`, `/board/2?x=1`) as the web app's path. */
export function webPath(path: string): string {
  const [pathPart, query] = path.split('?', 2) as [string, string?];
  const parts = pathPart.split('/').filter(Boolean);
  const first = parts[0];
  if (!first) return '/';
  if (first === 'index') parts.shift();
  else if (ON_WEB[first]) parts[0] = ON_WEB[first]!;
  return `/${parts.join('/')}${query ? `?${query}` : ''}`;
}

/**
 * Anything that isn't a chat or a call (a post, a profile, a story someone shared, a community)
 * opens in YAPILAPI when it's on this phone (yapilapi://…, mapped by its +native-intent.tsx), and on
 * the web otherwise. Web pages open under /web, which no app link covers, so they stay in the
 * browser instead of bouncing back into an app.
 */
export async function openInYapilapi(path: string): Promise<'app' | 'web'> {
  const clean = path.startsWith('/') ? path : `/${path}`;
  try {
    await Linking.openURL(`yapilapi:/${clean}`);
    return 'app';
  } catch {
    await Linking.openURL(`${webUrl}/web${webPath(clean)}`);
    return 'web';
  }
}
