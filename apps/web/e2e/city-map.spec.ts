import { expect, test } from '@playwright/test';
import { STATE } from './global-setup';

/**
 * Near you (/map, docs/product/city-map.md): the map starts where the browser is when the site may
 * read it, shows today's events as pins and as a list, layers turn off, and the map moves and zooms
 * from the keyboard. Map tiles are answered here with a blank picture, so nothing goes to the tile server.
 */
test.use({ storageState: STATE });
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('shows what is on today around you, on the map and as a list', async ({ page, context }, info) => {
  const narrow = info.project.name.startsWith('mobile');
  // A spot of its own for each run: the map keeps an area's answer for a little while.
  const at = { latitude: -30 + Math.random() * 60, longitude: -150 + Math.random() * 300 };
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(at);
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }));

  const place = await (
    await page.request.post('/api/v1/places', {
      data: { name: '[Dev data] Harbour steps', category: 'venue', city: 'Testville', lat: at.latitude, lng: at.longitude },
    })
  ).json();
  const created = await page.request.post('/api/v1/events', {
    data: {
      title: '[Dev data] Night market',
      description: 'Food stalls by the water.',
      startsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      placeId: place.place.id,
    },
  });
  expect(created.ok()).toBeTruthy();

  await page.goto('/map');
  await expect(page.getByRole('heading', { name: 'Near you', level: 1 })).toBeVisible();
  const map = page.getByRole('region', { name: 'Near you' });
  await expect(map).toBeVisible();

  // The pin, and its card.
  const pin = page.getByRole('button', { name: /Night market/ });
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(page.getByRole('group', { name: /Night market/ }).getByRole('link', { name: /Night market/ })).toBeVisible();

  // The same results as a list (beside the map on wide screens).
  if (narrow) await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page.getByRole('region', { name: 'List' }).getByRole('link', { name: /Night market/ });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('href', /\/events\//);

  // Turning Today off takes it away.
  await page.getByRole('checkbox', { name: 'Today' }).uncheck();
  await expect(row).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Today' }).check();
  await expect(row).toBeVisible();

  // The keyboard moves and zooms the map: + loads the next zoom level's tiles.
  if (narrow) await page.getByRole('button', { name: 'Map', exact: true }).click();
  await map.focus();
  await page.keyboard.press('+');
  await expect(map.locator('img[src*="/14/"]').first()).toBeAttached();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('link', { name: '© OpenStreetMap contributors' })).toBeVisible();
});
