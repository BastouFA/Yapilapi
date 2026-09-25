/** RFC 5545 iCalendar generation. Pure functions so escaping/folding can be unit tested. */

export interface IcsEvent {
  id: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt: Date | null;
  locationText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  url?: string | null;
  cancelled?: boolean;
  updatedAt: Date;
}

/** Escape a TEXT value: backslash, semicolon, comma, newlines; drop other control characters. */
export function escapeIcsText(s: string): string {
  return (
    s
      .replace(/\r\n|\r|\n/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n')
  );
}

/** Fold a content line at 75 octets (never inside a UTF-8 sequence); continuation lines start with one space. */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // the leading space counts as one octet
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function icsDateTime(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function buildIcs(events: IcsEvent[], opts: { calendarName?: string } = {}): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//YAPILAPI//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  if (opts.calendarName) lines.push(`X-WR-CALNAME:${escapeIcsText(opts.calendarName)}`);
  for (const e of events) {
    const end = e.endsAt ?? new Date(e.startsAt.getTime() + 60 * 60 * 1000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@yapilapi.events`,
      `DTSTAMP:${icsDateTime(e.updatedAt)}`,
    );
    lines.push(`DTSTART:${icsDateTime(e.startsAt)}`, `DTEND:${icsDateTime(end)}`);
    lines.push(`SUMMARY:${escapeIcsText(e.title)}`);
    if (e.description?.trim()) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    if (e.locationText?.trim()) lines.push(`LOCATION:${escapeIcsText(e.locationText)}`);
    if (typeof e.latitude === 'number' && typeof e.longitude === 'number')
      lines.push(`GEO:${e.latitude.toFixed(6)};${e.longitude.toFixed(6)}`);
    if (e.url && /^https?:\/\/[^\s\r\n]+$/.test(e.url)) lines.push(`URL:${e.url}`);
    lines.push(
      `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      `SEQUENCE:${Math.max(0, Math.floor(e.updatedAt.getTime() / 1000) - 1_700_000_000)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
