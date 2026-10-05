import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { STATE } from './global-setup';

/** A short tone as a WAV file, to upload as a recording. */
function toneWav(seconds: number): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return b;
}

/**
 * Posts and Pulse layouts that broke once: page titles splitting mid-word on a phone, a poll's
 * result bar pushing its option aside, and a comment notification's link not opening the comments.
 */
test.use({ storageState: STATE });
// Themes don't change these layouts; run once per layout.
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

test('Pulse and Wander titles stay on one line', async ({ page }) => {
  for (const path of ['/home', '/discover']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const title = page.locator('.yp-topbar h1').first();
    const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const box = await title.boundingBox();
    expect(box!.height, `${path} title wraps`).toBeLessThanOrEqual(lineHeight + 1);
  }
});

test('a poll result bar sits behind its option', async ({ page }) => {
  const created = await page.request.post('/api/v1/posts', { data: { body: '[Dev data] Tea or coffee?', poll: { options: ['Tea', 'Coffee'] } } });
  const { post } = await created.json();
  await page.goto(`/p/${post.id}`);
  await page.getByRole('button', { name: 'Tea' }).click();
  const option = page.locator('.yp-poll button').first();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  const bar = option.locator('.yp-poll__bar');
  await expect(bar).toHaveCSS('position', 'absolute');
  // The label still starts at the option's start edge, not after the bar.
  const [optionBox, labelBox] = await Promise.all([option.boundingBox(), option.locator('span:not(.yp-poll__bar)').first().boundingBox()]);
  expect(Math.abs(labelBox!.x - optionBox!.x)).toBeLessThan(40);
  // A single post has no end-of-feed line.
  await expect(page.getByText("You're all caught up")).toHaveCount(0);
});

test('a link to a post with ?comments=1 opens its comments', async ({ page }) => {
  const created = await page.request.post('/api/v1/posts', { data: { body: '[Dev data] Comment on this' } });
  const { post } = await created.json();
  await page.request.post(`/api/v1/posts/${post.id}/comments`, { data: { body: 'First' } });
  await page.goto(`/p/${post.id}?comments=1`);
  await expect(page.getByRole('dialog', { name: 'Comments' }).getByText('First')).toBeVisible();
});

test('an audio post plays in the card, and its transcript opens from the keyboard', async ({ page }) => {
  const up = await page.request.post('/api/v1/media', { multipart: { file: { name: 'tone.wav', mimeType: 'audio/wav', buffer: toneWav(2) } } });
  expect(up.status()).toBe(201);
  const { media } = await up.json();
  expect(media.kind).toBe('audio');
  const created = await page.request.post('/api/v1/posts', {
    data: { body: '[Dev data] A voice note', visibility: 'friends', media: [{ id: media.id, url: media.url, kind: 'audio' }] },
  });
  const { post } = await created.json();
  expect(post.kind).toBe('audio');
  await page.request.put(`/api/v1/media/${media.id}/captions/en`, {
    data: { label: 'English', cues: [{ start: 0, end: 1.5, text: 'Hello from the recording.' }] },
  });
  await page.goto(`/p/${post.id}`);
  const player = page.locator('.yp-audio audio');
  await expect(player).toHaveAttribute('aria-label', 'Recording');
  await expect.poll(() => player.evaluate((a: HTMLAudioElement) => Math.round(a.duration || 0))).toBe(2);
  await page.locator('.yp-audio__transcript summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.yp-audio__transcript p')).toHaveText('Hello from the recording.');
  const results = await new AxeBuilder({ page }).include('.yp-audio').analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
