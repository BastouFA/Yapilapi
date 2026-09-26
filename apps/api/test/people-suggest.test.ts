import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

describe('people suggestions for new conversations', () => {
  it('suggests connections first, matches as you type, hides blocked people and flags minors', async () => {
    const tag = Math.random().toString(36).slice(2, 6);
    const me = await signUp(t.app, { birthDate: '1990-01-01', displayName: `Me ${tag}` });
    const friend = await signUp(t.app, { birthDate: '1991-01-01', displayName: `Zora ${tag}` });
    const followed = await signUp(t.app, { birthDate: '1992-01-01', displayName: `Zeke ${tag}` });
    const stranger = await signUp(t.app, { birthDate: '1993-01-01', displayName: `Zola ${tag}` });
    const blocked = await signUp(t.app, { birthDate: '1994-01-01', displayName: `Zane ${tag}` });
    const teen = await signUp(t.app, { birthDate: '2011-03-01', displayName: `Zuri ${tag}` });

    await as(t.app, me).post(`/v1/users/${friend.id}/friend-request`);
    const reqs = (await as(t.app, friend).get('/v1/me/friend-requests')).body.items;
    await as(t.app, friend).post(`/v1/friend-requests/${reqs[0].id}/accept`);
    await as(t.app, me).post(`/v1/users/${followed.id}/follow`);
    await as(t.app, blocked).post(`/v1/users/${me.id}/block`);

    // Before typing: only connections, friends first.
    const empty = (await as(t.app, me).get('/v1/people/suggest')).body.items.map((x: any) => x.user.id);
    expect(empty.slice(0, 2)).toEqual([friend.id, followed.id]);
    expect(empty).not.toContain(stranger.id);

    // Typing the first letters of a name.
    const typed = (await as(t.app, me).get(`/v1/people/suggest?q=z`)).body.items;
    const ids = typed.map((x: any) => x.user.id);
    expect(ids.indexOf(friend.id)).toBeLessThan(ids.indexOf(stranger.id));
    expect(ids).not.toContain(blocked.id);
    const byTag = (await as(t.app, me).get(`/v1/people/suggest?q=${encodeURIComponent(`zuri ${tag}`)}`)).body.items;
    expect(byTag[0]).toMatchObject({ user: { id: teen.id }, canMessage: false });
    expect(typed.find((x: any) => x.user.id === friend.id)).toMatchObject({ relation: 'friend', canMessage: true });
    // By username, with or without @.
    expect((await as(t.app, me).get(`/v1/people/suggest?q=@${stranger.username.slice(0, 8)}`)).body.items.map((x: any) => x.user.id)).toContain(stranger.id);
  });
});

describe('new accounts start in their own language', () => {
  it('stores a supported browser language and falls back to English', async () => {
    const fr = await signUp(t.app, { locale: 'fr-CA' });
    const xx = await signUp(t.app, { locale: 'tlh' });
    expect((await as(t.app, fr).get('/v1/auth/me')).body.user.locale).toBe('fr');
    expect((await as(t.app, xx).get('/v1/auth/me')).body.user.locale).toBe('en');
  });
});
