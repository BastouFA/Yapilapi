import { expect, test } from '@playwright/test';
import {
  PASSWORD,
  birthDateFor,
  expectNoSeriousA11yViolations,
  linkFromEmailLog,
  loginViaUi,
  registerViaApi,
  watchPage,
} from '../support/helpers';

test.describe('sign-up wizard', () => {
  test('under-13 is blocked and the block sticks', async ({ page }) => {
    const watch = watchPage(page);
    await page.goto('/signup');
    await page.getByLabel('Email address').fill('kid@example.test');
    await page.getByLabel(/^Password(\s\(required\))?$/).fill(PASSWORD);
    await page.getByLabel('I agree to the terms of service and privacy policy.').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Date of birth').fill(birthDateFor(11));
    await expect(page.getByRole('alert').first()).toContainText('at least 13');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('age-blocked')).toBeVisible();
    await page.reload();
    await page.getByLabel('Email address').fill('kid@example.test');
    await page.getByLabel(/^Password(\s\(required\))?$/).fill(PASSWORD);
    await page.getByLabel('I agree to the terms of service and privacy policy.').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('age-blocked')).toBeVisible();
    watch.assertClean();
  });

  test('adult signs up end to end, then verifies their email', async ({ page, request }) => {
    const watch = watchPage(page);
    const friend = await registerViaApi(request, { prefix: 'friend', displayName: 'Ada Friend' });
    await request.post('/v1/auth/logout').catch(() => undefined);
    await page.context().clearCookies();

    const id = Math.random().toString(16).slice(2, 8);
    const email = `new_${id}@example.test`;
    const username = `new_${id}`;

    await page.goto('/signup');
    await expectNoSeriousA11yViolations(page, 'signup step 1');
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel(/^Password(\s\(required\))?$/).fill(PASSWORD);
    // Terms are required.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('You need to agree to continue.')).toBeVisible();
    await page.getByLabel('I agree to the terms of service and privacy policy.').check();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Your date of birth' })).toBeFocused();
    await page.getByLabel('Date of birth').fill(birthDateFor(15));
    await expect(page.getByTestId('teen-note')).toContainText('Your posts cannot be public');
    await page.getByLabel('Date of birth').fill(birthDateFor(28));
    await expect(page.getByTestId('teen-note')).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'signup step 2');
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByLabel('Display name').fill('New Person');
    await page.getByLabel(/^Username/).fill(friend.username);
    await expect(page.getByText('That username is taken')).toBeVisible();
    await page.getByLabel(/^Username/).fill(username);
    await expect(page.getByTestId('username-status')).toContainText(`@${username} is available`);
    await expectNoSeriousA11yViolations(page, 'signup step 3');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('heading', { name: 'Pick your interests' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'signup interests');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Find people to follow' })).toBeVisible();
    await page.getByLabel(/^Username/).fill(friend.username);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByTestId('person-result')).toContainText('Ada Friend');
    await page.getByTestId('person-result').getByRole('button').click();
    await expect(page.getByRole('heading', { name: /Following 1 person/ })).toBeVisible();
    await page.getByTestId('signup-finish').click();

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(page.getByText(`Please verify ${email}`)).toBeVisible();

    // Email verification through the link the API "sent" (console adapter).
    const link = await linkFromEmailLog(email, '/verify-email');
    await page.goto(link);
    await expect(page.getByText('Your email address is verified')).toBeVisible();
    await page.getByRole('link', { name: 'Continue to YAPILAPI' }).click();
    await expect(page.getByText(`Please verify ${email}`)).toHaveCount(0);
    watch.assertClean();
  });
});

test.describe('sign-in and the auth guard', () => {
  test('anonymous visitors are sent to sign-in and come back after', async ({ page, request }) => {
    const watch = watchPage(page);
    const u = await registerViaApi(request, { prefix: 'guard' });
    await page.context().clearCookies();

    await page.goto('/settings/privacy');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fprivacy/);
    await expectNoSeriousA11yViolations(page, 'login');

    await page.getByLabel('Email address').fill(u.email);
    await page.getByLabel(/^Password(\s\(required\))?$/).fill('wrong password wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.form-error')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel(/^Password(\s\(required\))?$/).fill(u.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('/settings/privacy');
    await expect(page.getByRole('heading', { level: 2, name: 'Privacy' })).toBeVisible();

    // No token in web storage: the session is an httpOnly cookie only.
    const stored = await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }) +
        document.cookie,
    );
    expect(stored).not.toMatch(/yl_session/);

    await page.getByTestId('account-menu').first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    watch.assertClean();
  });

  test('forgot and reset password', async ({ page, request }) => {
    const u = await registerViaApi(request, { prefix: 'reset' });
    await page.context().clearCookies();
    await page.goto('/forgot-password');
    await expectNoSeriousA11yViolations(page, 'forgot password');
    await page.getByLabel('Email address').fill(u.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account exists for that address')).toBeVisible();

    const link = await linkFromEmailLog(u.email, '/reset-password');
    await page.goto(link);
    await expectNoSeriousA11yViolations(page, 'reset password');
    await page.getByLabel(/^New password/).fill('a brand new long passphrase 7');
    await page.getByLabel('Confirm new password').fill('a brand new long passphrase 7');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByText('Your password has been changed')).toBeVisible();
    await loginViaUi(page, { email: u.email, password: 'a brand new long passphrase 7' });
    await expect(page).toHaveURL('/');
  });
});
