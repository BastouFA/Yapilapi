import * as Crypto from 'expo-crypto';

/** RFC 4122 v4 id used for idempotency keys and `clientMessageId`s. */
export function uuid(): string {
  try {
    const id = Crypto.randomUUID();
    if (typeof id === 'string' && id) return id;
  } catch {
    // fall through to the JS generator
  }
  // Only reachable where the native module is missing.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
