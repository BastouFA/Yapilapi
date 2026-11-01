import { describe, expect, it } from 'vitest';
import { RealtimeHub } from '../src/lib/realtime.ts';

const socket = (readyState = 1) => ({ readyState, send: () => {} });

describe('who has the app in front of them', () => {
  it('a connected app on screen counts; in the background it gets notifications instead', () => {
    const hub = new RealtimeHub();
    const s = socket();
    hub.add('u', s);
    expect(hub.isOnline('u')).toBe(true);
    hub.heard(s, false);
    expect(hub.isOnline('u')).toBe(false);
    hub.heard(s);
    expect(hub.isOnline('u')).toBe(false);
    hub.heard(s, true);
    expect(hub.isOnline('u')).toBe(true);
  });

  it('a socket not heard from for a minute is taken to be gone (a frozen phone)', () => {
    const hub = new RealtimeHub();
    const real = Date.now;
    const s = socket();
    hub.add('u', s);
    try {
      Date.now = () => real() + 61_000;
      expect(hub.isOnline('u')).toBe(false);
      hub.heard(s);
      expect(hub.isOnline('u')).toBe(true);
    } finally {
      Date.now = real;
    }
  });

  it('another device on screen is enough', () => {
    const hub = new RealtimeHub();
    const phone = socket();
    const laptop = socket();
    hub.add('u', phone);
    hub.add('u', laptop);
    hub.heard(phone, false);
    expect(hub.isOnline('u')).toBe(true);
    hub.heard(laptop, false);
    expect(hub.isOnline('u')).toBe(false);
  });
});
