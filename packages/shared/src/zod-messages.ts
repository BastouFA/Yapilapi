import { z } from 'zod';

/**
 * zod's own messages, for a check that gives none, in the words zod 3 used. The translation tables
 * (locales/errors, "zod's own messages") and the forms are written against these, so moving to zod 4
 * changes nothing anyone reads. A message a schema gives itself always wins over these.
 */
const typeName = (v: unknown) => (v === undefined ? 'undefined' : v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isNaN(v) ? 'nan' : typeof v);

const quote = (v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v));

const FORMATS: Record<string, string> = {
  email: 'Invalid email',
  url: 'Invalid url',
  uuid: 'Invalid uuid',
  guid: 'Invalid uuid',
  datetime: 'Invalid datetime',
  date: 'Invalid date',
  time: 'Invalid time',
  ipv4: 'Invalid ip',
  ipv6: 'Invalid ip',
  base64: 'Invalid base64',
  regex: 'Invalid',
};

function message(iss: z.core.$ZodRawIssue): string | undefined {
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? 'Required' : `Expected ${iss.expected}, received ${typeName(iss.input)}`;
    case 'too_small': {
      const n = String(iss.minimum);
      if (iss.origin === 'string') return `String must contain ${iss.exact ? 'exactly' : 'at least'} ${n} character(s)`;
      if (iss.origin === 'array' || iss.origin === 'set') return `Array must contain ${iss.exact ? 'exactly' : 'at least'} ${n} element(s)`;
      if (iss.origin === 'number' || iss.origin === 'bigint')
        return iss.inclusive ? `Number must be greater than or equal to ${n}` : `Number must be greater than ${n}`;
      return undefined;
    }
    case 'too_big': {
      const n = String(iss.maximum);
      if (iss.origin === 'string') return `String must contain ${iss.exact ? 'exactly' : 'at most'} ${n} character(s)`;
      if (iss.origin === 'array' || iss.origin === 'set') return `Array must contain ${iss.exact ? 'exactly' : 'at most'} ${n} element(s)`;
      if (iss.origin === 'number' || iss.origin === 'bigint')
        return iss.inclusive ? `Number must be less than or equal to ${n}` : `Number must be less than ${n}`;
      return undefined;
    }
    case 'invalid_format':
      if (iss.format === 'starts_with') return `Invalid input: must start with "${(iss as { prefix?: string }).prefix}"`;
      if (iss.format === 'ends_with') return `Invalid input: must end with "${(iss as { suffix?: string }).suffix}"`;
      if (iss.format === 'includes') return `Invalid input: must include "${(iss as { includes?: string }).includes}"`;
      return FORMATS[iss.format] ?? 'Invalid';
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(iss.divisor)}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${iss.keys.map((k) => `'${k}'`).join(', ')}`;
    case 'invalid_value':
      return iss.values.length === 1
        ? `Invalid literal value, expected ${JSON.stringify(iss.values[0])}`
        : `Invalid enum value. Expected ${iss.values.map(quote).join(' | ')}, received ${quote(iss.input)}`;
    case 'invalid_union':
      return 'Invalid input';
    default:
      return undefined;
  }
}

z.config({ customError: message });
