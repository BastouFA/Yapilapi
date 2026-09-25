import { expect, test } from '@playwright/test';
import {
  PASSWORD,
  expectNoSeriousA11yViolations,
  loginViaUi,
  registerViaApi,
  totp,
  watchPage,
} from '../support/helpers';

test.describe('settings', () => {
  test('edit profile and see it on the public profile', async ({ page }) => {
    const u = await registerViaApi(page.request, { prefix: 'prof', displayName: 'Before Name' });
    await page.goto('/settings');
    await expect(page).toHaveURL('/settings/profile');
    await expectNoSeriousA11yViolations(page, 'settings profile');
    await page.getByLabel(/^Display name/).fill('After Name');
    await page.getByLabel('Bio').fill('I bake sourdough and write code.');
    await page.getByLabel('Where you are (optional)').fill('Lagos');
    await page.getByRole('button', { name: 'Add a link' }).click();
    await page.getByLabel('Link 1 label').fill('Blog');
    await page.getByLabel('Link 1 address').fill('not a url');
    await page.getByTestId('profile-save').click();
    await expect(page.getByText('Enter a full web address')).toBeVisible();
    await page.getByLabel('Link 1 address').fill('https://example.com/blog');
    await page.getByTestId('profile-save').click();
    await expect(page.getByText('Profile saved.')).toBeVisible();
    await page.goto(`/u/${u.username}`);
    await expect(page.getByRole('heading', { level: 1, name: 'After Name' })).toBeVisible();
    await expect(page.getByText('I bake sourdough and write code.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Blog' })).toHaveAttribute(
      'href',
      'https://example.com/blog',
    );
    await expect(page.getByRole('link', { name: 'Blog' })).toHaveAttribute('rel', /noopener/);
    await expectNoSeriousA11yViolations(page, 'own profile');
  });

  test('display: language, theme, contrast and save-data apply immediately and persist', async ({
    page,
  }) => {
    const watch = watchPage(page);
    await registerViaApi(page.request, { prefix: 'disp' });
    await page.goto('/settings/display');
    await expectNoSeriousA11yViolations(page, 'settings display');

    await page.getByTestId('display-language').selectOption('fr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Affichage et langue' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Accueil' }).first()).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expectNoSeriousA11yViolations(page, 'settings display (fr)');

    await page.getByTestId('display-language').selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expectNoSeriousA11yViolations(page, 'settings display (ar, rtl)');
    await page.getByTestId('display-language').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    await page.getByRole('radio', { name: 'Dark' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectNoSeriousA11yViolations(page, 'settings display (dark)');

    await page.getByTestId('high-contrast').check();
    await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more');
    await expectNoSeriousA11yViolations(page, 'settings display (dark, high contrast)');
    await page.getByTestId('high-contrast').uncheck();

    await page.getByTestId('low-bandwidth').check();
    await expect(page.locator('html')).toHaveAttribute('data-bandwidth', 'low');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-bandwidth', 'low');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('low-bandwidth').uncheck();
    await page.getByRole('radio', { name: 'Match my device' }).check();
    watch.assertClean();
  });

  test('time and focus: daily limit and quiet hours are validated and saved', async ({ page }) => {
    await registerViaApi(page.request, { prefix: 'att' });
    await page.goto('/settings/attention');
    await expectNoSeriousA11yViolations(page, 'settings attention');
    await page.getByRole('switch', { name: 'Remind me when I reach a daily limit' }).check();
    await page.getByTestId('daily-limit').fill('2');
    await page.getByTestId('attention-save').click();
    await expect(page.getByText('Enter a whole number between 5 and 1,440.')).toBeVisible();
    await page.getByTestId('daily-limit').fill('45');
    await page.getByRole('switch', { name: 'Use quiet hours' }).check();
    await page.getByTestId('attention-save').click();
    await expect(page.getByText('Saved').first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('daily-limit')).toHaveValue('45');
    await page.getByRole('switch', { name: 'Focus mode' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-focus', '');
  });

  test('privacy: default audience and private account persist', async ({ page }) => {
    await registerViaApi(page.request, { prefix: 'privset' });
    await page.goto('/settings/privacy');
    // Controls are disabled (and dimmed, which is exempt from contrast rules) until the account's settings have loaded.
    await expect(page.getByRole('switch', { name: 'Private account' })).toBeEnabled();
    await expectNoSeriousA11yViolations(page, 'settings privacy');
    await page
      .getByRole('group', { name: /Who sees new posts/ })
      .getByText('Friends', { exact: true })
      .click();
    await page.getByRole('switch', { name: 'Private account' }).check();
    await expect(page.getByText('Saved').first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Private account' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Friends' })).toBeChecked();
    await page.goto('/create');
    await expect(page.getByRole('radio', { name: 'Friends' })).toBeChecked();
  });

  test('security: change password, two-step verification with recovery codes, sessions', async ({
    page,
    browser,
  }) => {
    const watch = watchPage(page);
    const u = await registerViaApi(page.request, { prefix: 'sec' });
    await page.goto('/settings/security');
    await expectNoSeriousA11yViolations(page, 'settings security');

    // Change the password.
    await page.getByTestId('pw-current').fill(PASSWORD);
    await page.getByTestId('pw-new').fill('short');
    await page.getByTestId('pw-save').click();
    await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
    const NEW = 'another long passphrase 99';
    await page.getByTestId('pw-new').fill(NEW);
    await page.getByLabel('Confirm new password').fill(NEW);
    await page.getByTestId('pw-save').click();
    await expect(page.getByText('Password changed.')).toBeVisible();

    // Turn on two-step verification with a real TOTP code computed from the secret the API issued.
    await page.getByTestId('mfa-start').click();
    const dialog = page.getByRole('dialog', { name: 'Set up two-step verification' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'mfa setup dialog');
    await dialog.getByText('Cannot scan the code?').click();
    const secret = (await dialog.getByTestId('mfa-secret').textContent())!.trim();
    await dialog.getByTestId('mfa-code').fill('000000');
    await dialog.getByTestId('mfa-enable').click();
    await expect(
      dialog
        .getByText(/./)
        .filter({ hasText: /invalid|incorrect|wrong|code/i })
        .first(),
    ).toBeVisible();
    await dialog.getByTestId('mfa-code').fill(totp(secret, Date.now() - 30_000));
    await dialog.getByTestId('mfa-enable').click();

    const codesDialog = page.getByRole('dialog', { name: 'Your recovery codes' });
    await expect(codesDialog).toBeVisible();
    const codes = (
      await codesDialog.getByTestId('recovery-codes').locator('code').allTextContents()
    ).map((c) => c.trim());
    expect(codes.length).toBeGreaterThanOrEqual(6);
    await expectNoSeriousA11yViolations(page, 'recovery codes dialog');
    await expect(codesDialog.getByTestId('recovery-done')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(codesDialog).toBeVisible(); // cannot be dismissed before confirming
    await codesDialog.getByTestId('recovery-saved').check();
    await codesDialog.getByTestId('recovery-done').click();
    await expect(page.getByText('On', { exact: true })).toBeVisible();

    // A second browser sees this session listed; sign in there requires the code.
    const ctx2 = await browser.newContext({ locale: 'en-GB', reducedMotion: 'reduce' });
    const p2 = await ctx2.newPage();
    await loginViaUi(p2, { email: u.email, password: NEW });
    await expect(p2.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await expectNoSeriousA11yViolations(p2, 'login mfa step');
    await p2.getByLabel(/^Authentication code/).fill(totp(secret));
    await p2.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(p2).toHaveURL('/');
    await ctx2.close();

    // Recovery code works once.
    const ctx3 = await browser.newContext({ locale: 'en-GB', reducedMotion: 'reduce' });
    const p3 = await ctx3.newPage();
    await loginViaUi(p3, { email: u.email, password: NEW });
    await p3.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await p3.getByLabel(/^Recovery code/).fill(codes[0]!);
    await p3.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(p3).toHaveURL('/');
    await ctx3.close();

    // Sessions: end the other sessions from the first browser.
    await page.reload();
    const rows = page.getByRole('list', { name: 'Where you are signed in' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1);
    await rows
      .filter({ hasNotText: 'This device' })
      .first()
      .getByRole('button', { name: /End the session/ })
      .click();
    await expect(page.getByText('Session ended.')).toBeVisible();
    await expect(rows).toHaveCount(2);

    // Turn it off again.
    await page.getByTestId('mfa-disable').click();
    const off = page.getByRole('dialog', { name: 'Turn off two-step verification?' });
    await off.getByLabel(/^Password/).fill(NEW);
    await off.getByLabel(/^Authentication code/).fill(totp(secret, Date.now() + 30_000));
    await off.getByRole('button', { name: 'Turn off two-step verification' }).click();
    await expect(page.getByText('Two-step verification is off.')).toBeVisible();

    // Sign out everywhere ends this session too.
    await page.getByTestId('logout-all').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page).toHaveURL(/\/login/);
    watch.assertClean();
  });

  test('connections: circles, and using a circle for a post', async ({ page }) => {
    const friend = await registerViaApi(page.request, { prefix: 'circlemate' });
    await page.context().clearCookies();
    const u = await registerViaApi(page.request, { prefix: 'circler' });
    await page.goto('/settings/connections');
    await expectNoSeriousA11yViolations(page, 'settings connections');
    await page.getByTestId('circle-name').fill('Weekend crew');
    await page.getByTestId('circle-create').click();
    await expect(page.getByText('Circle created.')).toBeVisible();
    await page.getByRole('button', { name: 'Manage the circle Weekend crew' }).click();
    const d = page.getByRole('dialog', { name: 'Circle: Weekend crew' });
    await d.getByLabel('Add someone by username').fill(friend.username);
    await d.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(d.getByText(`@${friend.username}`)).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'circle dialog');
    await d.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByText('1 member')).toBeVisible();

    await page.goto('/create');
    await page.getByLabel('What would you like to say?').fill('For the crew only');
    await page
      .getByRole('group', { name: 'Who can see this?' })
      .getByText('Circle', { exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Circle' })
      .selectOption({ label: 'Weekend crew (1)' });
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page).toHaveURL(/\/post\//);
    await expect(page.getByText('For the crew only')).toBeVisible();
    void u;
  });

  test('account: deactivate requires the password', async ({ page }) => {
    const u = await registerViaApi(page.request, { prefix: 'acct' });
    await page.goto('/settings/account');
    await expectNoSeriousA11yViolations(page, 'settings account');
    await page.getByTestId('delete-open').click();
    await page.getByTestId('account-password').fill('not my password');
    await page.getByTestId('account-confirm').click();
    await expect(page.getByRole('dialog').locator('.form-error')).toBeVisible();
    await page.getByTestId('account-password').fill(u.password);
    await page.getByTestId('account-confirm').click();
    await expect(page.getByText(/scheduled for deletion/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Keep my account' }).first().click();
    await expect(page.getByText('Deletion cancelled. Welcome back.')).toBeVisible();
  });
});
