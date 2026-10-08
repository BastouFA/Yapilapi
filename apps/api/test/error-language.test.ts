import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_MESSAGES } from '@yapilapi/shared/error-messages';
import type { BuiltApp } from '../src/app.ts';
import { translateMessage } from '../src/lib/error-language.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

// Errors come back in the reader's language: a signed-in person's language setting, or what the
// app (x-locale) or browser (Accept-Language) asks for before signing in. English stays as it was.
let t: BuiltApp;
let english: TestUser;
let french: TestUser;
let arabic: TestUser;

const setLocale = async (u: TestUser, locale: string) => expect((await as(t.app, u).patch('/v1/me/profile', { locale })).status).toBe(200);

beforeAll(async () => {
  t = await testApp();
  [english, french, arabic] = await Promise.all([signUp(t.app), signUp(t.app), signUp(t.app)]);
  await setLocale(french, 'fr');
  await setLocale(arabic, 'ar');
});
afterAll(async () => {
  await t.close();
});

describe('errors in the reader’s language', () => {
  it('a missing post: French and Arabic readers get their language, English stays English', async () => {
    const url = `/v1/posts/${randomUUID()}`;
    const en = await as(t.app, english).get(url);
    const fr = await as(t.app, french).get(url);
    const ar = await as(t.app, arabic).get(url);
    expect(en.status).toBe(404);
    expect(en.body.error.message).toMatch(/doesn't exist or isn't visible to you\.$/);
    for (const [res, lang] of [
      [fr, 'fr'],
      [ar, 'ar'],
    ] as const) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(en.body.error.code);
      expect(res.body.error.message).toBe(ERROR_MESSAGES[lang]![en.body.error.message]);
      expect(res.body.error.message).not.toBe(en.body.error.message);
    }
  });

  it('a validation error: the message and each field', async () => {
    const payload = { displayName: '', bio: 'x'.repeat(5000) };
    const en = await as(t.app, english).patch('/v1/me/profile', payload);
    const fr = await as(t.app, french).patch('/v1/me/profile', payload);
    const ar = await as(t.app, arabic).patch('/v1/me/profile', payload);
    expect(en.status).toBe(400);
    expect(en.body.error.message).toBe('Check the highlighted fields.');
    const fields = Object.keys(en.body.error.details.fields);
    expect(fields.length).toBeGreaterThan(0);
    for (const [res, lang] of [
      [fr, 'fr'],
      [ar, 'ar'],
    ] as const) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.message).toBe(ERROR_MESSAGES[lang]!['Check the highlighted fields.']);
      expect(Object.keys(res.body.error.details.fields)).toEqual(fields);
      for (const f of fields) {
        const englishField = en.body.error.details.fields[f];
        expect(res.body.error.details.fields[f]).toBe(translateMessage(englishField, lang));
        expect(res.body.error.details.fields[f]).not.toBe(englishField);
      }
    }
  });

  it('a rate limit keeps its number', async () => {
    const ask = async (u: TestUser) => {
      const api = as(t.app, u);
      const phone = `+4477008${String(Date.now() % 100000).padStart(5, '0')}${Math.floor(Math.random() * 10)}`.slice(0, 16);
      expect((await api.put('/v1/me/phone', { phone })).status).toBe(200);
      const send = () =>
        t.app.inject({
          method: 'POST',
          url: '/v1/me/phone/code',
          payload: {},
          headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
        });
      expect((await send()).statusCode).toBe(200);
      const again = await send();
      expect(again.statusCode).toBe(429);
      return again.json().error as { code: string; message: string; details: { retryAfterSeconds: number } };
    };
    const en = await ask(english);
    const fr = await ask(french);
    expect(en.message).toMatch(/^We just sent a code\. You can ask for another in \d+ seconds\.$/);
    const wait = fr.details.retryAfterSeconds;
    expect(fr.code).toBe('rate_limited');
    expect(fr.message).toBe(ERROR_MESSAGES.fr!['We just sent a code. You can ask for another in {wait} seconds.']!.replace('{wait}', String(wait)));
  });

  it('signing in: the language comes from the request before anyone is signed in', async () => {
    const login = (headers: Record<string, string>) =>
      t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: english.email, password: 'not-the-password' }, headers });
    const wrong = 'That email and password don’t match. Try again or reset your password.';

    const plain = await login({});
    expect(plain.statusCode).toBe(401);
    expect(plain.json().error.message).toBe(wrong);

    const browser = await login({ 'accept-language': 'ar-EG,ar;q=0.9,en;q=0.5' });
    expect(browser.statusCode).toBe(401);
    expect(browser.json().error).toMatchObject({ code: 'unauthorized', message: ERROR_MESSAGES.ar![wrong] });

    // The app's own language wins over the browser's.
    const app = await login({ 'x-locale': 'fr', 'accept-language': 'ar' });
    expect(app.json().error.message).toBe(ERROR_MESSAGES.fr![wrong]);

    // A language without a table reads English.
    expect((await login({ 'accept-language': 'nl-NL,nl;q=0.9' })).json().error.message).toBe(wrong);
    expect((await login({ 'accept-language': 'hi-IN,hi;q=0.9' })).json().error.message).toBe(ERROR_MESSAGES.hi![wrong]);
  });

  it('a signed-in person’s setting wins over the headers', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/posts/${randomUUID()}`,
      headers: { authorization: `Bearer ${english.token}`, 'x-locale': 'fr', 'accept-language': 'fr' },
    });
    expect(res.json().error.message).toMatch(/^[\w ]+ doesn't exist or isn't visible to you\.$/);
  });

  it('an unknown route', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/nothing-here', headers: { 'x-locale': 'fr' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(ERROR_MESSAGES.fr!['No route for {method} {url}.']!.replace('{method}', 'GET').replace('{url}', '/v1/nothing-here'));
  });
});
