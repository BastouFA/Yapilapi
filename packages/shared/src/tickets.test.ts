import { describe, expect, it } from 'vitest';
import {
  directionsUrl,
  eventEndsAt,
  firstNameOf,
  normalizeTicketCode,
  readTicketInput,
  spacedTicketCode,
  ticketIcs,
  ticketIcsName,
  ticketPlaceLine,
  type TicketEvent,
} from './tickets.ts';

const host = { id: 'h', username: 'ada', displayName: 'Ada Obi', avatarUrl: null, mode: 'personal' as const };
const event = (over: Partial<TicketEvent> = {}): TicketEvent => ({
  id: '5b1c2f4e-0000-4000-8000-000000000001',
  title: 'Rooftop night, with friends; bring a jacket',
  startsAt: '2026-10-03T18:00:00.000Z',
  endsAt: null,
  timezone: 'Africa/Lagos',
  online: false,
  locationText: null,
  place: { id: 'p', name: 'Terra Kulture', address: '1376 Tiamiyu Savage St', city: 'Lagos', lat: 6.4281, lng: 3.4219 },
  host,
  cancelled: false,
  ...over,
});

describe('backup codes and scans', () => {
  it('reads a typed code however it was typed', () => {
    expect(normalizeTicketCode('abc-def')).toBe('ABCDEF');
    expect(normalizeTicketCode('ab3 k7q')).toBe('AB3K7Q');
    expect(normalizeTicketCode('AB3K7Q')).toBe('AB3K7Q');
    // Letters and digits that look alike are never in a code.
    expect(normalizeTicketCode('AB3K7O')).toBe(null);
    expect(normalizeTicketCode('AB3K71')).toBe(null);
    expect(normalizeTicketCode('AB3K7')).toBe(null);
  });

  it('tells a token from a code', () => {
    expect(readTicketInput('  YT1.abc_DEF-123  ')).toEqual({ kind: 'token', token: 'YT1.abc_DEF-123' });
    expect(readTicketInput('hkm 2p9')).toEqual({ kind: 'code', code: 'HKM2P9' });
    expect(readTicketInput('https://example.com')).toBe(null);
    expect(readTicketInput('YT1.<script>')).toBe(null);
    expect(spacedTicketCode('HKM2P9')).toBe('HKM 2P9');
  });

  it('shows someone by first name only', () => {
    expect(firstNameOf('  Tobi   Ade ')).toBe('Tobi');
    expect(firstNameOf('Kemi')).toBe('Kemi');
  });
});

describe('ticket details', () => {
  it('ends three hours after the start when no end is given', () => {
    expect(eventEndsAt(event()).toISOString()).toBe('2026-10-03T21:00:00.000Z');
    expect(eventEndsAt(event({ endsAt: '2026-10-03T23:30:00.000Z' })).toISOString()).toBe('2026-10-03T23:30:00.000Z');
  });

  it('says where, and links to directions', () => {
    expect(ticketPlaceLine(event())).toBe('Terra Kulture, 1376 Tiamiyu Savage St, Lagos');
    expect(directionsUrl(event(), 'web')).toBe('https://www.openstreetmap.org/directions?route=%3B6.42810%2C3.42190');
    expect(directionsUrl(event(), 'ios')).toBe('https://maps.apple.com/?daddr=6.42810,3.42190');
    expect(directionsUrl(event(), 'android')).toBe('geo:6.42810,3.42190?q=6.42810,3.42190');
    const text = event({ place: null, locationText: 'Freedom Park, Lagos' });
    expect(directionsUrl(text, 'web')).toBe('https://www.openstreetmap.org/search?query=Freedom%20Park%2C%20Lagos');
    expect(directionsUrl(text, 'android')).toBe('geo:0,0?q=Freedom%20Park%2C%20Lagos');
    expect(directionsUrl(event({ online: true }), 'web')).toBe(null);
    expect(directionsUrl(event({ place: null }), 'web')).toBe(null);
  });

  it('makes a calendar file without the token or code', () => {
    const ics = ticketIcs(
      { id: 't1', event: event() },
      { now: new Date('2026-09-28T10:00:00Z'), url: 'https://yapilapi.app/events/5b1c2f4e-0000-4000-8000-000000000001' },
    );
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART:20261003T180000Z');
    expect(ics).toContain('DTEND:20261003T210000Z');
    expect(ics).toContain('DTSTAMP:20260928T100000Z');
    expect(ics).toContain('SUMMARY:Rooftop night\\, with friends\\; bring a jacket');
    expect(ics).toContain('GEO:6.42810;3.42190');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // Long lines fold at 75 octets.
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, '')).toContain('URL:https://yapilapi.app/events/5b1c2f4e-0000-4000-8000-000000000001');
    expect(ticketIcs({ id: 't1', event: event({ cancelled: true, online: true }) })).toContain('STATUS:CANCELLED');
    expect(ticketIcs({ id: 't1', event: event({ online: true }) })).toContain('LOCATION:Online');
  });

  it('names the file after the event', () => {
    expect(ticketIcsName('Rooftop night: Lagos')).toBe('Rooftop-night-Lagos.ics');
    expect(ticketIcsName('!!!')).toBe('event.ics');
  });
});
