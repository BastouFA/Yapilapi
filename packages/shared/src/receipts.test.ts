import { describe, expect, it } from 'vitest';
import { messageReceipt } from './receipts.ts';

const at = '2026-11-01T10:00:00.000Z';
const later = '2026-11-01T10:00:05.000Z';
const earlier = '2026-11-01T09:00:00.000Z';

describe('messageReceipt', () => {
  it('goes from sent to delivered to read', () => {
    expect(messageReceipt(at, 1)).toBe('sent');
    expect(messageReceipt(at, 1, [{ userId: 'a', lastReadAt: earlier }], [{ userId: 'a', lastDeliveredAt: earlier }])).toBe('sent');
    expect(messageReceipt(at, 1, [{ userId: 'a', lastReadAt: earlier }], [{ userId: 'a', lastDeliveredAt: later }])).toBe('delivered');
    expect(messageReceipt(at, 1, [{ userId: 'a', lastReadAt: later }], [])).toBe('read');
  });

  it('in a group, counts once it has reached everyone', () => {
    expect(messageReceipt(at, 2, [{ userId: 'a', lastReadAt: later }], [])).toBe('sent');
    expect(messageReceipt(at, 2, [{ userId: 'a', lastReadAt: later }], [{ userId: 'b', lastDeliveredAt: later }])).toBe('delivered');
    expect(messageReceipt(at, 2, [{ userId: 'a', lastReadAt: later }], [{ userId: 'a', lastDeliveredAt: later }])).toBe('sent');
    expect(
      messageReceipt(at, 2, [
        { userId: 'a', lastReadAt: later },
        { userId: 'b', lastReadAt: later },
      ]),
    ).toBe('read');
  });

  it('a chat with only you stays sent', () => {
    expect(messageReceipt(at, 0)).toBe('sent');
  });
});
