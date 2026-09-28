import type { PublicUser } from './types.ts';

/**
 * Event tickets people carry in the app, and check-in at the door.
 *
 * Everyone who answers "going" to an event, and everyone who buys a ticket for it, gets a ticket
 * in their Tickets wallet: the event, when (in the event's time zone), where, the ticket type, the
 * holder's name, a QR code and a 6-character backup code. The QR code holds a short token signed by
 * the server (never the ticket id alone); a transfer or a refund changes it, so an old screenshot
 * stops working. The host and co-hosts check people in by scanning, by typing the backup code, or
 * from the guest list; everything works without a camera.
 *
 * No zod here: the mobile app imports this file directly. The request schemas are in ticket-schemas.ts.
 */

/** What a ticket's QR code starts with (the version of the token format). */
export const TICKET_TOKEN_PREFIX = 'YT1.';
/** Backup codes: capitals and digits that can't be mistaken for each other (no I, O, 0 or 1). */
export const TICKET_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TICKET_CODE_LENGTH = 6;
/** Check-ins a browser keeps while it's offline, per event, before it asks to reconnect. */
export const TICKET_OFFLINE_QUEUE_MAX = 500;
/** An event with no end time counts as over this many hours after it starts. */
export const EVENT_DEFAULT_HOURS = 3;

export const TICKET_STATUSES = ['valid', 'cancelled', 'refunded'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * What the door sees for a scan or a code:
 * - valid: checked in now (or already by this same device, sent again after being offline)
 * - already: checked in before, with when and by whom
 * - wrong_event: a real ticket, for another event
 * - cancelled: the RSVP was withdrawn or the event was cancelled
 * - refunded: the ticket was refunded
 * - invalid: not a ticket (a changed or old code, a copy from before a transfer)
 */
export const CHECK_IN_RESULTS = ['valid', 'already', 'wrong_event', 'cancelled', 'refunded', 'invalid'] as const;
export type CheckInResultKind = (typeof CHECK_IN_RESULTS)[number];

/** How a guest was checked in. */
export const CHECK_IN_METHODS = ['qr', 'code', 'list'] as const;
export type CheckInMethod = (typeof CHECK_IN_METHODS)[number];

/** The event, as a ticket shows it. */
export interface TicketEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  online: boolean;
  locationText: string | null;
  place: { id: string; name: string; address: string | null; city: string | null; lat: number | null; lng: number | null } | null;
  host: PublicUser;
  /** The host cancelled it. */
  cancelled: boolean;
}

/** A ticket in your wallet. */
export interface EventTicket {
  id: string;
  event: TicketEvent;
  /** 'rsvp' for answering going, 'order' for a ticket you (or the friend who gave it to you) bought. */
  source: 'rsvp' | 'order';
  /** The ticket product's name; null for an RSVP ("Free · RSVP"). */
  type: string | null;
  status: TicketStatus;
  holder: { id: string; displayName: string };
  /** For the QR code. Only while the ticket is valid. */
  token: string | null;
  /** The backup code the door can type. Only while the ticket is valid. */
  code: string | null;
  checkedInAt: string | null;
  /** Whether you can give it to a friend now: the host allows it, it's valid, not used and the event hasn't ended. */
  transferable: boolean;
  /** Who gave it to you, when it came from a friend. */
  from: PublicUser | null;
}

/**
 * Someone on the guest list, as the host and co-hosts see them. People under 18 who aren't the
 * viewer's friend show by first name only, without their username or photo (`limited`).
 */
export interface TicketGuest {
  ticketId: string;
  userId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  limited: boolean;
  type: string | null;
  status: TicketStatus;
  checkedInAt: string | null;
  checkedInBy: { id: string; name: string } | null;
}

export interface CheckInCounts {
  checkedIn: number;
  /** Valid tickets. */
  expected: number;
}

export interface CheckInResult {
  result: CheckInResultKind;
  /** The guest, for valid, already, cancelled and refunded; null otherwise (never someone else's event). */
  guest: TicketGuest | null;
  counts: CheckInCounts;
  /** The same device sent this check-in before (a retry after being offline): not a conflict. */
  replayed?: boolean;
}

/** The check-in screen: the event, your role and the counts. */
export interface DoorSummary {
  event: { id: string; title: string; startsAt: string; endsAt: string | null; timezone: string };
  role: 'host' | 'cohost';
  counts: CheckInCounts;
  ticketTransfers: boolean;
  cohosts: PublicUser[];
}

/** A backup code as typed: capitals, without spaces or dashes; null when it can't be one. */
export function normalizeTicketCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== TICKET_CODE_LENGTH) return null;
  for (const ch of code) if (!TICKET_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** What a scanner read, or what someone typed: a ticket token, a backup code, or nothing usable. */
export function readTicketInput(raw: string): { kind: 'token'; token: string } | { kind: 'code'; code: string } | null {
  const text = raw.trim();
  if (text.startsWith(TICKET_TOKEN_PREFIX) && text.length <= 120 && /^[A-Za-z0-9._-]+$/.test(text)) return { kind: 'token', token: text };
  const code = normalizeTicketCode(text);
  return code ? { kind: 'code', code } : null;
}

/** "ABC DEF": a backup code split in two, easier to read out. */
export const spacedTicketCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** When the event is over: its end, or EVENT_DEFAULT_HOURS after it starts. */
export function eventEndsAt(e: { startsAt: string; endsAt: string | null }): Date {
  return e.endsAt ? new Date(e.endsAt) : new Date(new Date(e.startsAt).getTime() + EVENT_DEFAULT_HOURS * 3600_000);
}

/** The first word of a name: how the door sees someone under 18 who isn't their friend. */
export function firstNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/** Where the event is, as one line: the place and its address, or the location text. Null when online or not announced. */
export function ticketPlaceLine(e: Pick<TicketEvent, 'online' | 'place' | 'locationText'>): string | null {
  if (e.online) return null;
  if (e.place) return [e.place.name, e.place.address, e.place.city].filter(Boolean).join(', ');
  return e.locationText || null;
}

/**
 * "Get directions": the platform's maps app with directions to the place (its coordinates when
 * known, otherwise the address as a search). OpenStreetMap on the web, Apple Maps on iOS, a geo:
 * link (the phone's choice of maps app) on Android. Null when there's nowhere to go.
 */
export function directionsUrl(e: Pick<TicketEvent, 'online' | 'place' | 'locationText'>, platform: 'web' | 'ios' | 'android'): string | null {
  if (e.online) return null;
  const lat = e.place?.lat;
  const lng = e.place?.lng;
  if (lat != null && lng != null) {
    const at = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (platform === 'ios') return `https://maps.apple.com/?daddr=${at}`;
    if (platform === 'android') return `geo:${at}?q=${at}`;
    return `https://www.openstreetmap.org/directions?route=%3B${lat.toFixed(5)}%2C${lng.toFixed(5)}`;
  }
  const line = ticketPlaceLine(e);
  if (!line) return null;
  const q = encodeURIComponent(line);
  if (platform === 'ios') return `https://maps.apple.com/?daddr=${q}`;
  if (platform === 'android') return `geo:0,0?q=${q}`;
  return `https://www.openstreetmap.org/search?query=${q}`;
}

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** Fold a content line at 75 octets, as calendars expect (continuation lines start with a space). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const size = ch.codePointAt(0)! < 0x80 ? 1 : ch.codePointAt(0)! < 0x800 ? 2 : ch.codePointAt(0)! < 0x10000 ? 3 : 4;
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += size;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * "Add to calendar": an .ics file for the ticket's event (times in UTC, which every calendar shows
 * in its own zone). Never carries the ticket's token or code.
 */
export function ticketIcs(t: Pick<EventTicket, 'id' | 'event'>, opts: { url?: string; now?: Date } = {}): string {
  const e = t.event;
  const place = e.online ? 'Online' : ticketPlaceLine(e);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//YAPILAPI//Tickets//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.id}@yapilapi`,
    `DTSTAMP:${icsDate(opts.now ?? new Date())}`,
    `DTSTART:${icsDate(new Date(e.startsAt))}`,
    `DTEND:${icsDate(eventEndsAt(e))}`,
    `SUMMARY:${icsText(e.title)}`,
    ...(place ? [`LOCATION:${icsText(place)}`] : []),
    ...(e.place?.lat != null && e.place?.lng != null ? [`GEO:${e.place.lat.toFixed(5)};${e.place.lng.toFixed(5)}`] : []),
    ...(opts.url ? [`URL:${opts.url}`] : []),
    ...(e.cancelled ? ['STATUS:CANCELLED'] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** A file name for the .ics: the event's title in plain letters. */
export function ticketIcsName(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || 'event'}.ics`;
}

/** A check-in waiting in a browser that went offline, sent when it's back. */
export interface QueuedCheckIn {
  /** Unique per scan on this device: a retry of the same one isn't a conflict. */
  clientRef: string;
  input: { token?: string; code?: string; ticketId?: string };
  method: CheckInMethod;
  scannedAt: string;
}
