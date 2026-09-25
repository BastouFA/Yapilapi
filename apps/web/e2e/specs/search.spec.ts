import { expect, test, type Browser } from '@playwright/test';
import { api, expectNoSeriousA11yViolations, registerViaApi, watchPage } from '../support/helpers';
import { WEB_URL } from '../support/env';

async function signedInContext(browser: Browser, opts: Parameters<typeof registerViaApi>[1] = {}) {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    locale: 'en-GB',
    timezoneId: 'Africa/Lagos',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const user = await registerViaApi(context.request, opts);
  return { context, page, user };
}

test.describe('search', () => {
  test('search finds a real event, filters to one type, and remembers recent searches', async ({
    browser,
  }) => {
    const { context, page } = await signedInContext(browser, {
      prefix: 'searcher',
      displayName: 'Sasha Searcher',
    });
    const watch = watchPage(page);

    const unique = `Zylowatt${Date.now().toString(36)}`;
    const title = `${unique} Rooftop Meetup`;
    const created = await api<{ id: string }>(context.request, 'POST', '/v1/events', {
      title,
      description: 'A test event for the search suite.',
      startsAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      locationText: 'Downtown Hall',
      visibility: 'public',
      publish: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    await page.goto('/search');
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'search (empty)');

    await page.getByRole('textbox', { name: 'Search' }).fill(unique);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`q=${unique}`));

    // Overview mode: a section for the type that matched, with the real event in it.
    await expect(page.getByRole('link', { name: title })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'search (results)');

    // Focus on just Events: a cursor-paginated, single-type list.
    await page.getByRole('button', { name: 'Events', exact: true }).click();
    await expect(page).toHaveURL(/type=events/);
    await expect(page.getByRole('link', { name: title })).toBeVisible();

    // Following the result takes you to the real event page.
    await page.getByRole('link', { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`/events/${created.body.id}`));
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    // Recent searches: back on an empty search, the earlier query is offered again.
    await page.goto('/search');
    await expect(page.getByRole('heading', { name: 'Recent searches' })).toBeVisible();
    await expect(page.getByRole('button', { name: unique })).toBeVisible();

    watch.assertClean();
    await context.close();
  });
});
