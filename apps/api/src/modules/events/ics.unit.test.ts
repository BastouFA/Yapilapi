import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldIcsLine, icsDateTime } from './ics.js';

const base = {
  id: '11111111-2222-3333-4444-555555555555',
  title: 'Launch party',
  startsAt: new Date('2026-10-01T18:30:00Z'),
  endsAt: new Date('2026-10-01T21:00:00Z'),
  updatedAt: new Date('2026-09-21T10:00:00Z'),
};

describe('ics', () => {
  it('escapes text per RFC 5545', () => {
    expect(escapeIcsText('a, b; c\\d\nnext')).toBe('a\\, b\\; c\\\\d\\nnext');
    expect(escapeIcsText('line1\r\nline2')).toBe('line1\\nline2');
    expect(escapeIcsText('bad\u0000ctl\u0007')).toBe('badctl');
    // header injection attempt cannot start a new content line
    expect(escapeIcsText('x\r\nATTENDEE:mailto:evil@example.com')).not.toContain('\r');
    expect(escapeIcsText('x\r\nATTENDEE:mailto:evil@example.com')).not.toContain('\n');
  });

  it('formats UTC timestamps', () => {
    expect(icsDateTime(new Date('2026-10-01T18:30:05.123Z'))).toBe('20261001T183005Z');
  });

  it('folds long lines at 75 octets without splitting multi-byte characters', () => {
    const long = 'DESCRIPTION:' + 'é'.repeat(100);
    const folded = foldIcsLine(long);
    for (const part of folded.split('\r\n'))
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    const parts = folded.split('\r\n');
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(long);
    expect(foldIcsLine('SHORT:line')).toBe('SHORT:line');
  });

  it('builds a well-formed calendar', () => {
    const ics = buildIcs(
      [
        {
          ...base,
          description: 'Bring snacks, drinks; and\nfriends',
          locationText: 'Main St, Springfield',
          latitude: 40.7128,
          longitude: -74.006,
          url: 'https://example.com/events/1',
        },
      ],
      { calendarName: 'My, cal' },
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/); // every newline is CRLF
    expect(ics).toContain('VERSION:2.0\r\n');
    expect(ics).toContain('UID:11111111-2222-3333-4444-555555555555@yapilapi.events\r\n');
    expect(ics).toContain('DTSTART:20261001T183000Z\r\n');
    expect(ics).toContain('DTEND:20261001T210000Z\r\n');
    expect(ics).toContain('SUMMARY:Launch party\r\n');
    expect(ics).toContain('DESCRIPTION:Bring snacks\\, drinks\\; and\\nfriends\r\n');
    expect(ics).toContain('LOCATION:Main St\\, Springfield\r\n');
    expect(ics).toContain('GEO:40.712800;-74.006000\r\n');
    expect(ics).toContain('X-WR-CALNAME:My\\, cal\r\n');
    expect(ics).toContain('STATUS:CONFIRMED\r\n');
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect((ics.match(/END:VEVENT/g) ?? []).length).toBe(1);
  });

  it('defaults the end to one hour, marks cancellations and refuses unsafe urls', () => {
    const ics = buildIcs([{ ...base, endsAt: null, cancelled: true, url: 'javascript:alert(1)' }]);
    expect(ics).toContain('DTEND:20261001T193000Z\r\n');
    expect(ics).toContain('STATUS:CANCELLED\r\n');
    expect(ics).not.toContain('URL:');
    expect(ics).not.toContain('DESCRIPTION');
  });
});
