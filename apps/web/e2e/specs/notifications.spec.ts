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

test.describe('notifications', () => {
  test('a real follow shows up unread, can be marked read, and settings save', async ({
    browser,
  }) => {
    const { context, page, user } = await signedInContext(browser, {
      prefix: 'notifme',
      displayName: 'Nadia Notify',
    });
    const peer = await signedInContext(browser, { prefix: 'notifpeer', displayName: 'Peer' });
    const watch = watchPage(page);

    const followed = await api(peer.context.request, 'PUT', `/v1/users/${user.username}/follow`);
    expect(followed.status, JSON.stringify(followed.body)).toBeLessThan(300);

    await page.goto('/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await expect(page.getByText(/Peer followed you/)).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'notifications (inbox)');

    // The nav badge reflects the unread count seen elsewhere in the app.
    await expect(page.getByTestId('inbox-badge').first()).toBeVisible();

    await page.getByRole('button', { name: 'Unread' }).click();
    await expect(page.getByText(/Peer followed you/)).toBeVisible();
    await page.getByRole('button', { name: 'Mark as read' }).click();
    await expect(page.getByText(/Peer followed you/)).toHaveCount(0);

    // Settings tab: quiet hours, focus mode and per-category channels, all saved through the real API.
    await page.getByRole('tab', { name: 'Notification settings' }).click();
    await expect(page.getByRole('switch', { name: 'Turn on focus mode' })).toBeVisible();
    await page.getByRole('switch', { name: 'Turn on focus mode' }).check();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Notification settings' }).click();
    await expect(page.getByRole('switch', { name: 'Turn on focus mode' })).toBeChecked();
    await expectNoSeriousA11yViolations(page, 'notifications (settings)');

    watch.assertClean();
    await context.close();
    await peer.context.close();
  });
});
