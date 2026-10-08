import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Yap Radio (docs/product/yap-radio.md): someone you follow posts a few short Yaps; you press play
 * on the Friends station and it plays them one after another by itself, keeps playing in the bar
 * at the bottom while you move around the app, answers the keyboard (space, → and j, ← and k) and
 * offers a sleep timer. Yaps are posted through the API with a tiny recording (fixtures/voice.m4a).
 */
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.beforeEach(({}, info) => test.skip(!info.project.name.startsWith('desktop-light'), 'one browser is enough for listening'));

const VOICE = path.join(import.meta.dirname, 'fixtures', 'voice.m4a');

async function account(request: APIRequestContext, name: string) {
  const username = `radio_${name}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 30);
  const res = await request.post('/api/v1/auth/register', {
    data: {
      email: `${username}@radio.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: `[Dev data] ${name}`,
      birthDate: '1990-05-01',
    },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).user.id as string;
  expect((await request.put('/api/v1/me/interests', { data: { topics: ['music', 'food', 'design'] } })).ok()).toBeTruthy();
  expect((await request.post('/api/v1/me/onboarding/complete', { data: {} })).ok()).toBeTruthy();
  return { id, username };
}

async function postYap(request: APIRequestContext, line: string) {
  const up = await request.post('/api/v1/voice?purpose=yap', {
    multipart: { file: { name: 'voice.m4a', mimeType: 'audio/mp4', buffer: await readFile(VOICE) } },
  });
  expect(up.status(), await up.text()).toBe(201);
  const v = (await up.json()).voice as { id: string; url: string };
  const res = await request.post('/api/v1/posts', {
    data: { format: 'yap', visibility: 'public', body: line, media: [{ id: v.id, url: v.url, kind: 'audio' }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).post.id as string;
}

const paused = (page: Page) => page.getByTestId('radio-audio').evaluate((a: HTMLAudioElement) => a.paused);
const nowPlaying = (page: Page) => page.getByTestId('radio-now').getAttribute('data-post');

test('plays a station hands-free, keeps playing across the app, and answers the keyboard', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  // Someone to listen to, with three short Yaps.
  const speakerContext = await browser.newContext({ baseURL });
  const speaker = await account(speakerContext.request, 'speaker');
  const yaps: string[] = [];
  for (const line of ['[Dev data] First on the radio', '[Dev data] Second on the radio', '[Dev data] Third on the radio'])
    yaps.push(await postYap(speakerContext.request, line));
  await speakerContext.close();

  await account(page.request, 'listener');
  expect((await page.request.post(`/api/v1/users/${speaker.id}/follow`)).ok()).toBeTruthy();

  // Wander leads to the radio.
  await page.goto('/discover');
  await page.getByTestId('wander-radio').click();
  await page.waitForURL(/\/radio$/);
  await expect(page.getByRole('heading', { name: 'Radio', level: 1 })).toBeVisible();

  // Friends: newest first, playing by itself.
  await page.getByTestId('radio-station-friends').click();
  await expect(page.getByTestId('radio-now')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('radio-speaker')).toHaveText('[Dev data] speaker');
  await expect.poll(() => nowPlaying(page)).toBe(yaps[2]);
  await expect.poll(() => paused(page)).toBe(false);
  await expect(page.getByTestId('radio-station-friends')).toHaveAttribute('aria-pressed', 'true');

  // It goes on to the next Yap when one ends (a two-second clip, then a short quiet).
  await expect.poll(() => nowPlaying(page), { timeout: 15_000 }).toBe(yaps[1]);
  await expect(page.getByTestId('radio-data')).toContainText(/About \d+ KB used/);

  // The sleep timer.
  await page.getByTestId('radio-sleep').selectOption('15');
  await expect(page.getByTestId('radio-sleep').locator('option:checked')).toHaveText(/Stops in 1[45]:\d\d/);

  // Moving around the app: the bar stays and the sound keeps going.
  await page.getByRole('link', { name: /Pulse/ }).first().click();
  await page.waitForURL(/\/home/);
  const bar = page.getByTestId('radio-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('radio-bar-name')).toHaveText('[Dev data] speaker');
  expect(await paused(page)).toBe(false);

  // The keyboard, with nothing else focused: space pauses and plays, k and j go back and forward.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await expect.poll(() => paused(page)).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(() => paused(page)).toBe(false);

  await bar.getByRole('link', { name: 'Open Radio' }).click();
  await page.waitForURL(/\/radio$/);
  const before = await nowPlaying(page);
  await page.locator('h1').click();
  await page.keyboard.press('j');
  await expect.poll(() => nowPlaying(page)).not.toBe(before);
  await page.keyboard.press('k');
  await expect.poll(() => nowPlaying(page)).toBe(before);

  // Stop from the bar: gone.
  await page
    .getByRole('link', { name: /Wander/ })
    .first()
    .click();
  await page.waitForURL(/\/discover/);
  await bar.getByRole('button', { name: 'Stop Radio' }).click();
  await expect(bar).toBeHidden();
});
