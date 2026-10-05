import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, liveRoom, STATE, watchSession, type SeedData } from './global-setup';

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
  await expect(nav.getByRole('link', { name: 'Pulse', exact: true })).toHaveAttribute('aria-current', 'page');
  // Every destination is a real link, reachable with Tab in visual order.
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
  // On phones the wordmark is hidden and the bar sits at the bottom, but it still comes first in tab order.
  // Search sits under the wordmark on wide screens; phones have it in the page header instead.
  const expected = ['Skip to content', ...(isMobile ? [] : ['YAPILAPI', 'Search']), 'Pulse', 'Wander', 'Spark', 'Yap', 'You'];
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

test('settings search and dialog (delete account)', async ({ page }) => {
  await page.goto('/settings');
  // The search box finds a setting inside a section and opens that section at it.
  const search = page.getByRole('searchbox', { name: 'Search settings' });
  await search.focus();
  await page.keyboard.type('delete');
  const result = page.getByRole('link', { name: /Delete my account/ });
  await expect(result).toBeVisible();
  await result.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings\/your-data#delete$/);

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

const seed = () => JSON.parse(readFileSync(DATA, 'utf8')) as SeedData;
const isFocused = (loc: import('@playwright/test').Locator) => () => loc.evaluate((el) => el === document.activeElement).catch(() => false);

/** Press `key` (at most `max` times) until `done` says focus is where we want it. */
async function tabUntil(page: Page, done: () => Promise<boolean>, max = 80, key = 'Tab') {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    await page.keyboard.press(key);
  }
  expect(await done(), `never reached the target with ${key}; focus is on ${await focused(page)}`).toBe(true);
}

test('chat: reply to a message with the keyboard only', async ({ page }) => {
  const { conversationId, replyTargetId } = seed();
  await page.goto(`/inbox/${conversationId}`);
  await page.waitForLoadState('networkidle');
  // From the top of the page, Tab to the options of Ben's message.
  const options = page.locator(`#msg-${replyTargetId}`).getByRole('button', { name: 'Message options' });
  await expect(options).toBeAttached();
  await tabUntil(page, isFocused(options), 150);
  await expect(options).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  // Focus is in the message box, which says what it replies to.
  const box = page.getByRole('textbox', { name: /message/i });
  await expect(box).toBeFocused();
  await expect(box).toHaveAccessibleDescription(/Replying to Ben Keyboard/);
  // Escape cancels the reply and keeps focus in the box; then back to the message and start again.
  await page.keyboard.press('Escape');
  await expect(page.getByText(/^Replying to/)).toBeHidden();
  await expect(box).toBeFocused();
  await tabUntil(page, isFocused(options), 150, 'Shift+Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(box).toBeFocused();
  const text = `See you at 7 (${Date.now().toString(36)})`;
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  const sent = page.locator('.chat-msg--mine', { hasText: text });
  await expect(sent.getByRole('button', { name: /Go to the message from Ben Keyboard: Great\. It starts at 7/ })).toBeVisible();
  await expect(sent.getByRole('button', { name: 'Message options' })).toBeAttached();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('');
});

test('chat: reaction picker and search return focus', async ({ page }) => {
  const { conversationId, replyTargetId } = seed();
  await page.goto(`/inbox/${conversationId}`);
  await page.waitForLoadState('networkidle');
  const options = page.locator(`#msg-${replyTargetId}`).getByRole('button', { name: 'Message options' });
  await options.focus();
  await page.keyboard.press('Enter');
  await tabUntil(page, isFocused(page.getByRole('menuitem', { name: 'React', exact: true })), 10, 'ArrowDown');
  await page.keyboard.press('Enter');
  const picker = page.getByRole('group', { name: 'React' });
  await expect(picker.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(picker.getByRole('button').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(options).toBeFocused();

  // Search: from the chat's menu, focus goes into the box; Escape closes it and focus returns.
  const chatMenu = page.getByRole('button', { name: 'Conversation options' });
  await chatMenu.focus();
  await page.keyboard.press('Enter');
  await tabUntil(page, isFocused(page.getByRole('menuitem', { name: 'Search this chat' })), 12, 'ArrowDown');
  await page.keyboard.press('Enter');
  const search = page.getByRole('searchbox', { name: 'Search this chat' });
  await expect(search).toBeFocused();
  await page.keyboard.type('soup');
  await expect(page.getByRole('status').filter({ hasText: /found/ })).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(chatMenu).toBeFocused();
});

test('profile: open and close the status sheet', async ({ page }) => {
  const { username } = seed();
  await page.goto(`/u/${username}`);
  await page.waitForLoadState('networkidle');
  const opener = page.getByRole('button', { name: /^(Edit status|Set a status)$/ });
  await opener.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Your status' });
  await expect(sheet).toBeVisible();
  expect(await focusInside(page, '[role="dialog"]'), `focus should move into the sheet: ${await focused(page)}`).toBe(true);
  await tabStaysInside(page, '[role="dialog"]');
  // The page behind can't be reached or clicked while it's open.
  expect(await page.getByRole('navigation', { name: 'Primary', includeHidden: true }).evaluate((el) => !!el.closest('[inert]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await page.getByRole('navigation', { name: 'Primary' }).evaluate((el) => !!el.closest('[inert]'))).toBe(false);

  // Again, and save a new status with the keyboard.
  await page.keyboard.press('Enter');
  await expect(sheet).toBeVisible();
  const field = sheet.getByRole('textbox', { name: "What's happening" });
  await tabUntil(page, isFocused(field), 10);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Reading on the train');
  await tabUntil(page, isFocused(sheet.getByRole('button', { name: 'Save' })), 30);
  await page.keyboard.press('Enter');
  await expect(sheet).toBeHidden();
  // The toast is announced by a live region that was already on the page.
  await expect(page.getByRole('status').filter({ hasText: 'Status set for 24 hours' })).toBeAttached();
  await expect(page.locator('.now-status').getByText('Reading on the train')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit status' })).toBeFocused();
});

test('camera: mode tabs with arrow keys', async ({ page }) => {
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
  await page.goto('/camera');
  const camera = page.getByRole('dialog', { name: 'Camera' });
  await expect(camera).toBeVisible();
  await expect.poll(() => focusInside(page, '.cam'), { message: 'focus should move into the camera' }).toBe(true);
  const tab = (name: string) => camera.getByRole('tab', { name });
  await expect(camera.getByRole('tab')).toHaveCount(3);
  // One tab stop for the tabs: the selected one.
  expect(await camera.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
  await tabUntil(page, () => page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab'), 20);
  await expect(tab('Post')).toBeFocused();
  await expect(tab('Post')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tab('Reel')).toBeFocused();
  await expect(tab('Reel')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Post')).toHaveAttribute('aria-selected', 'false');
  await expect(tab('Post')).toHaveAttribute('tabindex', '-1');
  await expect(camera.getByRole('button', { name: 'Start recording' })).toBeAttached();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Story')).toBeFocused();
  // Arrows wrap around on the tabs.
  await page.keyboard.press('ArrowRight');
  await expect(tab('Post')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tab('Story')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab('Post')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Post')).toBeFocused();
  await page.keyboard.press('End');
  await expect(tab('Story')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Story')).toBeFocused();
  // Tab stays in the camera; Escape closes it.
  await tabStaysInside(page, '.cam', 8);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/home$/);
});

test('room: join and raise a hand', async ({ page }, info) => {
  const id = await liveRoom(info.project.use.baseURL!);
  await page.goto(`/rooms/${id}`);
  await page.waitForLoadState('networkidle');
  const join = page.getByRole('button', { name: 'Join as a listener' });
  await tabUntil(page, isFocused(join), 60);
  await page.keyboard.press('Enter');
  // Joining replaces the button; focus goes to the room's title.
  await expect(page.getByRole('heading', { level: 1, name: 'Sunday night radio' })).toBeFocused();
  const hand = page.getByRole('button', { name: 'Raise hand' });
  await tabUntil(page, isFocused(hand), 40);
  await expect(hand).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Space');
  // A toggle: the name stays, the pressed state changes, focus stays on it.
  await expect(hand).toHaveAttribute('aria-pressed', 'true');
  await expect(hand).toBeFocused();
  await expect(page.getByRole('listitem').filter({ hasText: 'Ada Access (you)' }).getByRole('img', { name: 'Hand raised' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(hand).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(hand).toHaveAttribute('aria-pressed', 'true');
  await auditOpen(page, 'main');
  // Leave, so the room isn't left with a listener.
  await page.getByRole('button', { name: 'Leave quietly' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/c\//);
});

test('reels: keys, toggles, the scrubber and the options sheet', async ({ page }) => {
  const d = seed();
  await page.goto(`/reels?start=${d.reel2Id}`);
  const reel = page.locator('.reel--active');
  const slider = reel.getByRole('slider', { name: 'Position in the reel' });
  await expect(slider).toBeVisible();
  // The reel's length is known once its video has loaded.
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuemax')), { timeout: 15_000 }).toBeGreaterThan(0);

  // M and C switch sound and clear view; both are toggles with aria-pressed.
  const sound = reel.getByRole('button', { name: 'Sound', exact: true });
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('m');
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('m');
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  const clear = reel.getByRole('button', { name: 'Clear view', exact: true });
  await page.keyboard.press('c');
  await expect(clear).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('c');
  await expect(clear).toHaveAttribute('aria-pressed', 'false');

  // Space plays or pauses (the play button's name follows).
  const play = reel.locator('.reel__play');
  const before = await play.getAttribute('aria-label');
  await page.keyboard.press(' ');
  await expect(play).not.toHaveAttribute('aria-label', before!);

  // The scrubber is a slider: Home to the start, arrows a second at a time.
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '2');
  await expect(slider).toHaveAttribute('aria-valuetext', /^0:02 of 0:0\d$/);

  // The options sheet: focus moves in, Tab stays in, Escape closes it and returns focus.
  const options = reel.getByRole('button', { name: 'Reel options' });
  await options.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Reel options' });
  await expect(sheet).toBeVisible();
  expect(await focusInside(page, '[role="dialog"]')).toBe(true);
  await auditOpen(page, '[role="dialog"]');
  await tabStaysInside(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(options).toBeFocused();

  // J moves to another reel, and the address follows it.
  await page.keyboard.press('j');
  await expect(page).not.toHaveURL(new RegExp(d.reel2Id));
  await expect(page).toHaveURL(/\/reels\?start=/);
  await page.keyboard.press('k');
  await expect(page).toHaveURL(new RegExp(d.reel2Id));
});

/** Open a sheet with the keyboard, check focus moved in and stays in, close it with Escape and check where focus went back to. */
async function sheetRoundTrip(page: Page, name: string, returnsTo: import('@playwright/test').Locator) {
  const sheet = page.getByRole('dialog', { name });
  await expect(sheet).toBeVisible();
  await expect.poll(() => focusInside(page, '[role="dialog"]'), { message: `focus should move into ${name}` }).toBe(true);
  await auditOpen(page, '[role="dialog"]');
  await tabStaysInside(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(returnsTo).toBeFocused();
}

test('chat: start a game, send later and wallpaper sheets', async ({ page }) => {
  const { gamesChatId } = seed();
  await page.goto(`/inbox/${gamesChatId}`);
  await page.waitForLoadState('networkidle');

  // Start a game: from the composer's menu.
  const add = page.getByRole('button', { name: 'Add to this chat' });
  await add.focus();
  await page.keyboard.press('Enter');
  await tabUntil(page, isFocused(page.getByRole('menuitem', { name: 'Play a game' })), 8, 'ArrowDown');
  await page.keyboard.press('Enter');
  await sheetRoundTrip(page, 'Start a game', add);

  // Send later: write, then Tab to the button (nothing is scheduled: Escape closes it).
  const box = page.getByRole('textbox', { name: /message/i });
  await box.focus();
  await page.keyboard.type('See you at the market');
  const later = page.getByRole('button', { name: 'Send later' });
  await tabUntil(page, isFocused(later), 10);
  await page.keyboard.press('Enter');
  await sheetRoundTrip(page, 'Send later', later);

  // Wallpaper and colour: from the chat's menu.
  const chatMenu = page.getByRole('button', { name: 'Conversation options' });
  await chatMenu.focus();
  await page.keyboard.press('Enter');
  await tabUntil(page, isFocused(page.getByRole('menuitem', { name: 'Wallpaper and colour' })), 14, 'ArrowDown');
  await page.keyboard.press('Enter');
  await sheetRoundTrip(page, 'Wallpaper and colour', chatMenu);
});

test('chat: the chess board with the keyboard', async ({ page }) => {
  const { gamesChatId } = seed();
  await page.goto(`/inbox/${gamesChatId}`);
  await page.waitForLoadState('networkidle');
  const opener = page.getByRole('button', { name: 'Your turn: Chess' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Chess' });
  await expect(sheet).toBeVisible();
  await auditOpen(page, '[role="dialog"]');

  // One square in the tab order, starting on your king.
  const board = sheet.getByRole('grid', { name: /Chess/ });
  await expect(board.locator('button[tabindex="0"]')).toHaveCount(1);
  const square = (name: RegExp) => board.getByRole('button', { name });
  await tabUntil(page, isFocused(square(/^e1, white king/)), 30);
  // Arrow keys move around the grid.
  await page.keyboard.press('ArrowUp');
  await expect(square(/^e2, white pawn/)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(square(/^f2, white pawn/)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  // Enter picks the pawn up and shows where it can go.
  await page.keyboard.press('Enter');
  await expect(square(/^e2, white pawn, picked up/)).toBeFocused();
  await expect(square(/^e3, empty, move here/)).toBeAttached();
  await expect(square(/^e4, empty, move here/)).toBeAttached();
  await page.keyboard.press('ArrowUp');
  await expect(square(/^e3, empty, move here/)).toBeFocused();
  // Escape puts it back and keeps the board open (no move is made: the projects share this game).
  await page.keyboard.press('Escape');
  await expect(sheet).toBeVisible();
  await expect(square(/^e3, empty$/)).toBeFocused();
  await expect(board.getByRole('button', { name: /picked up/ })).toHaveCount(0);
  // Tab leaves the board for the rest of the sheet, and stays in the sheet.
  await tabStaysInside(page, '[role="dialog"]', 6);
  // A second Escape closes the sheet and returns focus.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
});

test('post: why am I seeing this, from the post menu', async ({ page }) => {
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
  const options = page.getByRole('button', { name: 'Post options' }).first();
  await options.focus();
  await page.keyboard.press('Enter');
  await tabUntil(page, isFocused(page.getByRole('menuitem', { name: 'Why am I seeing this?' })), 14, 'ArrowDown');
  await page.keyboard.press('Enter');
  await sheetRoundTrip(page, 'Why am I seeing this?', options);
});

test('market: the offer sheet', async ({ page }) => {
  const { listingId } = seed();
  await page.goto(`/market/${listingId}`);
  await page.waitForLoadState('networkidle');
  const offer = page.getByRole('button', { name: 'Make an offer' });
  await tabUntil(page, isFocused(offer));
  await page.keyboard.press('Enter');
  await sheetRoundTrip(page, 'Make an offer', offer);
});

test('tickets: give a ticket to a friend', async ({ page }) => {
  await page.goto('/tickets');
  await page.waitForLoadState('networkidle');
  const give = page.getByRole('button', { name: 'Give to a friend' }).first();
  await tabUntil(page, isFocused(give));
  await page.keyboard.press('Enter');
  await sheetRoundTrip(page, 'Give this ticket to a friend', give);
});

test('together: the photo viewer and the people sheet', async ({ page }) => {
  const { togetherId } = seed();
  await page.goto(`/together/${togetherId}`);
  await page.waitForLoadState('networkidle');
  // The viewer: focus moves in and stays in, Escape closes it and focus returns to the photo.
  const tile = page.getByRole('button', { name: /^Photo by/ }).first();
  await tabUntil(page, isFocused(tile));
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog', { name: /^Photos and videos in/ });
  await expect(viewer).toBeVisible();
  await expect.poll(() => focusInside(page, '[role="dialog"]'), { message: 'focus should move into the viewer' }).toBe(true);
  await auditOpen(page, '[role="dialog"]');
  await tabStaysInside(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(tile).toBeFocused();

  // The people sheet, from the line under the title.
  const people = page.getByRole('button', { name: /people/ }).first();
  await people.focus();
  await page.keyboard.press('Enter');
  await sheetRoundTrip(page, 'People', people);
});

test('together: the slideshow fits each photo on the screen, and a failed upload stays to try again', async ({ page }) => {
  const { togetherId } = seed();
  await page.goto(`/together/${togetherId}`);
  await page.waitForLoadState('networkidle');

  // A tall photo used to grow its slide past the bottom of a wide screen and get cut off.
  await page.getByRole('button', { name: 'Slideshow' }).click();
  const show = page.getByRole('dialog', { name: /^Slideshow/ });
  await expect(show).toBeVisible();
  for (let i = 0; i < 3; i++) {
    const shown = show.locator('.tg-show__slide--on img');
    await expect(shown).toBeVisible();
    const box = (await shown.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.height, 'the photo fits the screen').toBeLessThanOrEqual(view.height + 1);
    expect(box.width, 'the photo fits the screen').toBeLessThanOrEqual(view.width + 1);
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Escape');
  await expect(show).toBeHidden();

  // The first upload fails: the sheet stays open with that file marked and Try again, instead of closing.
  let failed = false;
  await page.route('**/api/v1/uploads', (route) => {
    if (failed || route.request().method() !== 'POST') return route.continue();
    failed = true;
    return route.abort();
  });
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles(join(import.meta.dirname, 'fixtures', 'bread.jpg'));
  const sheet = page.getByRole('dialog', { name: /^Add to/ });
  await sheet.getByRole('button', { name: /^Add 1/ }).click();
  await expect(sheet.getByText("This one couldn't be added.")).toBeVisible();
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet).toBeHidden();
});

test('chat: the call screen keeps focus, and Escape does not hang up', async ({ page }) => {
  const d = seed();
  // A silent tone stands in for the microphone.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      const out = audio.createMediaStreamDestination();
      audio.createOscillator().connect(out);
      return out.stream;
    };
  });
  // A new group each time: a chat has one call at a time.
  const group = await page.request.post('/api/v1/conversations', { data: { memberIds: [d.friendId, d.thirdId], title: 'Call crew' } });
  expect(group.ok(), await group.text()).toBe(true);
  const { conversation } = await group.json();
  await page.goto(`/inbox/${conversation.id}`);
  await page.waitForLoadState('networkidle');
  const start = page.getByRole('button', { name: 'Audio call' });
  await start.focus();
  await page.keyboard.press('Enter');
  const call = page.getByRole('dialog', { name: 'Call' });
  await expect(call).toBeVisible();
  await expect.poll(() => focusInside(page, '.call'), { message: 'focus should move into the call screen' }).toBe(true);
  await tabStaysInside(page, '.call', 6);
  // By design, Escape doesn't end a call.
  await page.keyboard.press('Escape');
  await expect(call).toBeVisible();
  await tabUntil(page, isFocused(call.getByRole('button', { name: 'Hang up' })), 6);
  await page.keyboard.press('Enter');
  await expect(call).toBeHidden();
  await expect(start).toBeFocused();
});

test('watch together: arrow keys on the position move everyone once, 5 seconds a press', async ({ page }, info) => {
  const id = await watchSession(info.project.use.baseURL!);
  const seeks: { positionMs: number }[] = [];
  page.on('request', (r) => {
    const body = r.url().includes(`/watch/${id}/control`) ? r.postDataJSON() : null;
    if (body?.action === 'seek') seeks.push(body);
  });
  await page.goto(`/watch/${id}`);
  const join = page.getByRole('button', { name: 'Press play to join in' });
  if (await join.isVisible()) await join.click();
  const slider = page.getByRole('slider', { name: 'Position in the video' });
  await expect(slider).toBeEnabled({ timeout: 15_000 });
  await slider.focus();
  // Home, then two presses: one seek, to 10 seconds or the end of the video, whichever comes first.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => seeks.length).toBe(1);
  expect(seeks[0]!.positionMs).toBe(Math.min(10_000, Number(await slider.getAttribute('max'))));
});

test('chat: group info with the keyboard (rename, the people, Escape)', async ({ page }) => {
  const d = seed();
  const group = await page.request.post('/api/v1/conversations', { data: { memberIds: [d.friendId, d.thirdId], title: 'Supper club' } });
  expect(group.ok(), await group.text()).toBe(true);
  const { conversation } = await group.json();
  await page.goto(`/inbox/${conversation.id}`);
  await page.waitForLoadState('networkidle');
  const chatMenu = page.getByRole('button', { name: 'Conversation options' });
  await chatMenu.focus();
  await page.keyboard.press('Enter');
  await tabUntil(page, isFocused(page.getByRole('menuitem', { name: 'Group info' })), 12, 'ArrowDown');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Group info' });
  await expect(sheet).toBeVisible();
  await expect.poll(() => focusInside(page, '[role="dialog"]')).toBe(true);
  await auditOpen(page, '[role="dialog"]');
  // Rename: the line goes in the chat and the header follows.
  const name = sheet.getByRole('textbox', { name: 'Group name' });
  await name.fill('Supper club, Thursdays');
  await name.press('Enter');
  await expect(page.getByText('You renamed the group to Supper club, Thursdays.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Supper club, Thursdays');
  // An admin has options for each other person.
  await expect(sheet.getByRole('button', { name: /^Options for / })).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(chatMenu).toBeFocused();
});
