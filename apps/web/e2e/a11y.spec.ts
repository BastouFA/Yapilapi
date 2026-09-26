import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DATA, STATE, type SeedData } from './global-setup';

/**
 * axe-core over the main pages, in every project (desktop/mobile × light/dark).
 * Rules: WCAG 2.0/2.1/2.2 A and AA plus axe best practices (landmarks, heading
 * order, one main, region). A page passes with zero violations.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const data = (): SeedData => JSON.parse(readFileSync(DATA, 'utf8'));

const PUBLIC_PAGES: [string, string][] = [
  ['landing', '/'],
  ['login', '/login'],
  ['signup', '/signup'],
];

const APP_PAGES: [string, (d: SeedData) => string][] = [
  ['home', () => '/home'],
  ['discover', () => '/discover'],
  ['create', () => '/create'],
  ['inbox', () => '/inbox'],
  ['conversation', (d) => `/inbox/${d.conversationId}`],
  ['profile', (d) => `/u/${d.username}`],
  ['community', (d) => `/c/${d.communitySlug}`],
  ['event', (d) => `/events/${d.eventId}`],
  ['place', (d) => `/places/${d.placeId}`],
  ['settings', () => '/settings'],
  ['studio', () => '/studio'],
  ['notifications', () => '/notifications'],
  ['post', (d) => `/p/${d.postId}`],
  ['events', () => '/events'],
  ['assistant', () => '/assistant'],
  ['live', () => '/live'],
];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Skeletons and "loading" states are replaced by content before we audit.
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, { timeout: 15_000 }).catch(() => {});
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
}

async function audit(page: Page, name: string, project: string) {
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    // The Next.js dev overlay is not part of the app.
    .exclude('nextjs-portal')
    .analyze();
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => ({ target: n.target.join(' '), summary: n.failureSummary?.split('\n').slice(0, 3).join(' ') })),
  }));
  const dir = path.join(import.meta.dirname, '.results', project);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify(violations, null, 2));
  const report = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}\n${v.nodes.map((n) => `    ${n.target}`).join('\n')}`).join('\n');
  expect(violations, `${name} has accessibility violations:\n${report}`).toEqual([]);
}

test.describe('public pages', () => {
  for (const [name, url] of PUBLIC_PAGES)
    test(name, async ({ page }, info) => {
      await page.goto(url);
      await audit(page, name, info.project.name);
    });
});

test.describe('signed-in pages', () => {
  test.use({ storageState: STATE });
  for (const [name, url] of APP_PAGES)
    test(name, async ({ page }, info) => {
      await page.goto(url(data()));
      await expect(page.locator('main#main')).toBeVisible();
      await audit(page, name, info.project.name);
    });
});

/**
 * Right-to-left (Arabic, Hebrew, Persian, Urdu): the layout mirrors and nothing
 * pushes the page sideways. An offscreen element placed with a physical
 * `left: -9999px` once made every page scroll to blank space in RTL.
 */
test.describe('right-to-left layout', () => {
  test.use({ storageState: STATE });
  for (const [name, url] of APP_PAGES)
    test(`${name} has no horizontal overflow in RTL`, async ({ page }) => {
      await page.goto(url(data()));
      await expect(page.locator('main#main')).toBeVisible();
      await settle(page);
      const overflow = await page.evaluate(() => {
        document.documentElement.dir = 'rtl';
        return document.documentElement.scrollWidth - document.documentElement.clientWidth;
      });
      expect(overflow, `${name} is ${overflow}px wider than the viewport in RTL`).toBeLessThanOrEqual(1);
    });
});
