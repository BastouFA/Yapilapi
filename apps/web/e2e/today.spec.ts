import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Yapilapi Today (docs/product/yapilapi-today.md): Ada follows Bola, who posted and Yapped today.
 * Ada's Pulse shows the Today card; Play reads the first segment and moves on to the next by
 * itself; a segment about a Yap offers "Hear @bola"; "Not interested in this" puts a segment
 * away. It needs a model and a voice: run the API against e2e/today-stub.mjs (how is at its
 * top). Without a model (`today` off in /v1/flags) the test is skipped. The card is checked with axe in
 * every project, light and dark.
 */

/** The card passes axe (WCAG 2.2 AA, contrast in light and dark included). */
async function audit(page: Page) {
  const results = await new AxeBuilder({ page }).include('section.yp-ai').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** A zone where it is 2 in the afternoon now, so the Today (due from 5) is made when asked for. */
function zoneAt(hour: number): string {
  const off = (((hour - new Date().getUTCHours()) % 24) + 24) % 24;
  const o = off > 12 ? off - 24 : off;
  return o === 0 ? 'Etc/UTC' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`;
}
test.use({ timezoneId: zoneAt(14), launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

async function account(ctx: APIRequestContext, name: string) {
  const username = `td_${name}_${run}`.slice(0, 30);
  const res = await ctx.post('/api/v1/auth/register', {
    data: {
      email: `${username}@today.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: `[Dev data] ${name}`,
      birthDate: '1990-05-01',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  await ctx.post('/api/v1/me/onboarding/complete', { data: {} });
  return { ...((await res.json()).user as { id: string }), username };
}

test('the Today card plays its segments, offers the original Yap and can put one away', async ({ page, baseURL }, info) => {
  const flags = await (await page.request.get('/api/v1/flags')).json();
  test.skip(!flags.today, 'needs a model (e2e/today-stub.mjs)');

  const tag = `${info.project.name.startsWith('mobile') ? 'm' : 'd'}${info.project.name.endsWith('dark') ? 'k' : 'l'}`;
  const ada = await account(page.request, `ada${tag}`);
  const bolaCtx = await request.newContext({ baseURL });
  const bola = await account(bolaCtx, `bola${tag}`);
  expect((await page.request.post(`/api/v1/users/${bola.id}/follow`)).ok()).toBeTruthy();
  expect((await page.request.put('/api/v1/me/today', { data: { hour: 5 } })).ok()).toBeTruthy();

  const post = await bolaCtx.post('/api/v1/posts', { data: { body: 'The new bakery on Market Street opened this morning.', visibility: 'public' } });
  expect(post.status(), await post.text()).toBe(201);
  const buffer = await readFile(path.join(import.meta.dirname, 'fixtures', 'voice.m4a'));
  const clip = await bolaCtx.post('/api/v1/voice?purpose=yap', { multipart: { file: { name: 'voice.m4a', mimeType: 'audio/mp4', buffer } } });
  expect(clip.status(), await clip.text()).toBe(201);
  const voice = (await clip.json()).voice;
  const yap = await bolaCtx.post('/api/v1/posts', {
    data: { format: 'yap', body: 'Bus line 4 starts on Monday.', visibility: 'public', media: [{ id: voice.id, url: voice.url, kind: 'audio' }] },
  });
  expect(yap.status(), await yap.text()).toBe(201);

  await page.goto('/home');
  const card = page.locator('section.yp-ai', { hasText: 'Yapilapi Today' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Here’s what your people and your city are talking about.')).toBeVisible();
  await expect(card.getByText('AI-generated')).toBeVisible();
  await audit(page);

  // Play: the first segment is read out, then the second by itself.
  const spoken = page.waitForResponse((r) => r.url().includes('/media/') && r.url().endsWith('.mp3'));
  await card.getByRole('button', { name: 'Play your Today' }).click();
  expect((await spoken).ok()).toBeTruthy();
  await expect(card.getByText('Part 1 of 2')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(card.getByText('Part 2 of 2')).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(`@${bola.username} shared something new today.`)).toBeVisible();
  await audit(page);

  // The Yap's segment (whichever it is) offers its original, and links to it.
  const hear = card.getByRole('button', { name: `Hear @${bola.username}` });
  if (!(await hear.count())) await card.getByRole('button', { name: 'Previous' }).click();
  await expect(hear).toBeVisible();
  const original = page.waitForResponse((r) => r.url().includes(voice.url.split('/').pop()));
  await hear.click();
  expect((await original).status()).toBeLessThan(400);
  await expect(card.getByRole('link', { name: `[Dev data] bola${tag}’s post` })).toBeVisible();

  // "Not interested in this": one segment is left.
  await card.getByRole('button', { name: 'Not interested in this' }).click();
  await expect(card.getByText('Part 1 of 1')).toBeVisible();
  await bolaCtx.dispose();
  expect(ada.id).toBeTruthy();
});
