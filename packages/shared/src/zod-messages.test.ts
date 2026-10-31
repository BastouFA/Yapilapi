import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import './zod-messages.ts';

const first = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  return r.success ? null : r.error.issues[0]!.message;
};

describe("zod's own messages", () => {
  it('keep the words the translation tables were written for', () => {
    expect(first(z.object({ a: z.string() }), {})).toBe('Required');
    expect(first(z.string(), 5)).toBe('Expected string, received number');
    expect(first(z.string().min(3), 'ab')).toBe('String must contain at least 3 character(s)');
    expect(first(z.string().max(2), 'abc')).toBe('String must contain at most 2 character(s)');
    expect(first(z.array(z.string()).min(1), [])).toBe('Array must contain at least 1 element(s)');
    expect(first(z.number().min(1), 0)).toBe('Number must be greater than or equal to 1');
    expect(first(z.number().lt(1), 1)).toBe('Number must be less than 1');
    expect(first(z.string().email(), 'nope')).toBe('Invalid email');
    expect(first(z.string().uuid(), 'nope')).toBe('Invalid uuid');
    expect(first(z.enum(['a', 'b']), 'c')).toBe("Invalid enum value. Expected 'a' | 'b', received 'c'");
    expect(first(z.number().multipleOf(5), 3)).toBe('Number must be a multiple of 5');
  });

  it('never replace a message a schema gives itself', () => {
    expect(first(z.string().min(3, 'Too short.'), 'ab')).toBe('Too short.');
  });
});
