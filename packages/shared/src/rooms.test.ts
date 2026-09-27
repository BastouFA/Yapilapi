import { describe, expect, it } from 'vitest';
import { roomMeshLinks } from './rooms.ts';

const person = (id: string, role: 'speaker' | 'listener') => ({ user: { id }, role });

describe('room mesh links', () => {
  const people = [person('a', 'speaker'), person('b', 'speaker'), person('c', 'listener'), person('d', 'listener')];

  it('connects speakers to everyone and never two listeners', () => {
    expect(roomMeshLinks('a', people).map((l) => l.userId)).toEqual(['b', 'c', 'd']);
    expect(roomMeshLinks('c', people).map((l) => l.userId)).toEqual(['a', 'b']);
  });

  it('has exactly one side offer for every pair', () => {
    for (const x of people)
      for (const y of people) {
        if (x === y) continue;
        const xy = roomMeshLinks(x.user.id, people).find((l) => l.userId === y.user.id);
        const yx = roomMeshLinks(y.user.id, people).find((l) => l.userId === x.user.id);
        expect(!!xy).toBe(!!yx);
        if (xy && yx) expect(xy.offer).not.toBe(yx.offer);
      }
  });

  it('changes the key when a role changes, and is empty for someone not in the room', () => {
    const before = roomMeshLinks('a', people).find((l) => l.userId === 'c')!.key;
    const after = roomMeshLinks('a', [person('a', 'speaker'), person('c', 'speaker')]).find((l) => l.userId === 'c')!.key;
    expect(before).not.toBe(after);
    expect(roomMeshLinks('z', people)).toEqual([]);
  });
});
