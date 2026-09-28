import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOGS, SUPPORTED_LOCALES, t } from '@yapilapi/shared/i18n';
import type { BuiltApp } from '../src/app.ts';
import { recipientLocale, securityEmail, SECURITY_EMAILS } from '../src/lib/email.ts';
import { PUSH_TYPES, pushTextFor, type PushMessage } from '../src/lib/push.ts';
import { notify, securityEvent, setPushSender } from '../src/lib/services.ts';
import { deviceLabel, deviceName, placeName, recordSignIn } from '../src/lib/sign-in-alerts.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t0: BuiltApp;
const pushes: { userId: string; msg: PushMessage }[] = [];
beforeAll(async () => {
  t0 = await testApp();
  // Tests run without a push service; this one records what would go out.
  setPushSender(async (userId, msg) => {
    pushes.push({ userId, msg });
  });
});
afterAll(async () => {
  setPushSender(null);
  await t0.close();
});

const db = () => t0.ctx.db;
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

type Mail = { to: string; subject: string; text: string };
const outbox = async () => (await t0.app.inject({ url: '/dev/outbox' })).json().items as Mail[];

/** Emails and pushes go out in the background: wait a moment for them. */
async function waitFor<T>(find: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const found = await find();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nothing arrived');
}
const mailTo = (to: string, subject: string) => waitFor(async () => (await outbox()).findLast((m) => m.to === to && m.subject === subject));
const pushTo = (userId: string, type: string) => waitFor(() => pushes.findLast((p) => p.userId === userId && p.msg.tag === type));

/** Sample notification data, so every sentence has something in each slot. */
const SAMPLE: Record<string, object> = {
  together_invite: { title: 'Lagos weekend' },
  together_added: { title: 'Lagos weekend', count: 5, videos: 2 },
  together_starred: { title: 'Lagos weekend' },
  together_closing: { title: 'Lagos weekend' },
  together_closed: { title: 'Lagos weekend' },
  together_request: { title: 'Lagos weekend' },
  together_approved: { title: 'Lagos weekend' },
  plus_referral_reward: { days: 30 },
  market_expiring: { title: 'Bike', days: 3 },
};

describe('push and email text in every language', () => {
  it('has a push sentence for every push type in every catalog', () => {
    expect(PUSH_TYPES.length).toBeGreaterThan(70);
    for (const type of PUSH_TYPES) {
      for (const locale of SUPPORTED_LOCALES) {
        const catalog = CATALOGS[locale]!;
        const key = `push.${type}`;
        expect(key in catalog || `${key}.other` in catalog, `${locale} ${key}`).toBe(true);
        const text = pushTextFor(type, 'Ada', SAMPLE[type] ?? { title: 'Bike' }, locale);
        expect(text, `${locale} ${type}`).toBeTruthy();
        // Every slot filled, no key shown instead of words.
        expect(text, `${locale} ${type}`).not.toMatch(/\{\w+\}|push\./);
        if (locale !== 'en') expect(text, `${locale} ${type}`).not.toBe(pushTextFor(type, 'Ada', SAMPLE[type] ?? { title: 'Bike' }, 'en'));
      }
    }
    expect(pushTextFor('not_a_push_type', 'Ada', {}, 'fr')).toBeNull();
  });

  it('has every security email in every catalog', () => {
    for (const type of Object.keys(SECURITY_EMAILS))
      for (const locale of SUPPORTED_LOCALES) {
        // The keys are built from the event type, so check they exist.
        expect(SECURITY_EMAILS[type]!.subject in CATALOGS[locale]!, `${locale} ${type}`).toBe(true);
        expect(SECURITY_EMAILS[type]!.body in CATALOGS[locale]!, `${locale} ${type}`).toBe(true);
        const mail = securityEmail(type, 'a@example.test', 'https://y.test', new Date('2026-09-27T20:00:00Z'), locale)!;
        expect(mail.subject, `${locale} ${type}`).not.toMatch(/email\./);
        expect(mail.text, `${locale} ${type}`).not.toMatch(/email\.|\{\w+\}/);
        expect(mail.text).toContain('https://y.test/forgot-password');
        expect(mail.text).toContain('UTC');
      }
  });

  it('keeps English as it was, and falls back to it for a language without a catalog', () => {
    expect(pushTextFor('post_reaction', 'Ada', {})).toBe('Ada liked your post');
    expect(pushTextFor('together_added', 'Ada', { title: 'Lagos', count: 12 })).toBe('Ada added 12 photos to “Lagos”');
    expect(pushTextFor('together_added', 'Ada', { title: 'Lagos', count: 1, videos: 1 })).toBe('Ada added a video to “Lagos”');
    expect(pushTextFor('question_received', null, {})).toBe('Someone asked you a question');
    expect(pushTextFor('post_reaction', 'Ada', {}, 'xx')).toBe('Ada liked your post');
    expect(pushTextFor('question_received', null, {}, 'xx')).toBe('Someone asked you a question');
    // A regional tag uses its language's catalog.
    expect(pushTextFor('post_reaction', 'Ada', {}, 'fr-CA')).toBe(t('push.post_reaction', 'fr', { name: 'Ada' }));
    expect(recipientLocale('xx')).toBe('en');
    expect(recipientLocale('pt-BR')).toBe('pt');
    expect(recipientLocale(null)).toBe('en');
    // The stored device name never changes with a language; the email's does.
    expect(deviceName(CHROME_MAC)).toBe('Chrome on macOS');
    expect(deviceLabel(CHROME_MAC, 'fr')).toBe('Chrome sur macOS');
    expect(deviceLabel(null, 'fr')).toBe(t('email.device.unknown', 'fr'));
    expect(placeName('DE', 'fr')).toBe('Allemagne');
    expect(placeName('DE', 'xx')).toBe('Germany');
  });
});

describe('what a French or Arabic reader receives', () => {
  let fr: TestUser;
  let ar: TestUser;
  let ada: TestUser;
  beforeAll(async () => {
    fr = await signUp(t0.app, { locale: 'fr-FR' });
    ar = await signUp(t0.app, { locale: 'ar' });
    ada = await signUp(t0.app, { displayName: 'Ada' });
  });

  it('confirms the email address in the language the sign-up asked for', async () => {
    const frMail = await mailTo(fr.email, t('email.verify.subject', 'fr'));
    expect(frMail.subject).toBe('Confirme ton e-mail pour YAPILAPI');
    expect(frMail.text).toMatch(/^Confirme ton e-mail : .*\/verify-email\?token=/);
    const arMail = await mailTo(ar.email, t('email.verify.subject', 'ar'));
    expect(arMail.text).toContain('/verify-email?token=');
  });

  it('pushes likes, comments and messages in the recipient’s language', async () => {
    for (const [u, locale] of [
      [fr, 'fr'],
      [ar, 'ar'],
    ] as const) {
      const post = (await as(t0.app, u).post('/v1/posts', { body: `Hello from ${locale}` })).body.post;
      expect((await as(t0.app, ada).put(`/v1/posts/${post.id}/reaction`, { kind: 'like' })).status).toBe(200);
      expect((await pushTo(u.id, 'post_reaction')).msg).toMatchObject({
        title: 'YAPILAPI',
        body: t('push.post_reaction', locale, { name: 'Ada' }),
        url: '/notifications',
        data: { type: 'post_reaction', entityType: 'post', entityId: post.id },
      });
      expect((await as(t0.app, ada).post(`/v1/posts/${post.id}/comments`, { body: 'Nice' })).status).toBe(201);
      expect((await pushTo(u.id, 'post_comment')).msg.body).toBe(t('push.post_comment', locale, { name: 'Ada' }));
      // A Yap in a chat (the messages category), through the same path the chat uses.
      await notify(db(), t0.ctx.realtime, { userId: u.id, category: 'messages', type: 'yap_received', actorId: ada.id });
      expect((await pushTo(u.id, 'yap_received')).msg.body).toBe(t('push.yap_received', locale, { name: 'Ada' }));
    }
    expect(pushes.find((p) => p.userId === fr.id && p.msg.tag === 'post_reaction')!.msg.body).toBe('Ada a aimé ta publication');
    expect(pushes.find((p) => p.userId === ar.id && p.msg.tag === 'post_reaction')!.msg.body).toBe('أعجب Ada بمنشورك');
  });

  it('sends security emails in the account’s language, with the date in it and in UTC', async () => {
    await securityEvent(db(), fr.id, 'passkey_added');
    const frMail = await mailTo(fr.email, 'Une clé d’accès a été ajoutée à ton compte YAPILAPI');
    expect(frMail.text).toContain(t('email.security.passkey_added.body', 'fr'));
    const today = new Intl.DateTimeFormat('fr', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date());
    expect(frMail.text).toContain(`Quand : ${today}`);
    expect(frMail.text).toMatch(/UTC$/m);
    expect(frMail.text).toContain('Si c’était toi, il n’y a rien à faire.');

    await securityEvent(db(), ar.id, 'mfa_enabled');
    const arMail = await mailTo(ar.email, t('email.security.mfa_enabled.subject', 'ar'));
    expect(arMail.subject).toBe('التحقق بخطوتين مفعّل');
    expect(arMail.text).toContain(new Intl.DateTimeFormat('ar', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date()));
  });

  it('sends the password reset link in the account’s language', async () => {
    for (const [u, locale] of [
      [fr, 'fr'],
      [ar, 'ar'],
    ] as const) {
      expect((await t0.app.inject({ method: 'POST', url: '/v1/auth/password/forgot', payload: { email: u.email } })).statusCode).toBe(200);
      const mail = await mailTo(u.email, t('email.reset.subject', locale));
      expect(mail.text).toContain('/reset-password?token=');
      expect(mail.text.startsWith(CATALOGS[locale]!['email.reset.body'].split('{url}')[0]!)).toBe(true);
    }
    expect((await mailTo(fr.email, 'Réinitialise ton mot de passe YAPILAPI')).text).toContain('valable 1 heure');
  });

  it('writes the sign-in alert in the account’s language, the country’s name too', async () => {
    const alert = (u: TestUser) =>
      recordSignIn(
        { db: db(), realtime: t0.ctx.realtime, email: t0.ctx.email, webOrigin: 'https://y.test' },
        {
          userId: u.id,
          sessionId: randomUUID(),
          userAgent: CHROME_MAC,
          country: 'DE',
        },
      );
    expect(await alert(fr)).toBe(true);
    const frMail = await mailTo(fr.email, 'Nouvelle connexion à ton compte');
    expect(frMail.text).toContain(`@${fr.username}`);
    expect(frMail.text).toContain('Appareil : Chrome sur macOS');
    expect(frMail.text).toContain('Lieu approximatif : Allemagne');
    expect(frMail.text).toContain('Ce n’était pas moi : https://y.test/settings/security?review=sign-in');
    // The push for the same alert, too; the stored notification keeps the English device name.
    expect((await pushTo(fr.id, 'new_sign_in')).msg.body).toBe(t('push.new_sign_in', 'fr'));
    const note = (await db().query(`SELECT data FROM notifications WHERE user_id = $1 AND type = 'new_sign_in'`, [fr.id])).rows[0];
    expect(note.data).toMatchObject({ device: 'Chrome on macOS', country: 'DE' });

    expect(await alert(ar)).toBe(true);
    const arMail = await mailTo(ar.email, t('email.signIn.subject', 'ar'));
    expect(arMail.text).toContain('الجهاز: Chrome على macOS');
    expect(arMail.text).toContain(`المكان التقريبي: ${new Intl.DisplayNames(['ar'], { type: 'region' }).of('DE')}`);
    expect(arMail.text).not.toContain('Germany');
  });

  it('writes in English when the account’s language has no catalog', async () => {
    const other = await signUp(t0.app);
    await db().query(`UPDATE profiles SET locale = 'xx' WHERE user_id = $1`, [other.id]);
    expect((await t0.app.inject({ method: 'POST', url: '/v1/auth/password/forgot', payload: { email: other.email } })).statusCode).toBe(200);
    expect((await mailTo(other.email, 'Reset your YAPILAPI password')).text).toMatch(/^Reset your password: .*\(valid for 1 hour\)/);
    await securityEvent(db(), other.id, 'passkey_removed');
    const mail = await mailTo(other.email, 'A passkey was removed from your YAPILAPI account');
    expect(mail.text).toMatch(/^When: .* UTC$/m);
    const post = (await as(t0.app, other).post('/v1/posts', { body: 'Hello' })).body.post;
    await as(t0.app, ada).put(`/v1/posts/${post.id}/reaction`, { kind: 'like' });
    expect((await pushTo(other.id, 'post_reaction')).msg.body).toBe('Ada liked your post');
  });

  it('says goodbye in the account’s language when it is deleted', async () => {
    const gone = await signUp(t0.app, { locale: 'ar' });
    const res = await t0.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: { authorization: `Bearer ${gone.token}` },
      payload: { password: gone.password },
    });
    expect(res.statusCode).toBe(200);
    const mail = await mailTo(gone.email, t('email.deleted.subject', 'ar'));
    expect(mail.text).toBe(`${t('email.deleted.body', 'ar')}\n\n${t('email.deleted.notYou', 'ar')}`);
  });
});
