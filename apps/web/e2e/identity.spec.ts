import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * "The social network you speak" (docs/product/yaps.md, "Naming" and "The Yap button"): the
 * signed-out landing page in English and French, the Yap button in the middle of the navigation
 * (it opens the recorder; a right click or a long press offers the other ways to create), the
 * navigation at phone width and on a computer, and onboarding's first step, a voice hello that can
 * be recorded or skipped. Chrome's fake media flags stand in for a real microphone. Each project
 * (light and dark, desktop and phone) runs the page checks; recording runs in the light ones.
 */
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone'],
});

async function account(request: APIRequestContext, name: string, onboarded = true) {
  const username = `id_${name}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 30);
  const res = await request.post('/api/v1/auth/register', {
    data: {
      email: `${username}@identity.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: `[Dev data] ${name}`,
      birthDate: '1990-05-01',
    },
  });
  expect(res.status()).toBe(201);
  if (onboarded) expect((await request.post('/api/v1/me/onboarding/complete', { data: {} })).ok()).toBeTruthy();
  return username;
}

/** Record for about `ms` with tap-to-start and tap-to-stop. */
async function record(page: Page, ms: number) {
  await page.getByTestId('yap-record').click();
  await page.waitForTimeout(ms);
  await page.getByTestId('yap-record').click();
  await expect(page.getByTestId('yap-preview')).toBeVisible();
}

/** Nothing on the page is wider than the screen. */
async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

const lightOnly = (name: string) => test.skip(name.endsWith('dark'), 'recording is the same in dark mode');

test.describe('landing page', () => {
  test('says "Speak. The world understands." in English', async ({ browser, baseURL }, info) => {
    const ctx = await browser.newContext({ ...info.project.use, baseURL, locale: 'en-GB' });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Speak. The world understands.');
    await expect(page.getByText('The social network you speak')).toBeVisible();
    for (const name of ['Hold to talk', 'Heard in every language', 'Light on data', 'Yap Radio', 'Ask the city', 'Pass the Mic', 'Squads'])
      await expect(page.getByRole('heading', { level: 3, name })).toBeVisible();
    // Legal links stay.
    await expect(page.getByRole('contentinfo').getByRole('link').first()).toBeVisible();
    await expect(page).toHaveTitle(/the social network you speak/);
    expect(await page.locator('meta[name="description"]').getAttribute('content')).toMatch(/^Speak\. The world understands\./);
    await noSidewaysScroll(page);
    await ctx.close();
  });

  test('and in French', async ({ browser, baseURL }, info) => {
    const ctx = await browser.newContext({ ...info.project.use, baseURL, locale: 'fr-FR' });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Parle. Le monde comprend.');
    await expect(page.getByRole('heading', { level: 3, name: 'Passe le micro' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Léger en données' })).toBeVisible();
    await noSidewaysScroll(page);
    await ctx.close();
  });
});

test.describe('navigation', () => {
  test('Pulse · Wander · Yap · Chats · You, with the Yap button in the middle', async ({ page, isMobile }) => {
    await account(page.request, 'nav');
    await page.goto('/home');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const yap = nav.getByRole('link', { name: 'Yap', exact: true });
    await expect(yap).toBeInViewport();
    await expect(yap).toHaveAttribute('href', '/create?mode=yap');
    await expect(nav.getByRole('link', { name: /^Chats/ })).toHaveAttribute('href', '/inbox');
    // The Yap button is the biggest thing in the bar.
    const box = (await yap.locator('.yp-nav__icon').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(isMobile ? 56 : 22);
    // Wide screens have the menu's own button beside it; phones hold the button down instead.
    await expect(nav.getByRole('button', { name: 'More ways to create' })).toBeVisible({ visible: !isMobile });
    // Pulse: Yaps right after For you.
    const filters = page.getByRole('group', { name: 'Feed' }).getByRole('button');
    await expect(filters.nth(0)).toHaveText('For you');
    await expect(filters.nth(1)).toHaveText('Yaps');
    await noSidewaysScroll(page);
    // A right click (a long press on a phone) opens the other ways to create, and doesn't follow the link.
    await yap.click({ button: 'right' });
    const menu = page.getByRole('dialog', { name: 'More ways to create' });
    await expect(menu).toBeVisible();
    for (const name of ['Post', 'Reel', 'Story']) await expect(menu.getByRole('link', { name })).toBeVisible();
    // Live is there while the LIVE feature is on.
    const flags = (await (await page.request.get('/api/v1/flags')).json()).flags as Record<string, boolean>;
    await expect(menu.getByRole('link', { name: 'Live' })).toHaveCount(flags.LIVE === false ? 0 : 1);
    await expect(page).toHaveURL(/\/home/);
    await menu.getByRole('link', { name: 'Reel' }).click();
    await expect(page).toHaveURL(/\/camera\?mode=reel/);
  });

  test('at 375px wide, nothing overflows and the Yap button fits', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await account(page.request, 'narrow');
    await page.goto('/home');
    const yap = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Yap', exact: true });
    await expect(yap).toBeInViewport({ ratio: 1 });
    await noSidewaysScroll(page);
  });

  test('the Yap button opens the recorder', async ({ page }, info) => {
    lightOnly(info.project.name);
    test.setTimeout(90_000);
    await account(page.request, 'button');
    await page.goto('/home');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Yap', exact: true }).click();
    await expect(page).toHaveURL(/\/create\?mode=yap/);
    await expect(page.getByTestId('yap-record')).toBeVisible();
    await record(page, 2500);
    await expect(page.getByTestId('yap-post')).toBeEnabled();
  });
});

test.describe('onboarding', () => {
  test('starts with "Say hi to YAPILAPI": record a voice intro', async ({ page }, info) => {
    lightOnly(info.project.name);
    test.setTimeout(90_000);
    const username = await account(page.request, 'hello', false);
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { level: 1, name: 'Say hi to YAPILAPI' })).toBeVisible();
    await expect(page.getByText('Whatever you say here reaches people in their own language.')).toBeVisible();
    await expect(page.getByText('Step 1 of 4')).toBeVisible();
    await record(page, 2500);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'What are you into?' })).toBeVisible();
    await expect(page.getByText('Step 2 of 4')).toBeVisible();
    const profile = (await (await page.request.get(`/api/v1/users/${username}`)).json()).profile;
    expect(profile.voiceIntro?.durationMs).toBeGreaterThan(1000);
  });

  test('the voice hello can be skipped', async ({ page }, info) => {
    lightOnly(info.project.name);
    const username = await account(page.request, 'skip', false);
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { level: 1, name: 'Say hi to YAPILAPI' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'What are you into?' })).toBeVisible();
    const profile = (await (await page.request.get(`/api/v1/users/${username}`)).json()).profile;
    expect(profile.voiceIntro ?? null).toBeNull();
  });
});
