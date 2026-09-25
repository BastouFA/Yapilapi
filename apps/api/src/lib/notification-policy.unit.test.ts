import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHANNELS,
  decideDelivery,
  inQuietWindow,
  KIND_CATEGORY,
  categoryFor,
  localMinutes,
  NOTIFICATION_CATEGORIES,
  PUSH_COPY,
  TEEN_QUIET_HOURS,
  UNDISABLEABLE,
  type DeliveryContext,
} from './notification-policy.js';
import { ExpoPushSender, EXPO_PUSH_URL, MemoryPushSender, type PushMessage } from './push.js';

const at = (iso: string) => new Date(iso);
const base = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({
  category: 'friends',
  prefs: {},
  quietHours: { start: null, end: null },
  timezone: 'UTC',
  focusMode: false,
  pausedUntil: null,
  ageBand: 'adult',
  now: at('2026-03-10T12:00:00Z'),
  ...over,
});

describe('categoryFor', () => {
  it('uses exact mappings first, then prefixes, then system', () => {
    expect(categoryFor('follow')).toBe('friends');
    expect(categoryFor('message')).toBe('messages');
    expect(categoryFor('community_banned')).toBe('moderation'); // exact beats the community_ prefix
    expect(categoryFor('community_something_new')).toBe('communities');
    expect(categoryFor('event_brand_new')).toBe('events');
    expect(categoryFor('totally_unknown')).toBe('system');
    expect(categoryFor('guardian_invitation')).toBe('security');
  });
  it('every mapped kind points at a real category and every category has defaults and push copy', () => {
    for (const c of Object.values(KIND_CATEGORY)) expect(NOTIFICATION_CATEGORIES).toContain(c);
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(DEFAULT_CHANNELS[c].in_app).toBe(true);
      expect(PUSH_COPY[c].title.length).toBeGreaterThan(0);
    }
  });
  it('push copy is content-free (no placeholders for names or text)', () => {
    for (const c of NOTIFICATION_CATEGORIES)
      expect(`${PUSH_COPY[c].title} ${PUSH_COPY[c].body}`).not.toMatch(/[{}$<]/);
  });
});

describe('quiet windows', () => {
  it('handles same-day and midnight-wrapping windows', () => {
    expect(inQuietWindow(12 * 60, 9 * 60, 17 * 60)).toBe(true);
    expect(inQuietWindow(17 * 60, 9 * 60, 17 * 60)).toBe(false); // end is exclusive
    expect(inQuietWindow(8 * 60 + 59, 9 * 60, 17 * 60)).toBe(false);
    expect(inQuietWindow(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietWindow(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietWindow(7 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(inQuietWindow(12 * 60, 22 * 60, 7 * 60)).toBe(false);
  });
  it('start === end or missing means no quiet hours', () => {
    expect(inQuietWindow(600, 600, 600)).toBe(false);
    expect(inQuietWindow(600, null, 100)).toBe(false);
    expect(inQuietWindow(600, 100, null)).toBe(false);
  });
  it('computes local minutes for a timezone, falling back to UTC for nonsense', () => {
    expect(localMinutes(at('2026-03-10T12:30:00Z'), 'UTC')).toBe(12 * 60 + 30);
    expect(localMinutes(at('2026-03-10T12:30:00Z'), 'Asia/Tokyo')).toBe(21 * 60 + 30);
    expect(localMinutes(at('2026-03-10T00:15:00Z'), 'America/Los_Angeles')).toBe(17 * 60 + 15); // previous day, PDT
    expect(localMinutes(at('2026-03-10T12:30:00Z'), 'Not/AZone')).toBe(12 * 60 + 30);
    expect(localMinutes(at('2026-03-10T00:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('decideDelivery', () => {
  it('uses the category defaults when nothing is set', () => {
    expect(decideDelivery(base({ category: 'friends' }))).toMatchObject({
      inApp: true,
      push: true,
      email: false,
      suppressedBy: null,
    });
    expect(decideDelivery(base({ category: 'creators' }))).toMatchObject({
      inApp: true,
      push: false,
      email: false,
    });
    expect(decideDelivery(base({ category: 'security' }))).toMatchObject({
      inApp: true,
      push: true,
      email: true,
    });
  });

  it('honours explicit preferences per channel', () => {
    expect(decideDelivery(base({ prefs: { push: false } })).push).toBe(false);
    expect(decideDelivery(base({ prefs: { in_app: false } })).inApp).toBe(false);
    expect(decideDelivery(base({ category: 'creators', prefs: { push: true } })).push).toBe(true);
    expect(decideDelivery(base({ prefs: { email: true } })).email).toBe(true);
  });

  it('security and moderation can never be hidden in-app', () => {
    for (const category of UNDISABLEABLE) {
      expect(decideDelivery(base({ category, prefs: { in_app: false, push: false } })).inApp).toBe(
        true,
      );
    }
  });

  it('quiet hours suppress push and email but keep the in-app row', () => {
    const d = decideDelivery(
      base({
        quietHours: { start: 22 * 60, end: 7 * 60 },
        now: at('2026-03-10T23:30:00Z'),
        prefs: { email: true },
      }),
    );
    expect(d).toMatchObject({
      inApp: true,
      push: false,
      email: false,
      suppressedBy: 'quiet_hours',
    });
    const day = decideDelivery(
      base({ quietHours: { start: 22 * 60, end: 7 * 60 }, now: at('2026-03-10T12:00:00Z') }),
    );
    expect(day).toMatchObject({ push: true, suppressedBy: null });
  });

  it("quiet hours are evaluated in the user's timezone", () => {
    // 22:00-07:00 in Tokyo: 14:00Z is 23:00 in Tokyo (quiet), 02:00Z is 11:00 in Tokyo (not quiet)
    const q = { start: 22 * 60, end: 7 * 60 };
    expect(
      decideDelivery(
        base({ quietHours: q, timezone: 'Asia/Tokyo', now: at('2026-03-10T14:00:00Z') }),
      ).suppressedBy,
    ).toBe('quiet_hours');
    expect(
      decideDelivery(
        base({ quietHours: q, timezone: 'Asia/Tokyo', now: at('2026-03-10T02:00:00Z') }),
      ).suppressedBy,
    ).toBeNull();
  });

  it('pause and focus mode suppress push/email; pause wins the explanation', () => {
    const now = at('2026-03-10T12:00:00Z');
    expect(
      decideDelivery(base({ pausedUntil: at('2026-03-10T13:00:00Z'), now })).suppressedBy,
    ).toBe('paused');
    expect(
      decideDelivery(base({ pausedUntil: at('2026-03-10T11:59:00Z'), now })).suppressedBy,
    ).toBeNull(); // expired pause
    expect(decideDelivery(base({ focusMode: true, now })).suppressedBy).toBe('focus_mode');
    expect(
      decideDelivery(base({ focusMode: true, pausedUntil: at('2026-03-10T13:00:00Z'), now }))
        .suppressedBy,
    ).toBe('paused');
    const d = decideDelivery(base({ focusMode: true, now }));
    expect(d).toMatchObject({ inApp: true, push: false });
  });

  it('urgent categories bypass quiet hours, pause and focus', () => {
    const now = at('2026-03-10T23:30:00Z');
    for (const category of ['security', 'moderation'] as const) {
      const d = decideDelivery(
        base({
          category,
          quietHours: { start: 22 * 60, end: 7 * 60 },
          pausedUntil: at('2026-03-11T12:00:00Z'),
          focusMode: true,
          now,
        }),
      );
      expect(d).toMatchObject({ push: true, email: true, suppressedBy: null });
    }
  });

  it('teens get default quiet hours 22:00-07:00, which their own window replaces', () => {
    expect(TEEN_QUIET_HOURS).toEqual({ start: 22 * 60, end: 7 * 60 });
    const night = at('2026-03-10T23:00:00Z');
    expect(decideDelivery(base({ ageBand: 'teen', now: night })).suppressedBy).toBe('quiet_hours');
    expect(decideDelivery(base({ ageBand: 'adult', now: night })).suppressedBy).toBeNull();
    // A teen's own window applies instead of the default
    expect(
      decideDelivery(
        base({ ageBand: 'teen', now: night, quietHours: { start: 8 * 60, end: 9 * 60 } }),
      ).suppressedBy,
    ).toBeNull();
    expect(
      decideDelivery(
        base({
          ageBand: 'teen',
          now: at('2026-03-10T08:30:00Z'),
          quietHours: { start: 8 * 60, end: 9 * 60 },
        }),
      ).suppressedBy,
    ).toBe('quiet_hours');
    // ...but urgent notices still reach them
    expect(decideDelivery(base({ ageBand: 'teen', category: 'security', now: night })).push).toBe(
      true,
    );
  });

  it('nothing to suppress when push and email are both off', () => {
    const d = decideDelivery(base({ category: 'creators', focusMode: true }));
    expect(d.suppressedBy).toBeNull();
  });
});

describe('Expo push adapter', () => {
  const msg = (n: number): PushMessage => ({
    token: `ExponentPushToken[tok${n}]`,
    title: 'T',
    body: 'B',
    data: { notificationId: String(n) },
  });

  it('builds the documented request shape', () => {
    expect(ExpoPushSender.toRequest([msg(1)])).toEqual([
      {
        to: 'ExponentPushToken[tok1]',
        title: 'T',
        body: 'B',
        data: { notificationId: '1' },
        sound: 'default',
        priority: 'high',
      },
    ]);
  });

  it('posts to the Expo endpoint with an optional bearer token and maps per-message results', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: [
            { status: 'ok' },
            { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
            { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const res = await new ExpoPushSender('secret-token', fake).send([msg(1), msg(2), msg(3)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXPO_PUSH_URL);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-token',
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toHaveLength(3);
    expect(res).toEqual([
      { token: 'ExponentPushToken[tok1]', ok: true },
      {
        token: 'ExponentPushToken[tok2]',
        ok: false,
        invalidToken: true,
        error: 'DeviceNotRegistered',
      },
      {
        token: 'ExponentPushToken[tok3]',
        ok: false,
        invalidToken: false,
        error: 'MessageRateExceeded',
      },
    ]);
  });

  it('chunks at 100 messages, survives HTTP errors and network failures without throwing', async () => {
    let n = 0;
    const flaky = (async () => {
      n += 1;
      if (n === 1) return new Response('{}', { status: 500 });
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const res = await new ExpoPushSender(undefined, flaky).send(
      Array.from({ length: 150 }, (_, i) => msg(i)),
    );
    expect(n).toBe(2);
    expect(res).toHaveLength(150);
    expect(res.slice(0, 100).every((r) => !r.ok && r.error === 'http_500')).toBe(true);
    expect(res.slice(100).every((r) => !r.ok && r.error === 'TypeError')).toBe(true);
  });

  it('sends no authorization header without an access token', async () => {
    let headers: Record<string, string> = {};
    const fake = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ExpoPushSender(undefined, fake).send([msg(1)]);
    expect(headers.authorization).toBeUndefined();
  });

  it('MemoryPushSender records sends and can simulate dead tokens', async () => {
    const s = new MemoryPushSender();
    s.invalid.add('dead');
    const r = await s.send([{ ...msg(1), token: 'dead' }, msg(2)]);
    expect(r.map((x) => x.ok)).toEqual([false, true]);
    expect(s.sent).toHaveLength(1);
  });
});
