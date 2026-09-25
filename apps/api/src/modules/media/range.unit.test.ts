import { describe, expect, it } from 'vitest';
import { parseRange } from './serve.js';

describe('parseRange', () => {
  it('parses single ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });
  it('flags unsatisfiable ranges and ignores unsupported ones', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
    expect(parseRange('bytes=50-10', 1000)).toBe('invalid');
    expect(parseRange('bytes=-0', 1000)).toBe('invalid');
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull(); // multi-range: serve the whole object
    expect(parseRange('items=0-1', 1000)).toBeNull();
  });
});
