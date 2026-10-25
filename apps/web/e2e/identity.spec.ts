import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The signed-out landing page in English and French (still "The social network you speak" until
 * step 3 of docs/product/your-city-alive.md), signing in landing on Pulse, the navigation,
 * Pulse · Wander · Create · Chats · You, with Create in the middle (a tap offers a stash, post, reel,
 * story, live or Yap), at phone width and on a computer, and onboarding's first step, a voice hello that can
 * be recorded or skipped. Chrome's fake media flags stand in for a real microphone. Each project
 * (light and dark, desktop and phone) runs the page checks; recording runs in the light ones.
 */
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone'],
});

async function account(request: APIRequestContext, name: string, onboarded = true, password = randomBytes(18).toString('base64url')) {
  const username = `id_${name}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 30);
  const res = await request.post('/api/v1/auth/register', {
    data: {
      email: `${username}@identity.example.test`,
      password,
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

/** The five places in the navigation, in order, by their labels. */
const MENU = ['Pulse', 'Wander', 'Create', 'Chats', 'You'];
const menuLabels = (page: Page) => page.getByRole('navigation', { name: 'Primary' }).locator('.yp-nav__list > .yp-nav__item .yp-nav__label');

test.describe('navigation', () => {
  // docs/product/your-city-alive.md, "The menu": Pulse · Wander · + · Chats · You, Create in the middle.
  test('signing in lands on Pulse', async ({ page, request }) => {
    const password = randomBytes(18).toString('base64url');
    const username = await account(request, 'signin', true, password);
    await page.goto('/login');
    await page.getByLabel('Email address').fill(`${username}@identity.example.test`);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.waitForURL(/\/home$/);
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Pulse/ })).toHaveAttribute('aria-current', 'page');
    // Near was the first tab for a day: its address opens Wander now.
    await page.goto('/near');
    await page.waitForURL(/\/discover$/);
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Wander/ })).toHaveAttribute('aria-current', 'page');
  });

  test('Pulse · Wander · Create · Chats · You, with Create in the middle', async ({ page, isMobile }) => {
    await account(page.request, 'nav');
    await page.goto('/home');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(menuLabels(page)).toHaveText(MENU);
    await expect(nav.getByRole('link', { name: /^Pulse/ })).toHaveAttribute('href', '/home');
    await expect(nav.getByRole('link', { name: /^Wander/ })).toHaveAttribute('href', '/discover');
    await expect(nav.getByRole('link', { name: /^Chats/ })).toHaveAttribute('href', '/inbox');
    await expect(nav.getByRole('link', { name: /^Near/ })).toHaveCount(0);
    const create = nav.getByRole('link', { name: 'Create', exact: true });
    await expect(create).toBeInViewport();
    // The raised button in the middle is the biggest thing in the bar.
    const box = (await create.locator('.yp-nav__icon').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(isMobile ? 54 : 22);
    await noSidewaysScroll(page);
    // A tap opens the ways to create (a stash first), and doesn't follow the link.
    await create.click();
    const menu = page.getByRole('dialog', { name: 'Create' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link').first()).toHaveText('Hide a stash');
    for (const name of ['Post', 'Reel', 'Story', 'Yap']) await expect(menu.getByRole('link', { name })).toBeVisible();
    // Live is there while the LIVE feature is on.
    const flags = (await (await page.request.get('/api/v1/flags')).json()).flags as Record<string, boolean>;
    await expect(menu.getByRole('link', { name: 'Live' })).toHaveCount(flags.LIVE ? 1 : 0);
    await expect(page).toHaveURL(/\/home/);
    await menu.getByRole('link', { name: 'Reel' }).click();
    await expect(page).toHaveURL(/\/camera\?mode=reel/);
  });

  test('at 375px wide, nothing overflows and Create fits', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await account(page.request, 'narrow');
    await page.goto('/home');
    const create = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Create', exact: true });
    await expect(create).toBeInViewport({ ratio: 1 });
    await expect(menuLabels(page)).toHaveText(MENU);
    await noSidewaysScroll(page);
    // Wander at phone width: the map and what's on now fit too.
    await page.goto('/discover');
    await expect(page.getByRole('heading', { level: 2, name: 'What’s on now' })).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('Yap in Create opens the recorder', async ({ page }, info) => {
    lightOnly(info.project.name);
    test.setTimeout(90_000);
    await account(page.request, 'button');
    await page.goto('/home');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Create', exact: true }).click();
    await page.getByRole('dialog', { name: 'Create' }).getByRole('link', { name: 'Yap' }).click();
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
