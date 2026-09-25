import type { ReactNode } from 'react';

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])/g;

/** Turn plain text into React nodes with safe external links. Never uses dangerouslySetInnerHTML. */
export function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    let href = m[0];
    try {
      const u = new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      href = u.toString();
      parts.push(
        <a
          key={idx}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="yl-richtext__link"
          dir="ltr"
        >
          {m[0]}
        </a>,
      );
    } catch {
      parts.push(m[0]);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className="yl-richtext">{parts}</span>;
}
