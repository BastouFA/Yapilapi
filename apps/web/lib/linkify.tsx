import Link from 'next/link';
import type { ReactNode } from 'react';

/** Web addresses in text people wrote: http(s) links and www. ones. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

/** Punctuation that ends a sentence rather than the address ("see yapilapi.com/p/1."). */
const TRAILING = /[.,;:!?)\]}'"’”]+$/;

const OUR_HOSTS = new Set(['yapilapi.com', 'www.yapilapi.com']);

/**
 * Text with its web addresses as links you can tap. Our own pages open in the app; other sites
 * open in a new tab, without telling them where the link was.
 */
export function linkify(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(TRAILING, '');
    const at = m.index!;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(<LinkOut key={at} raw={raw} />);
    last = at + raw.length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function LinkOut({ raw }: { raw: string }) {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return raw;
  }
  const here = typeof window !== 'undefined' ? window.location.host : '';
  if (OUR_HOSTS.has(url.host) || url.host === here)
    return (
      <Link href={url.pathname + url.search + url.hash} className="chat-link">
        {raw}
      </Link>
    );
  return (
    <a href={url.href} target="_blank" rel="noopener noreferrer nofollow" className="chat-link">
      {raw}
    </a>
  );
}
