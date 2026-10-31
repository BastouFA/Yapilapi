import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_STATE, DATA, STATE, type SeedData } from './global-setup';

/**
 * Every page of the web app opens without breaking: no server error (5xx) for the page or anything it
 * asks the API for, no uncaught script error, and no "Something went wrong" screen. Pages for one
 * thing open with the seeded thing; ones with no seeded thing open with an id that doesn't exist,
 * which must say so instead of failing. Runs on desktop and phone in light (layout, not colours).
 */
const data = (): SeedData => JSON.parse(readFileSync(DATA, 'utf8'));
const MISSING = '00000000-0000-4000-8000-000000000000';

const PUBLIC: string[] = [
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/legal',
  '/legal/cookies',
  '/legal/copyright',
  '/legal/creators',
  '/legal/guidelines',
  '/legal/privacy',
  '/legal/safety',
  '/legal/terms',
];

const SIGNED_IN: ((d: SeedData) => string)[] = [
  () => '/home',
  () => '/discover',
  () => '/search?q=music',
  () => '/create',
  () => '/camera',
  () => '/inbox',
  (d) => `/inbox/${d.conversationId}`,
  (d) => `/inbox/${d.gamesChatId}`,
  () => '/notifications',
  (d) => `/u/${d.username}`,
  (d) => `/u/${d.friendUsername}`,
  (d) => `/p/${d.postId}`,
  () => '/archive',
  () => '/ask',
  () => '/assistant',
  (d) => `/b/${d.businessSlug}`,
  (d) => `/boards/${d.boardId}`,
  (d) => `/c/${d.communitySlug}`,
  (d) => `/c/${d.communitySlug}/manage`,
  () => `/chains/${MISSING}`,
  (d) => `/chapters/${d.chapterId}`,
  () => '/checkout/done',
  () => '/circles',
  () => '/communities',
  () => '/communities/new',
  () => '/developers',
  () => '/drafts',
  () => '/drops',
  (d) => `/drops/${d.dropId}`,
  (d) => `/drops/${d.myDropId}/edit`,
  () => '/drops/new',
  () => '/events',
  (d) => `/events/${d.eventId}`,
  (d) => `/events/${d.hostEventId}/check-in`,
  (d) => `/events/${d.hostEventId}/edit`,
  () => '/events/new',
  () => '/find-friends',
  () => '/invite',
  () => '/join/not-a-real-code',
  () => '/live',
  () => `/live/${MISSING}`,
  () => '/map',
  () => '/market',
  (d) => `/market/${d.listingId}`,
  (d) => `/market/${d.myListingId}/edit`,
  () => '/market/mine',
  () => '/market/new',
  () => '/memories',
  () => `/memories/${MISSING}`,
  () => '/mixes',
  () => `/mixes/${MISSING}`,
  () => `/music/${MISSING}`,
  () => '/oauth/authorize',
  (d) => `/places/${d.placeId}`,
  () => '/plus',
  () => '/questions',
  () => '/radio',
  () => '/real',
  () => '/recaps',
  () => '/recaps/new',
  () => '/reels',
  (d) => `/reels/${d.reelId}/echo`,
  (d) => `/reels/${d.reelId}/echoes`,
  (d) => `/reels/${d.reelId}/remixes`,
  () => `/rooms/${MISSING}`,
  () => `/s/${MISSING}`,
  () => '/saved',
  () => '/settings',
  () => '/settings/account',
  () => '/settings/appearance',
  () => '/settings/data-saver',
  () => '/settings/feed',
  () => '/settings/help',
  () => '/settings/language',
  () => '/settings/notifications',
  () => '/settings/privacy',
  () => '/settings/purchases',
  () => '/settings/safety',
  () => '/settings/security',
  () => '/settings/your-data',
  (d) => `/sounds/${d.soundId}`,
  () => '/squads',
  () => `/squads/${MISSING}`,
  () => '/stash',
  () => `/stash/${MISSING}`,
  () => '/stash/new',
  () => '/studio',
  () => '/t/music',
  () => '/tickets',
  () => '/together',
  (d) => `/together/${d.togetherId}`,
  () => '/together/join/not-a-real-code',
  () => '/together/new',
  () => `/watch/${MISSING}`,
  () => '/wraps',
  (d) => (d.wrapId ? `/wraps/${d.wrapId}` : `/wraps/${MISSING}`),
  () => '/yap',
  () => `/yap/${MISSING}`,
  () => '/onboarding',
];

const ADMIN: ((d: SeedData) => string)[] = [() => '/admin', (d) => `/admin/users/${d.friendId}`];

/** Open a page and collect everything that went wrong while it loaded and settled. */
async function visit(page: Page, url: string) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`script error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${r.status()} from ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  const res = await page.goto(url);
  if (res && res.status() >= 500) problems.push(`page answered ${res.status()}`);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  if (await page.getByText('Something went wrong. Try again.').count()) problems.push('shows "Something went wrong"');
  if (await page.getByText(/Application error|Unhandled Runtime Error/).count()) problems.push('shows a crash screen');
  return problems;
}

test.describe('every page opens', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('-dark'), 'layout is the same in dark'));

  for (const url of PUBLIC)
    test(`signed out: ${url}`, async ({ page }) => {
      expect(await visit(page, url), url).toEqual([]);
    });

  test.describe('signed in', () => {
    test.use({ storageState: STATE });
    for (const [i, route] of SIGNED_IN.entries())
      test(`signed in #${i + 1}`, async ({ page }) => {
        const url = route(data());
        expect(await visit(page, url), url).toEqual([]);
      });
  });

  test.describe('admin', () => {
    test.use({ storageState: ADMIN_STATE });
    for (const [i, route] of ADMIN.entries())
      test(`admin #${i + 1}`, async ({ page }) => {
        test.skip(!data().adminReady, 'no admin in this database');
        const url = route(data());
        expect(await visit(page, url), url).toEqual([]);
      });
  });
});
