import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DATA, STATE, type SeedData } from './global-setup';

/**
 * Keyboard-only use of the shell and the overlay components: the skip link and
 * primary navigation, the post options menu, a bottom sheet and a dialog
 * (focus moves in, Tab stays in, Escape closes, focus returns to the opener).
 * Open overlays are also run through axe, since the page audit only sees them closed.
 */
test.use({ storageState: STATE });
// Themes don't change keyboard behaviour; run once per layout.
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const focused = (page: Page) => page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? '');
const focusInside = (page: Page, selector: string) => page.evaluate((s) => !!document.querySelector(s)?.contains(document.activeElement), selector);

async function auditOpen(page: Page, selector: string) {
  // Let open animations finish, or contrast is measured mid-fade.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  const r = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function tabStaysInside(page: Page, selector: string, presses = 12) {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    expect(await focusInside(page, selector), `focus left ${selector}: ${await focused(page)}`).toBe(true);
  }
}

test('skip link and primary navigation', async ({ page, isMobile }) => {
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect(await focusInside(page, 'main#main'), `after the skip link, Tab should land in main: ${await focused(page)}`).toBe(true);

  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  // Every destination is a real link, reachable with Tab in visual order.
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
  // On phones the wordmark is hidden and the bar sits at the bottom, but it still comes first in tab order.
  // Search sits under the wordmark on wide screens; phones have it in the page header instead.
  const expected = ['Skip to content', ...(isMobile ? [] : ['YAPILAPI', 'Search']), 'Home', 'Discover', 'Create', 'Inbox', 'Profile'];
  const order: string[] = [];
  for (const _ of expected) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim().split('\n')[0] ?? ''));
  }
  expect(order).toEqual(expected);
});

test('post options menu', async ({ page }) => {
  await page.goto('/home');
  const trigger = page.getByRole('button', { name: 'Post options' }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await auditOpen(page, '.yp-menu__list');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  // ArrowUp opens it on the last item.
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
});

test('bottom sheet (comments)', async ({ page }) => {
  await page.goto('/home');
  const opener = page.getByRole('button', { name: /^Comments/ }).first();
  await opener.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  expect(await focusInside(page, '[role="dialog"]')).toBe(true);
  await auditOpen(page, '[role="dialog"]');
  await tabStaysInside(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
});

test('dialog (delete account) and tabs', async ({ page }) => {
  await page.goto('/settings');
  const tabs = page.getByRole('tab');
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Attention' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Attention' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Safety' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Privacy' }).click();
  await expect(page.getByRole('tabpanel')).toBeVisible();

  const opener = page.getByRole('button', { name: 'Delete my account' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  await expect(dialog).toBeVisible();
  expect(await focusInside(page, '[role="dialog"]')).toBe(true);
  await auditOpen(page, '[role="dialog"]');
  await tabStaysInside(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('checkout sheet', async ({ page }) => {
  const { businessSlug } = JSON.parse(readFileSync(DATA, 'utf8')) as SeedData;
  await page.goto(`/b/${businessSlug}`);
  await page.waitForLoadState('networkidle');
  const buy = page.getByRole('button', { name: 'Buy', exact: true }).first();
  await buy.click();
  const sheet = page.getByRole('dialog', { name: 'Checkout' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Pay (test)' })).toBeVisible();
  expect(await focusInside(page, '[role="dialog"]'), `focus should move into checkout: ${await focused(page)}`).toBe(true);
  await tabStaysInside(page, '[role="dialog"]', 6);
  await auditOpen(page, '[role="dialog"]');
  await sheet.getByRole('button', { name: 'Pay (test)' }).click();
  await expect(sheet.getByText('Paid')).toBeVisible({ timeout: 15_000 });
  await auditOpen(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('story viewer', async ({ page }) => {
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
  // The projects share one seeded account, so the story may already be seen by an earlier project.
  const opener = page.getByRole('button', { name: /Ben Keyboard, 1 story/ });
  await opener.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog', { name: /Ben Keyboard's story/ });
  await expect(viewer).toBeVisible();
  expect(await focusInside(page, '.story'), `focus should move into the story: ${await focused(page)}`).toBe(true);
  // Space pauses, so the story doesn't move on while it's audited.
  await page.keyboard.press('Space');
  await expect(viewer.getByRole('button', { name: 'Play' })).toBeVisible();
  await auditOpen(page, '.story');
  await tabStaysInside(page, '.story', 6);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  // Once seen, the ring says so.
  await expect(page.getByRole('button', { name: /Ben Keyboard, 1 story, seen/ })).toBeVisible();
});
