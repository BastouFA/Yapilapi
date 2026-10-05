import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, request, test } from '@playwright/test';
import { FRIEND_STATE, STATE } from './global-setup';

/**
 * Money and Market screens that broke once: countering an offer showed the new amount on the
 * offer it answered, and a page whose list failed to load said there was nothing instead of
 * offering to try again.
 */
test.use({ storageState: STATE });
// Themes don't change these; run once per layout.
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

test('countering an offer leaves the offer it answers as it was', async ({ page, baseURL }) => {
  // A listing of yours, with words of its own so it isn't held as a repeat.
  const run = Math.random().toString(36).slice(2, 8);
  const buffer = await readFile(path.join(import.meta.dirname, 'fixtures', 'market.jpg'));
  const media = (
    await (await page.request.post('/api/v1/media', { multipart: { altText: 'A stool', file: { name: 'market.jpg', mimeType: 'image/jpeg', buffer } } })).json()
  ).media;
  const created = await page.request.post('/api/v1/market/listings', {
    data: {
      title: `[Dev data] Pine stool ${run}`,
      description: `Sturdy, a few marks. Ref ${run}.`,
      category: 'furniture',
      condition: 'good',
      priceCents: 4000,
      photos: [{ mediaId: media.id }],
      area: 'Graça',
      delivery: ['pickup'],
    },
  });
  expect(created.ok()).toBeTruthy();
  const { listing } = await created.json();

  // Ben offers $30.
  const ben = await request.newContext({ baseURL, storageState: FRIEND_STATE });
  const offered = await ben.post(`/api/v1/market/listings/${listing.id}/offers`, { data: { amountCents: 3000 } });
  expect(offered.ok()).toBeTruthy();
  const { conversationId } = await offered.json();
  await ben.dispose();

  await page.goto(`/inbox/${conversationId}`);
  // The chat with Ben holds other runs' offers too: this listing's only.
  const offers = page.locator('.market-offer').filter({ hasText: `Pine stool ${run}` });
  const original = offers.filter({ hasText: '$30.00' });
  await original.getByRole('button', { name: 'Counter' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox').fill('35');
  await sheet.getByRole('button', { name: 'Send counter-offer' }).click();

  // The new amount is a card of its own; Ben's offer still says $30 and that it was answered.
  await expect(offers.filter({ hasText: '$35.00' })).toBeVisible();
  await expect(original).toContainText('Answered with another amount');
  await expect(original.getByRole('button', { name: 'Accept' })).toHaveCount(0);
});

test('Market and Plus say when they could not load, with a way to try again', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/market/search', (r) => (fail ? r.abort('internetdisconnected') : r.continue()));
  await page.goto('/market');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  fail = false;
  await retry.click();
  await expect(retry).toHaveCount(0);

  await page.route('**/api/v1/plus', (r) => r.abort('internetdisconnected'));
  await page.goto('/plus');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
