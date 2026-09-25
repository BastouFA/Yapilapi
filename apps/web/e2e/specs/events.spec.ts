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

test.describe('events', () => {
  test('browse a real public event, RSVP going, and see the count update', async ({ browser }) => {
    const host = await signedInContext(browser, { prefix: 'evhost', displayName: 'Hana Host' });
    const guest = await signedInContext(browser, { prefix: 'evguest', displayName: 'Gio Guest' });
    const watch = watchPage(guest.page);

    const title = `Community Picnic ${Date.now().toString(36)}`;
    const created = await api<{ id: string }>(host.context.request, 'POST', '/v1/events', {
      title,
      description: 'Bring your own blanket.',
      startsAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      locationText: 'Riverside Park',
      visibility: 'public',
      publish: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const id = created.body.id;

    await guest.page.goto('/events');
    await expect(guest.page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
    await expectNoSeriousA11yViolations(guest.page, 'events (browse)');
    await expect(guest.page.getByRole('link', { name: title })).toBeVisible();

    await guest.page.getByRole('link', { name: title }).click();
    await expect(guest.page).toHaveURL(new RegExp(`/events/${id}`));
    await expect(guest.page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(guest.page.getByText('Riverside Park')).toBeVisible();
    await expect(guest.page.getByText(/Hosted by Hana Host/)).toBeVisible();
    await expectNoSeriousA11yViolations(guest.page, 'event detail (not going)');

    await guest.page.getByRole('button', { name: 'Going', exact: true }).click();
    await expect(guest.page.getByText('Your response was saved.')).toBeVisible();
    await expect(guest.page.getByRole('button', { name: 'Withdraw' })).toBeVisible();
    await guest.page.reload();
    await expect(guest.page.getByText('1 going')).toBeVisible();

    // The host sees the guest in the attendee list.
    await host.page.goto(`/events/${id}`);
    await expect(host.page.getByText('Gio Guest')).toBeVisible();
    await expectNoSeriousA11yViolations(host.page, 'event detail (host)');

    watch.assertClean();
    await host.context.close();
    await guest.context.close();
  });
});
