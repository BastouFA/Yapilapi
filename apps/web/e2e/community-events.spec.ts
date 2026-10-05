import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, request, test } from '@playwright/test';
import { DATA, FRIEND_STATE, STATE, type SeedData } from './global-setup';

/**
 * Communities and events on the web, from the 2026-10-05 sweep: running a community from its
 * settings (the web had none, so requests to join went unanswered), and the event form keeping
 * times in the event's own time zone.
 */
test.use({ storageState: STATE });
// Themes don't change these flows; run once per layout.
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

test('an owner answers a request to join from the community settings', async ({ page, baseURL }) => {
  const slug = `e2e-manage-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  await page.request.post('/api/v1/communities', { data: { name: '[Dev data] Darkroom club', slug, visibility: 'private' } });
  const ben = await request.newContext({ baseURL, storageState: FRIEND_STATE });
  await ben.post(`/api/v1/communities/${slug}/join`);

  await page.goto(`/c/${slug}`);
  await page.getByRole('link', { name: 'Community settings' }).click();
  await page.getByRole('tab', { name: 'Requests' }).click();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('No requests')).toBeVisible();

  // Banning asks first, and the question closes with Escape.
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByRole('button', { name: 'Ban' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const asBen = await (await ben.get(`/api/v1/communities/${slug}`)).json();
  expect(asBen.community.myRole).toBe('member');
  await ben.dispose();
});

test("the event form shows times in the event's own time zone", async ({ page }) => {
  const data: SeedData = JSON.parse(await readFile(DATA, 'utf8'));
  expect(data.userId).toBeTruthy();
  // 09:00 UTC is 18:00 in Tokyo.
  const created = await page.request.post('/api/v1/events', {
    data: { title: '[Dev data] Rooftop night', startsAt: '2030-01-02T09:00:00Z', timezone: 'Asia/Tokyo', locationText: 'Shibuya' },
  });
  const { event } = await created.json();
  await page.goto(`/events/${event.id}/edit`);
  await expect(page.getByLabel('Starts')).toHaveValue('2030-01-02T18:00');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Tokyo');
  await page.getByLabel('Starts').fill('2030-01-02T19:30');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${event.id}$`));
  const saved = await (await page.request.get(`/api/v1/events/${event.id}`)).json();
  expect(saved.event.startsAt).toBe('2030-01-02T10:30:00.000Z');
});
