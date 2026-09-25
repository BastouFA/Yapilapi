import { describe, expect, it } from 'vitest';
import { CUSTOM_EXPIRY_MAX_MS, CUSTOM_EXPIRY_MIN_MS, resolveExpiry } from './service.js';

const now = new Date('2026-01-01T12:00:00Z');
describe('resolveExpiry', () => {
  it('maps presets and permanent', () => {
    expect(resolveExpiry('1h', undefined, now)!.toISOString()).toBe('2026-01-01T13:00:00.000Z');
    expect(resolveExpiry('24h', undefined, now)!.toISOString()).toBe('2026-01-02T12:00:00.000Z');
    expect(resolveExpiry('permanent', undefined, now)).toBeNull();
  });
  it('validates custom bounds', () => {
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(resolveExpiry('custom', at(CUSTOM_EXPIRY_MIN_MS), now)).toEqual(
      at(CUSTOM_EXPIRY_MIN_MS),
    );
    expect(resolveExpiry('custom', at(CUSTOM_EXPIRY_MAX_MS), now)).toEqual(
      at(CUSTOM_EXPIRY_MAX_MS),
    );
    expect(() => resolveExpiry('custom', at(CUSTOM_EXPIRY_MIN_MS - 1), now)).toThrow();
    expect(() => resolveExpiry('custom', at(CUSTOM_EXPIRY_MAX_MS + 1), now)).toThrow();
    expect(() => resolveExpiry('custom', undefined, now)).toThrow();
    expect(() => resolveExpiry('24h', at(3600_000), now)).toThrow();
    expect(() => resolveExpiry('permanent', at(3600_000), now)).toThrow();
  });
});
