import { expect, test } from '@playwright/test';
import { api, expectNoSeriousA11yViolations, registerViaApi, watchPage } from '../support/helpers';
import { API_URL, WEB_URL } from '../support/env';

/**
 * Axe (serious/critical must be zero) across the main pages in the display variants people actually use:
 * dark theme, right-to-left Arabic, a phone-sized viewport, low-bandwidth mode and high contrast.
 */
// Signed-in people's language, theme and data-saving choices come from their account, contrast from a cookie.
const VARIANTS: Array<{
  name: string;
  account: Record<string, unknown>;
  cookies?: Record<string, string>;
  viewport?: { width: number; height: number };
}> = [
  { name: 'dark', account: { theme: 'dark' } },
  { name: 'arabic-rtl', account: { locale: 'ar', theme: 'light' } },
  {
    name: 'phone',
    account: { locale: 'en', theme: 'light' },
    viewport: { width: 375, height: 740 },
  },
  { name: 'low-bandwidth', account: { locale: 'en', lowBandwidth: true } },
  {
    name: 'high-contrast-dark',
    account: { lowBandwidth: false, theme: 'dark' },
    cookies: { yl_contrast: 'more' },
  },
];

test('accessibility sweep: home, discover, inbox, chat, communities, channel, settings in every variant', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ctx0 = await browser.newContext({
    baseURL: WEB_URL,
    locale: 'en-GB',
    timezoneId: 'Africa/Lagos',
    reducedMotion: 'reduce',
  });
  const me = await registerViaApi(ctx0.request, { prefix: 'sweep', displayName: 'Sweep Person' });
  const other = await browser.newContext({ baseURL: WEB_URL, locale: 'en-GB' });
  const peer = await registerViaApi(other.request, { prefix: 'peer', displayName: 'Peer Person' });

  // Real content on every surface.
  const c = await api<{ slug: string; id: string }>(ctx0.request, 'POST', '/v1/communities', {
    name: `Sweep Club ${Date.now().toString(36)}`,
    description: 'A community for the sweep.',
    visibility: 'public',
  });
  expect(c.status).toBe(201);
  await api(ctx0.request, 'POST', '/v1/posts', {
    body: 'A post for the sweep',
    visibility: 'public',
  });
  await api(ctx0.request, 'POST', '/v1/posts', {
    body: 'A community post for the sweep',
    visibility: 'community',
    communityId: c.body.id,
  });
  const channels = await api<{ items: Array<{ id: string }> }>(
    ctx0.request,
    'GET',
    `/v1/communities/${c.body.id}/channels`,
  );
  const cid = channels.body.items[0]!.id;
  await api(ctx0.request, 'POST', `/v1/conversations/${cid}/messages`, {
    body: 'Channel message for the sweep',
  });
  const dm = await api<{ id: string }>(other.request, 'POST', '/v1/conversations/direct', {
    username: me.username,
  });
  expect(dm.status, JSON.stringify(dm.body)).toBeLessThan(300);
  await api(other.request, 'POST', `/v1/conversations/${dm.body.id}/messages`, {
    body: 'Hi from the peer',
  });
  const reply = await api<{ id: string }>(
    ctx0.request,
    'POST',
    `/v1/conversations/${dm.body.id}/messages`,
    { body: 'Hi back', replyToId: undefined },
  );
  await api(other.request, 'PUT', `/v1/messages/${reply.body.id}/reaction`, { kind: 'love' });
  await api(other.request, 'POST', `/v1/conversations/${dm.body.id}/messages`, {
    body: 'Another one so there is an unread badge',
  });
  void peer;

  const pages: Array<{ label: string; path: string; ready: string }> = [
    { label: 'home', path: '/', ready: 'main h1' },
    { label: 'discover', path: '/discover', ready: 'main h1' },
    { label: 'inbox', path: '/inbox', ready: 'main h1' },
    { label: 'chat', path: `/inbox/${dm.body.id}`, ready: '[role="log"] [data-message-id]' },
    { label: 'communities', path: '/communities', ready: 'main h1' },
    {
      label: 'community',
      path: `/communities/${c.body.slug}`,
      ready: '[data-testid="post-card"], article',
    },
    {
      label: 'channel',
      path: `/communities/${c.body.slug}/channels/${cid}`,
      ready: '[role="log"] [data-message-id]',
    },
    { label: 'new community', path: '/communities/new', ready: 'main h1' },
  ];

  for (const v of VARIANTS) {
    const context = await browser.newContext({
      baseURL: WEB_URL,
      locale: 'en-GB',
      timezoneId: 'Africa/Lagos',
      reducedMotion: 'reduce',
      ...(v.viewport ? { viewport: v.viewport } : {}),
    });
    await context.addCookies(
      Object.entries(v.cookies ?? {}).map(([name, value]) => ({ name, value, url: WEB_URL })),
    );
    // Sign in as the same person in this fresh context.
    const login = await context.request.post(`${API_URL}/v1/auth/login`, {
      headers: { origin: WEB_URL, 'x-yl-csrf': '1' },
      data: { email: me.email, password: me.password },
    });
    expect(login.status(), await login.text()).toBeLessThan(300);
    const prefs = await api(context.request, 'PATCH', '/v1/settings/preferences', v.account);
    expect(prefs.status, JSON.stringify(prefs.body)).toBeLessThan(300);
    const page = await context.newPage();
    const watch = watchPage(page);
    for (const p of pages) {
      await page.goto(p.path);
      await expect(page.locator(p.ready).first()).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      if (v.name === 'arabic-rtl') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      if (v.name === 'low-bandwidth')
        await expect(page.locator('html')).toHaveAttribute('data-bandwidth', 'low');
      await expectNoSeriousA11yViolations(page, `${p.label} [${v.name}]`);
      if (v.viewport) {
        // Reflow: nothing may force sideways scrolling on a phone.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${p.label}: horizontal overflow on phone`).toBeLessThanOrEqual(1);
      }
    }
    watch.assertClean();
    await context.close();
  }
  await ctx0.close();
  await other.close();
});
