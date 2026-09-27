import { describe, expect, it } from 'vitest';
import {
  MAX_DEVICE_ACCOUNTS,
  parseDeviceAccounts,
  sessionCheckFailure,
  takeOver,
  takeOverCandidates,
  upsertDeviceAccount,
  withoutDeviceAccount,
  type DeviceAccount,
} from './accounts.ts';

const acct = (id: string, name = id): DeviceAccount => ({ id, username: name, displayName: name.toUpperCase(), avatarUrl: null });
const ids = (list: DeviceAccount[]) => list.map((a) => a.id);

describe('accounts on this phone', () => {
  it('reads the saved list, dropping broken entries and repeats', () => {
    expect(parseDeviceAccounts(null)).toEqual([]);
    expect(parseDeviceAccounts('not json')).toEqual([]);
    expect(parseDeviceAccounts('{"id":"a"}')).toEqual([]);
    const raw = JSON.stringify([acct('a'), { id: 'b' }, null, acct('c'), { ...acct('a'), username: 'again' }, { ...acct('d'), avatarUrl: 42 }]);
    const list = parseDeviceAccounts(raw);
    expect(ids(list)).toEqual(['a', 'c', 'd']);
    expect(list[0]!.username).toBe('a');
    expect(list[2]!.avatarUrl).toBeNull();
  });

  it('keeps at most five when reading', () => {
    const raw = JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => acct(x)));
    expect(parseDeviceAccounts(raw)).toHaveLength(MAX_DEVICE_ACCOUNTS);
  });

  it('adds a new account at the end and updates a known one in place', () => {
    const start = [acct('a'), acct('b')];
    const added = upsertDeviceAccount(start, acct('c'));
    expect(ids(added.list)).toEqual(['a', 'b', 'c']);
    expect(added.evicted).toEqual([]);
    const renamed = upsertDeviceAccount(added.list, { ...acct('a'), displayName: 'Ada' });
    expect(ids(renamed.list)).toEqual(['a', 'b', 'c']);
    expect(renamed.list[0]!.displayName).toBe('Ada');
  });

  it('makes the oldest other account leave past the limit, never the one in use', () => {
    const full = ['a', 'b', 'c', 'd', 'e'].map((x) => acct(x));
    const r = upsertDeviceAccount(full, acct('f'));
    expect(ids(r.list)).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(r.evicted).toEqual(['a']);
    // Even with a limit of one, the account in use stays.
    const one = upsertDeviceAccount([acct('a'), acct('b')], acct('b'), 1);
    expect(ids(one.list)).toEqual(['b']);
    expect(one.evicted).toEqual(['a']);
  });

  it('removes an account and lists who can take over', () => {
    const list = [acct('a'), acct('b'), acct('c')];
    expect(ids(withoutDeviceAccount(list, 'b'))).toEqual(['a', 'c']);
    expect(ids(takeOverCandidates(list, 'a'))).toEqual(['b', 'c']);
    expect(ids(takeOverCandidates(list, null))).toEqual(['a', 'b', 'c']);
  });

  it('only treats a 401 as an ended session', () => {
    expect(sessionCheckFailure({ status: 401, code: 'unauthorized' })).toBe('ended');
    expect(sessionCheckFailure({ status: 0, code: 'network' })).toBe('offline');
    // A server problem or a rate limit must not sign anyone out.
    expect(sessionCheckFailure({ status: 500, code: 'internal' })).toBe('unavailable');
    expect(sessionCheckFailure({ status: 429, code: 'rate_limited' })).toBe('unavailable');
    expect(sessionCheckFailure(new Error('boom'))).toBe('unavailable');
    expect(sessionCheckFailure(null)).toBe('unavailable');
  });
});

describe('taking over when the account in use leaves', () => {
  function phone(tokens: Record<string, string | null>, sessions: Record<string, 'ok' | 'ended' | 'offline' | 'down'>) {
    let active: string | null = null;
    const forgotten: string[] = [];
    return {
      forgotten,
      active: () => active,
      deps: {
        activate: async (id: string) => {
          if (!tokens[id]) return false;
          active = id;
          return true;
        },
        whoAmI: async () => {
          const s = active ? sessions[active] : 'ended';
          if (s === 'ok') return { id: active! };
          if (s === 'offline') throw { status: 0, code: 'network' };
          if (s === 'down') throw { status: 503, code: 'unavailable' };
          throw { status: 401, code: 'unauthorized' };
        },
        forget: async (id: string) => void forgotten.push(id),
      },
    };
  }

  it('switches to the first account whose session still works, forgetting ended ones', async () => {
    const p = phone({ b: 't-b', c: 't-c', d: 't-d' }, { b: 'ended', c: 'ok', d: 'ok' });
    const r = await takeOver([acct('a'), acct('b'), acct('c'), acct('d')], p.deps);
    expect(r).toMatchObject({ kind: 'switched', account: { id: 'c' }, user: { id: 'c' } });
    // 'a' had no token left, 'b' had ended; 'd' was never needed.
    expect(p.forgotten).toEqual(['a', 'b']);
    expect(p.active()).toBe('c');
  });

  it('keeps the next account in use while offline instead of signing out', async () => {
    const p = phone({ b: 't-b', c: 't-c' }, { b: 'offline', c: 'ok' });
    const r = await takeOver([acct('b'), acct('c')], p.deps);
    expect(r).toMatchObject({ kind: 'pending', account: { id: 'b' }, reason: 'offline' });
    expect(p.forgotten).toEqual([]);
    expect(p.active()).toBe('b');
  });

  it('keeps an account when the API has a problem', async () => {
    const p = phone({ b: 't-b' }, { b: 'down' });
    const r = await takeOver([acct('b')], p.deps);
    expect(r).toMatchObject({ kind: 'pending', reason: 'unavailable' });
    expect(p.forgotten).toEqual([]);
  });

  it('ends on the welcome screen when nobody is left', async () => {
    const p = phone({ b: 't-b' }, { b: 'ended' });
    expect(await takeOver([acct('b')], p.deps)).toEqual({ kind: 'none' });
    expect(await takeOver([], p.deps)).toEqual({ kind: 'none' });
    expect(p.forgotten).toEqual(['b']);
  });
});
