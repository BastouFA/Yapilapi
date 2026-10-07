/**
 * Turns a link that opens Yap into one of its screens: `yap://chat/<id>`, and the web's chat links
 * (https://…/yap/<id>, https://…/inbox/<id>) when the phone hands them to Yap. `yap://calls`,
 * `yap://stories` and `yap://settings` open those tabs. Anything else goes on as it came: a path
 * Yap has no screen for opens in YAPILAPI (app/+not-found.tsx), and Expo's development links are
 * not Yap's to change.
 */
export function yapPath(link: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(link);
  const name = scheme?.[1]!.toLowerCase();
  if (scheme && name !== 'yap' && name !== 'http' && name !== 'https') return link;
  if (scheme && (link.includes('/--/') || /^https?:\/\/(localhost|127\.|10\.|192\.168\.|\[?::1|[^/]*\.local\b)/i.test(link))) return link;
  let rest = scheme ? link.slice(scheme[0].length) : link;
  // A web link names a host first; a yap:// link starts with the path.
  if (name === 'http' || name === 'https') rest = rest.replace(/^[^/?#]*/, '');
  const [pathPart, query = ''] = rest.split('?', 2) as [string, string?];
  const parts = pathPart.split('#')[0]!.split('/').filter(Boolean);
  const [first, second] = parts;
  if (!first || first === 'expo-development-client') return '/';
  if (first === 'chat' || first === 'inbox' || first === 'yap') return second ? `/chat/${encodeURIComponent(decodeURIComponent(second))}` : '/';
  if (first === 'calls' || first === 'stories' || first === 'settings') return parts.length === 1 ? `/${first}` : `/${parts.join('/')}`;
  return scheme ? `/${parts.join('/')}${query ? `?${query}` : ''}` : link;
}
