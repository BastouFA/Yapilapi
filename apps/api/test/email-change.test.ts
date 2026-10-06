import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let failing = false;
const mails: { to: string; subject: string; text: string }[] = [];
beforeAll(async () => {
  t = await testApp(
    { EMAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://localhost:2525', EMAIL_FROM: 'YAPILAPI <no-reply@yapilapi.test>', ADMIN_EMAILS: 'boss-change@yapilapi.test' },
    {
      mailTransport: {
        async sendMail(m) {
          if (failing) throw new Error('550 You can only send testing emails to your own email address');
          mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text) });
          return {};
        },
      },
    },
  );
});
afterAll(async () => {
  await t.ctx.db.query(`UPDATE users SET email = 'changed-' || id || '@deleted.invalid' WHERE lower(email) = 'boss-change@yapilapi.test'`);
  await t.close();
});

const linkTo = (to: string) => /token=([\w-]+)/.exec(mails.filter((m) => m.to === to).at(-1)!.text)![1]!;
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  return ok();
};

describe('changing your email', () => {
  it('needs your password, then switches only when the link sent to the new address is opened', async () => {
    const u = await signUp(t.app);
    const api = as(t.app, u);
    const fresh = `new-${u.id.slice(0, 8)}@yapilapi.test`;

    const wrong = await api.post('/v1/auth/email/change', { email: fresh, password: 'not-my-password' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.fields.password).toBeTruthy();
    expect((await api.post('/v1/auth/email/change', { email: u.email.toUpperCase(), password: u.password })).body.error.details.fields.email).toBe(
      'That’s already your email.',
    );

    const sent = await api.post('/v1/auth/email/change', { email: fresh, password: u.password });
    expect(sent.status).toBe(200);
    expect(sent.body.sentTo).toBe(fresh);
    const mail = mails.filter((m) => m.to === fresh).at(-1)!;
    expect(mail.subject).toBe('Confirm your new email for YAPILAPI');
    // Nothing changes yet.
    expect((await api.get('/v1/auth/me')).body.user.email).toBe(u.email);

    const done = await as(t.app, null).post('/v1/auth/verify-email', { token: linkTo(fresh) });
    expect(done.status).toBe(200);
    expect(done.body.changed).toBe(true);
    const meNow = (await api.get('/v1/auth/me')).body.user;
    expect(meNow.email).toBe(fresh);
    expect(meNow.emailVerified).toBe(true);
    // The old address is told, and the link works once.
    expect(await until(() => mails.some((m) => m.to === u.email && m.subject === 'Your YAPILAPI email was changed'))).toBe(true);
    expect(mails.find((m) => m.to === u.email && m.subject === 'Your YAPILAPI email was changed')!.text).toContain(fresh);
    expect((await as(t.app, null).post('/v1/auth/verify-email', { token: linkTo(fresh) })).status).toBe(400);
    // Signing in uses the new address.
    expect((await as(t.app, null).post('/v1/auth/login', { email: fresh, password: u.password })).status).toBe(200);
  });

  it('refuses an address another account has, only honours the latest request, and says when the link could not be sent', async () => {
    const u = await signUp(t.app);
    const other = await signUp(t.app);
    const api = as(t.app, u);
    const taken = await api.post('/v1/auth/email/change', { email: other.email, password: u.password });
    expect(taken.status).toBe(409);

    const first = `first-${u.id.slice(0, 8)}@yapilapi.test`;
    const second = `second-${u.id.slice(0, 8)}@yapilapi.test`;
    await api.post('/v1/auth/email/change', { email: first, password: u.password });
    const firstToken = linkTo(first);
    await api.post('/v1/auth/email/change', { email: second, password: u.password });
    expect((await as(t.app, null).post('/v1/auth/verify-email', { token: firstToken })).status).toBe(400);

    failing = true;
    try {
      const down = await api.post('/v1/auth/email/change', { email: `third-${u.id.slice(0, 8)}@yapilapi.test`, password: u.password });
      expect(down.status).toBe(503);
      expect(down.body.error.code).toBe('email_not_sent');
    } finally {
      failing = false;
    }
  });

  it('makes a listed admin address admin once the change is confirmed', async () => {
    const u = await signUp(t.app);
    await as(t.app, u).post('/v1/auth/email/change', { email: 'boss-change@yapilapi.test', password: u.password });
    await as(t.app, null).post('/v1/auth/verify-email', { token: linkTo('boss-change@yapilapi.test') });
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.role).toBe('admin');
  });
});
