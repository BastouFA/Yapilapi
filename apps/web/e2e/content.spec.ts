import { expect, test } from '@playwright/test';
import { STATE } from './global-setup';

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
