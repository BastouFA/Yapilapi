import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Stash and the Near home (docs/product/stash.md, docs/product/your-city-alive.md): Ada hides a
 * stash at a spot in Lagos; Ben, 400 m away, sees only its area and "Get closer"; at 20 m he opens
 * it, and Ada hears "Ben found your stash". The navigation reads Near · Pulse · Create · Chats ·
 * You, at full width and at 375 px, and Create offers "Hide a stash" first. Positions come from
 * Playwright's geolocation; map tiles are answered here with a blank picture.
 * SHOTS (a folder) keeps screenshots of each step.
 */
const SHOTS = process.env.SHOTS;
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function account(request: APIRequestContext, name: string) {
  const username = `st_${name}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 30);
  const res = await request.post('/api/v1/auth/register', {
    data: {
      email: `${username}@stash.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: `[Dev data] ${name}`,
      birthDate: '1990-05-01',
    },
  });
  expect(res.status()).toBe(201);
  expect((await request.post('/api/v1/me/onboarding/complete', { data: {} })).ok()).toBeTruthy();
  return username;
}

async function person(
  browser: Browser,
  at: { latitude: number; longitude: number },
  colorScheme: 'light' | 'dark',
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext({ geolocation: { ...at, accuracy: 8 }, permissions: ['geolocation'], colorScheme, viewport });
  const page = await context.newPage();
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }));
  return { context, page };
}

const shot = async (page: Page, name: string, project: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: false });
};

test('hide a stash in Lagos, see only its area from 400 m, open it at 20 m', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const scheme = info.project.name.endsWith('dark') ? 'dark' : 'light';
  const narrow = info.project.name.startsWith('mobile');
  const viewport = narrow ? { width: 375, height: 812 } : undefined;
  // A spot of its own for each run, on Victoria Island.
  const spot = { latitude: 6.428 + Math.random() * 0.01, longitude: 3.421 + Math.random() * 0.01 };
  const north = (m: number) => ({ latitude: spot.latitude + m / 111_320, longitude: spot.longitude + 0.00005 });

  const ada = await person(browser, spot, scheme, viewport);
  await account(ada.page.request, 'ada');
  await ada.page.goto('/stash/new');
  await expect(ada.page.getByRole('heading', { name: 'Hide a stash', level: 1 })).toBeVisible();
  await ada.page.getByLabel('Your note').fill('[Dev data] The best suya is two stalls down. Tell them Ada sent you.');
  await ada.page.getByLabel('Title (optional)').fill('[Dev data] Suya tip');
  await ada.page.getByLabel('Hint (optional)').fill('By the blue gate');
  await shot(ada.page, 'hide-form', info.project.name);
  await ada.page.getByRole('button', { name: 'Hide it here' }).click();
  await ada.page.waitForURL(/\/stash\/[0-9a-f-]{36}$/);
  const id = ada.page.url().split('/').pop()!;
  // Ada sees her own spot.
  await expect(ada.page.getByText(/Your spot:/)).toBeVisible();
  await shot(ada.page, 'hidden', info.project.name);

  const ben = await person(browser, north(400), scheme, viewport);
  await account(ben.page.request, 'ben');
  await ben.page.goto(`/stash/${id}`);
  await expect(ben.page.getByRole('heading', { name: '[Dev data] Suya tip', level: 1 })).toBeVisible();
  await expect(ben.page.getByText('Only the area shows', { exact: false }).first()).toBeVisible();
  // Never the spot: neither of its numbers is anywhere in what Ben is sent.
  const answer = await (await ben.page.request.get(`/api/v1/stashes/${id}`)).text();
  expect(answer).not.toContain(String(spot.latitude));
  expect(answer).not.toContain(String(spot.longitude));
  expect(answer).not.toContain('"point"');
  await expect(ben.page.getByText(/Your spot:/)).toHaveCount(0);
  await ben.page.getByRole('button', { name: 'Open it here' }).click();
  await expect(ben.page.getByRole('status').filter({ hasText: /Get closer, about .+ to go/ })).toBeVisible();
  await shot(ben.page, 'get-closer', info.project.name);

  // Ben walks up to it.
  await ben.context.setGeolocation({ ...north(20), accuracy: 8 });
  await ben.page.getByRole('button', { name: 'Open it here' }).click();
  await expect(ben.page.getByRole('heading', { name: 'You found it' })).toBeVisible();
  await expect(ben.page.getByText('The best suya is two stalls down', { exact: false })).toBeVisible();
  await shot(ben.page, 'opened', info.project.name);

  // Ada hears who found it.
  await ada.page.goto('/notifications');
  await expect(ada.page.getByText('[Dev data] ben found your stash')).toBeVisible();
  await shot(ada.page, 'notification', info.project.name);

  // The navigation: Near · Pulse · Create · Chats · You, and Create offers a stash first.
  await ada.page.goto('/near');
  await expect(ada.page.getByRole('heading', { name: 'Near', level: 1 })).toBeVisible();
  const nav = ada.page.getByRole('navigation', { name: 'Primary' });
  for (const name of [/^Near/, /^Pulse/, /^Create/, /^Chats/, /You$/]) await expect(nav.getByRole('link', { name })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^Wander/ })).toHaveCount(0);
  const names = await nav.locator('.yp-nav__list > .yp-nav__item .yp-nav__label').allTextContents();
  expect(names).toEqual(['Near', 'Pulse', 'Create', 'Chats', 'You']);
  const width = await ada.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(0);
  await shot(ada.page, 'near', info.project.name);
  await nav.getByRole('link', { name: 'Create', exact: true }).click();
  const menu = ada.page.getByRole('dialog', { name: 'Create' });
  await expect(menu.getByRole('link').first()).toHaveText('Hide a stash');
  await shot(ada.page, 'create-menu', info.project.name);

  await ada.context.close();
  await ben.context.close();
});
