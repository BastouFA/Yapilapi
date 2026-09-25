import { describe, expect, it } from 'vitest';
import { isUuid } from './ids';

describe('isUuid', () => {
  it('accepts canonical UUIDs and rejects everything else', () => {
    expect(isUuid('0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d')).toBe(true);
    expect(isUuid('0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D')).toBe(true);
    for (const v of [
      '',
      'abc',
      '../etc/passwd',
      '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4',
      "1' OR 1=1",
      null,
      undefined,
    ])
      expect(isUuid(v as string)).toBe(false);
  });
});
