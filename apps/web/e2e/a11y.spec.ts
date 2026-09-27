import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DATA, liveRoom, STATE, type SeedData } from './global-setup';

/**
 * axe-core over the main pages, and over open sheets, menus and other states,
 * in every project (desktop/mobile × light/dark). Rules: WCAG 2.0/2.1/2.2 A and
 * AA plus axe best practices (landmarks, heading order, one main, region). A
 * page or state passes with zero violations.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const data = (): SeedData => JSON.parse(readFileSync(DATA, 'utf8'));
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

const PUBLIC_PAGES: [string, string][] = [
  ['landing', '/'],
  ['login', '/login'],
  ['signup', '/signup'],
  ['forgot password', '/forgot-password'],
];

const APP_PAGES: [string, (d: SeedData) => string][] = [
  ['home', () => '/home'],
  ['discover', () => '/discover'],
  ['create', () => '/create'],
  ['inbox', () => '/inbox'],
  ['conversation', (d) => `/inbox/${d.conversationId}`],
  ['profile', (d) => `/u/${d.username}`],
  ['other profile', (d) => `/u/${d.friendUsername}`],
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
  ['business', (d) => `/b/${d.businessSlug}`],
  ['developers', () => '/developers'],
  ['memories', () => '/memories'],
  ['reels', () => '/reels'],
  ['search', () => '/search'],
  ['search results', () => '/search?q=Keyboard'],
  ['camera', () => '/camera'],
  ['tag', () => '/t/food'],
  ['plus', () => '/plus'],
  ['invite', () => '/invite'],
  ['drafts', () => '/drafts'],
  ['continue a draft', (d) => `/create?draft=${d.draftId}`],
  ['create a story', () => '/create?mode=story'],
  ['create a reel', () => '/create?mode=reel'],
  ['saved', () => '/saved'],
  ['board', (d) => `/boards/${d.boardId}`],
  ['circles', () => '/circles'],
  ['circle', (d) => `/circles?id=${d.circleId}`],
  ['recaps', () => '/recaps'],
  ['recap', (d) => `/recaps?open=${d.recapId}`],
  ['new recap', (d) => `/recaps/new?source=chapter&sourceId=${d.chapterId}`],
  ['chapter', (d) => `/chapters/${d.chapterId}`],
  ['archive', () => '/archive'],
  ['sound', (d) => `/sounds/${d.soundId}`],
];

/** Wait for content, then for finite animations (so contrast isn't measured mid-fade). */
async function settle(page: Page) {
  // Pages with live updates may never go fully quiet; don't wait forever.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('main#main')).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

/** A message's menu (phones have Reply and React only there). */
async function messageAction(page: Page, action: string, which: 'first' | 'last' = 'last') {
  const options = page.getByRole('button', { name: 'Message options' });
  await (which === 'last' ? options.last() : options.first()).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
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
      await open(page, url(data()));
      await audit(page, name, info.project.name);
    });
});

/**
 * Sheets, menus and other states that only show after an action: the page
 * audit only sees them closed. Each opens the state the way a person would,
 * then audits the whole page with it open.
 */
const STATES: [string, (page: Page, d: SeedData) => Promise<void>][] = [
  [
    'profile: status sheet',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('button', { name: 'Edit status' }).click();
      await expect(page.getByRole('dialog', { name: 'Your status' })).toBeVisible();
    },
  ],
  [
    'profile: share sheet',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('button', { name: 'Share profile' }).click();
      await expect(page.getByRole('dialog', { name: 'Share profile' }).getByRole('img', { name: /QR code/ })).toBeVisible();
    },
  ],
  [
    'profile: cover sheet',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('button', { name: 'Change cover' }).click();
      await expect(page.getByRole('dialog', { name: 'Cover photo' })).toBeVisible();
    },
  ],
  [
    'profile: followers',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('button', { name: /followers/i }).click();
      await expect(page.getByRole('dialog').getByRole('link', { name: 'Ben Keyboard' })).toBeVisible();
    },
  ],
  [
    'profile: following',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('button', { name: /following/i }).click();
      await expect(page.getByRole('dialog').getByRole('link', { name: 'Ben Keyboard' })).toBeVisible();
    },
  ],
  [
    'chat: message menu',
    async (page, d) => {
      await open(page, `/inbox/${d.conversationId}`);
      await page.getByRole('button', { name: 'Message options' }).last().click();
      await expect(page.getByRole('menu')).toBeVisible();
    },
  ],
  [
    'chat: replying',
    async (page, d) => {
      await open(page, `/inbox/${d.conversationId}`);
      await messageAction(page, 'Reply');
      await expect(page.getByText(/^Replying to/)).toBeVisible();
    },
  ],
  [
    'chat: editing',
    async (page, d) => {
      await open(page, `/inbox/${d.conversationId}`);
      // Messages can be edited for a few minutes after sending, so send a fresh one.
      await page.getByRole('textbox', { name: /message/i }).fill('Running late, save me a seat');
      await page.keyboard.press('Enter');
      await expect(page.locator('.chat-msg--mine').last().getByRole('button', { name: 'Message options' })).toBeVisible();
      await page.locator('.chat-msg--mine').last().getByRole('button', { name: 'Message options' }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(page.getByText('Editing message')).toBeVisible();
    },
  ],
  [
    'chat: reactions',
    async (page, d) => {
      await open(page, `/inbox/${d.conversationId}`);
      await messageAction(page, 'React');
      await expect(page.getByRole('group', { name: 'React' })).toBeVisible();
    },
  ],
  [
    'chat: search',
    async (page, d) => {
      await open(page, `/inbox/${d.conversationId}`);
      await page.getByRole('button', { name: 'Conversation options' }).click();
      await page.getByRole('menuitem', { name: 'Search this chat' }).click();
      await page.getByRole('searchbox', { name: 'Search this chat' }).fill('soup');
      await expect(page.getByRole('list', { name: 'Search results' })).toBeVisible();
    },
  ],
  [
    'chat: disappearing messages',
    async (page, d) => {
      await open(page, `/inbox/${d.conversationId}`);
      await page.getByRole('button', { name: /^Disappearing messages/ }).click();
      await expect(page.getByRole('dialog', { name: 'Disappearing messages' })).toBeVisible();
    },
  ],
  [
    'story viewer with music and stickers',
    async (page) => {
      await open(page, '/home');
      await page.getByRole('button', { name: /Ben Keyboard, \d+ stor/ }).click();
      const viewer = page.getByRole('dialog', { name: /Ben Keyboard's story/ });
      await expect(viewer).toBeVisible();
      await page.keyboard.press('Space');
      await expect(viewer.getByRole('button', { name: 'Play' })).toBeVisible();
    },
  ],
  [
    'home: save to a board',
    async (page) => {
      await open(page, '/home');
      await page.getByRole('button', { name: 'Post options' }).first().click();
      await page.getByRole('menuitem', { name: 'Save to a board' }).click();
      await expect(page.getByRole('dialog', { name: 'Save to a board' })).toBeVisible();
    },
  ],
  [
    'board: post options',
    async (page, d) => {
      await open(page, `/boards/${d.boardId}`);
      await page
        .getByRole('button', { name: /^Options for/ })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  ],
  [
    'board: save to a board',
    async (page, d) => {
      await open(page, `/boards/${d.boardId}`);
      await page
        .getByRole('button', { name: /^Options for/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'Save to a board' }).click();
      await expect(page.getByRole('dialog', { name: 'Save to a board' })).toBeVisible();
    },
  ],
  [
    'board: collaborators',
    async (page, d) => {
      await open(page, `/boards/${d.boardId}`);
      await page.getByRole('button', { name: /^(Invite|Collaborators)$/ }).click();
      await expect(page.getByRole('dialog', { name: 'Collaborators' })).toBeVisible();
    },
  ],
  [
    'board: arranging',
    async (page, d) => {
      await open(page, `/boards/${d.boardId}`);
      await page.getByRole('button', { name: 'Arrange' }).click();
      await expect(page.getByRole('group', { name: 'Arrange' })).toBeVisible();
    },
  ],
  [
    'drafts: schedule sheet',
    async (page) => {
      await open(page, '/drafts');
      await page.getByRole('button', { name: 'Schedule', exact: true }).first().click();
      await expect(page.getByRole('dialog', { name: 'Schedule this post' })).toBeVisible();
    },
  ],
  [
    'create: schedule, circle and co-authors',
    async (page) => {
      await open(page, '/create');
      await page.getByRole('textbox', { name: /What/ }).first().fill('Dinner plans for Friday');
      await page.getByLabel('Who can see this').selectOption({ label: 'Circle: Supper club' });
      await page.getByRole('button', { name: 'Schedule' }).click();
      await expect(page.getByLabel('Publish on')).toBeVisible();
      await page.getByRole('combobox', { name: /co-authors/ }).fill('Ben');
      await expect(page.getByRole('option', { name: /Ben Keyboard/ })).toBeVisible();
    },
  ],
  [
    'create: photo editor',
    async (page) => {
      await open(page, '/create');
      await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES, 'market.jpg'));
      await expect(page.getByRole('dialog', { name: 'Edit photo' })).toBeVisible();
    },
  ],
  [
    'create: alt text',
    async (page) => {
      await open(page, '/create');
      await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES, 'market.jpg'));
      const editor = page.getByRole('dialog', { name: 'Edit photo' });
      await editor.getByRole('button', { name: /^(Done|Use photo|Next)$/ }).click();
      await expect(page.getByRole('textbox', { name: /Describe image 1/ })).toBeVisible({ timeout: 20_000 });
      await page.getByRole('textbox', { name: /Describe image 1/ }).fill('Peaches on a market stall');
    },
  ],
  [
    'create: story music picker',
    async (page) => {
      await open(page, '/create?mode=story');
      await page.getByRole('button', { name: 'Add music' }).click();
      await expect(page.getByRole('dialog', { name: 'Choose a sound' }).getByRole('button', { name: /^Use/ }).first()).toBeVisible();
    },
  ],
  [
    'create: story with music',
    async (page) => {
      await open(page, '/create?mode=story');
      await page.getByRole('textbox').first().fill('Oven timer beats all day');
      await page.getByRole('button', { name: 'Add music' }).click();
      await page.getByRole('dialog', { name: 'Choose a sound' }).getByRole('button', { name: /^Use/ }).first().click();
      await expect(page.getByRole('button', { name: 'Choose another sound' })).toBeVisible();
    },
  ],
  [
    'chapter: player',
    async (page, d) => {
      await open(page, `/chapters/${d.chapterId}`);
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Space');
    },
  ],
  [
    'chapter: invite',
    async (page, d) => {
      await open(page, `/chapters/${d.chapterId}`);
      await page.getByRole('button', { name: 'Invite' }).click();
      await expect(page.getByRole('dialog', { name: 'Invite to add stories' })).toBeVisible();
    },
  ],
  [
    'recap: send in a chat',
    async (page, d) => {
      test.skip(!d.recapReady, 'the recap video was not ready');
      await open(page, `/recaps?open=${d.recapId}`);
      await page.getByRole('button', { name: 'Send in a chat' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  ],
  [
    'recap: post as reel',
    async (page, d) => {
      test.skip(!d.recapReady, 'the recap video was not ready');
      await open(page, `/recaps?open=${d.recapId}`);
      await page.getByRole('button', { name: 'Post as reel' }).click();
    },
  ],
  [
    'settings: data saver',
    async (page) => {
      await open(page, '/settings#data-saver');
      await page.locator('#data-saver').scrollIntoViewIfNeeded();
      await expect(page.locator('#data-saver').getByRole('heading')).toBeVisible();
    },
  ],
];

test.describe('open sheets, menus and states', () => {
  test.use({ storageState: STATE });
  for (const [name, run] of STATES)
    test(name, async ({ page }, info) => {
      await run(page, data());
      await audit(page, name.replace(/[:/]/g, ' -'), info.project.name);
    });

  test('room: before joining', async ({ page }, info) => {
    const id = await liveRoom(info.project.use.baseURL!);
    await open(page, `/rooms/${id}`);
    await expect(page.getByRole('button', { name: 'Join as a listener' })).toBeVisible();
    await audit(page, 'room - before joining', info.project.name);
  });

  test('room: listening, hand raised', async ({ page }, info) => {
    const id = await liveRoom(info.project.use.baseURL!);
    await open(page, `/rooms/${id}`);
    await page.getByRole('button', { name: 'Join as a listener' }).click();
    const hand = page.getByRole('button', { name: 'Raise hand' });
    await hand.click();
    await expect(hand).toHaveAttribute('aria-pressed', 'true');
    await audit(page, 'room - listening', info.project.name);
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
