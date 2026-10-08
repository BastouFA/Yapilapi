import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_STATE, DATA, liveRoom, STATE, watchSession, type SeedData } from './global-setup';

/**
 * axe-core over the main pages, and over open sheets, menus and other states,
 * in every project (desktop/mobile × light/dark). Rules: WCAG 2.0/2.1/2.2 A and
 * AA plus axe best practices (landmarks, heading order, one main, region). A
 * page or state passes with zero violations.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const data = (): SeedData => JSON.parse(readFileSync(DATA, 'utf8'));
const BASE = process.env.A11Y_BASE_URL ?? 'http://127.0.0.1:3100';
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

const PUBLIC_PAGES: [string, string][] = [
  ['landing', '/'],
  ['login', '/login'],
  ['signup', '/signup'],
  ['forgot password', '/forgot-password'],
  ['legal', '/legal'],
  ['privacy policy', '/legal/privacy'],
  ['cookie notice', '/legal/cookies'],
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
  ['settings: account', () => '/settings/account'],
  ['settings: notifications', () => '/settings/notifications'],
  ['settings: privacy', () => '/settings/privacy'],
  ['settings: security', () => '/settings/security'],
  ['settings: safety', () => '/settings/safety'],
  ['settings: appearance', () => '/settings/appearance'],
  ['settings: help', () => '/settings/help'],
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
  ['reel with highlights', (d) => `/reels?start=${d.reel2Id}`],
];

/**
 * Newer pages: weekly wraps, Ask me, drops, and a chat with a wallpaper, a scheduled message and
 * games. On phones these (and the newer states below) are also audited at 375px wide, the
 * narrowest common phone, and must not scroll sideways there.
 */
const NEW_PAGES: [string, (d: SeedData) => string][] = [
  // The Yap button opens the recorder; Pulse has Yaps right after For you.
  ['record a Yap', () => '/create?mode=yap'],
  ['home: Yaps', () => '/home?mode=yaps'],
  ['wraps', () => '/wraps'],
  ['wrap', (d) => (d.wrapId ? `/wraps/${d.wrapId}` : '/wraps')],
  ['questions', () => '/questions'],
  ['drops', () => '/drops'],
  ['new drop', () => '/drops/new'],
  ['drop', (d) => `/drops/${d.dropId}`],
  ['your drop', (d) => `/drops/${d.myDropId}`],
  ['edit drop', (d) => `/drops/${d.myDropId}/edit`],
  ['chat with games', (d) => `/inbox/${d.gamesChatId}`],
  // Market, tickets and check-in, Together albums and echoes.
  ['market', () => '/market'],
  ['near you', () => '/map'],
  ['market: sell something', () => '/market/new'],
  ['market listing', (d) => `/market/${d.listingId}`],
  ['your market listing', (d) => `/market/${d.myListingId}`],
  ['your market', () => '/market/mine'],
  ['market: edit a listing', (d) => `/market/${d.myListingId}/edit`],
  ['event with a ticket', (d) => `/events/${d.ticketEventId}`],
  ['tickets', () => '/tickets'],
  ['check-in', (d) => `/events/${d.hostEventId}/check-in`],
  // Communities and events from the 2026-10-05 sweep.
  ['communities', () => '/communities'],
  ['community settings', (d) => `/c/${d.communitySlug}/manage`],
  ['new event', () => '/events/new'],
  ['edit event', (d) => `/events/${d.hostEventId}/edit`],
  ['together', () => '/together'],
  ['together album', (d) => `/together/${d.togetherId}`],
  ['new together album', () => '/together/new'],
  ['echo', (d) => `/reels/${d.reelId}/echo`],
  ['echoes', (d) => `/reels/${d.reelId}/echoes`],
];

const PHONE = { width: 375, height: 812 };

/** On phones, a 375px-wide screen (the Pixel 7 projects are 412px). */
async function narrow(page: Page, project: string) {
  if (project.startsWith('mobile')) await page.setViewportSize(PHONE);
}

async function noSidewaysScroll(page: Page, name: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${name} is ${overflow}px wider than the screen`).toBeLessThanOrEqual(1);
}

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
  // Pages that keep a position (chat following the newest message, "jump to" a message) may still be
  // scrolling; audit once the page has held still for a few frames, so nothing is caught mid-way.
  await page
    .waitForFunction(
      () =>
        new Promise<boolean>((resolve) => {
          let last = scrollY;
          let still = 0;
          const tick = () => {
            still = scrollY === last ? still + 1 : 0;
            last = scrollY;
            if (still >= 10) resolve(true);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {});
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
  for (const [name, url] of NEW_PAGES)
    test(name, async ({ page }, info) => {
      await narrow(page, info.project.name);
      await open(page, url(data()));
      await audit(page, name, info.project.name);
      await noSidewaysScroll(page, name);
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
      await page.getByRole('button', { name: 'Edit cover' }).click();
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
      await expect(page.getByRole('dialog', { name: 'Add music' }).getByRole('button', { name: /^Use/ }).first()).toBeVisible();
    },
  ],
  [
    'create: story with music',
    async (page) => {
      await open(page, '/create?mode=story');
      await page.getByRole('textbox').first().fill('Oven timer beats all day');
      await page.getByRole('button', { name: 'Add music' }).click();
      await page.getByRole('dialog', { name: 'Add music' }).getByRole('button', { name: /^Use/ }).first().click();
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
      await page.getByRole('button', { name: /^Post as (a )?reel$/ }).click();
    },
  ],
  [
    'reels: details',
    async (page, d) => {
      await open(page, `/reels?start=${d.reel2Id}`);
      // Reels off screen are inert: only the one on screen can be reached.
      const reel = page.locator('.reel--active');
      await reel.getByRole('button', { name: 'More about this reel' }).click();
      await expect(reel.getByRole('region', { name: 'About this reel' }).getByRole('button', { name: /^Go to Crumb/ })).toBeVisible();
    },
  ],
  [
    'reels: options sheet',
    async (page, d) => {
      await open(page, `/reels?start=${d.reel2Id}`);
      await page.locator('.reel--active').getByRole('button', { name: 'Reel options' }).click();
      await expect(page.getByRole('dialog', { name: 'Reel options' }).getByRole('group', { name: 'Speed' })).toBeVisible();
    },
  ],
  [
    'reels: share sheet',
    async (page, d) => {
      await open(page, `/reels?start=${d.reel2Id}`);
      await page
        .locator('.reel--active')
        .getByRole('button', { name: /^Share/ })
        .click();
      await expect(page.getByRole('dialog', { name: 'More ways to share' }).getByRole('button', { name: 'Copy link' })).toBeVisible();
    },
  ],
  [
    'reels: comments with a moment',
    async (page, d) => {
      await open(page, `/reels?start=${d.reel2Id}`);
      await page
        .locator('.reel--active')
        .getByRole('button', { name: /^Comments/ })
        .click();
      await expect(page.getByRole('dialog', { name: 'Comments' }).getByRole('button', { name: 'Go to 0:04 in the reel' })).toBeVisible();
    },
  ],
  [
    'reels: clear view',
    async (page, d) => {
      await open(page, `/reels?start=${d.reel2Id}`);
      const clear = page.locator('.reel--active').getByRole('button', { name: 'Clear view', exact: true });
      await clear.click();
      await expect(clear).toHaveAttribute('aria-pressed', 'true');
    },
  ],
  [
    'settings: data saver',
    async (page) => {
      await open(page, '/settings/data-saver');
      await page.locator('#data-saver').scrollIntoViewIfNeeded();
      await expect(page.locator('#data-saver').getByRole('heading')).toBeVisible();
    },
  ],
];

/** Newer states (audited at 375px on phones, like NEW_PAGES). */
const NEW_STATES: [string, (page: Page, d: SeedData) => Promise<void>][] = [
  [
    'nav: more ways to create',
    async (page) => {
      await open(page, '/home');
      // A right click (a long press on a phone) on the Yap button opens the other ways to create.
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Yap', exact: true }).click({ button: 'right' });
      await expect(page.getByRole('dialog', { name: 'More ways to create' })).toBeVisible();
    },
  ],
  [
    'home: pulse cards and drops',
    async (page, d) => {
      await open(page, '/home');
      if (d.wrapId) await expect(page.getByRole('link', { name: 'Look back' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Friday bake/ }).first()).toBeVisible();
    },
  ],
  [
    'profile: styled header, links and song',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await expect(page.getByRole('list', { name: 'Links' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Oven timer beats/ }).first()).toBeVisible();
    },
  ],
  [
    'profile: answers tab',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('group', { name: 'Tabs' }).getByRole('button', { name: 'Answers' }).click();
      await expect(page.getByText('Lentil and lemon, done in thirty minutes.')).toBeVisible();
    },
  ],
  [
    'other profile: ask card',
    async (page, d) => {
      await open(page, `/u/${d.friendUsername}`);
      await page.getByRole('textbox', { name: 'Your question' }).fill('What flour do you use?');
    },
  ],
  [
    'questions: answering',
    async (page) => {
      await open(page, '/questions');
      await page.getByRole('button', { name: 'Answer', exact: true }).first().click();
      await page.getByRole('textbox', { name: 'Your answer' }).fill('The one by the station, on Saturdays.');
    },
  ],
  [
    'drops: yours',
    async (page) => {
      await open(page, '/drops');
      await page.getByRole('button', { name: 'Yours', exact: true }).click();
      await expect(page.getByRole('link', { name: /Summer jam/ })).toBeVisible();
    },
  ],
  [
    'chat: watch together banner',
    async (page, d) => {
      await watchSession(BASE, d.gamesChatId);
      await open(page, `/inbox/${d.gamesChatId}`);
      await expect(page.getByRole('region', { name: 'Watching together now' })).toBeVisible();
    },
  ],
  [
    'watch together',
    async (page) => {
      const id = await watchSession(BASE);
      await open(page, `/watch/${id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Watch together' })).toBeVisible();
    },
  ],
  [
    'chat: start a game',
    async (page, d) => {
      await open(page, `/inbox/${d.gamesChatId}`);
      await page.getByRole('button', { name: 'Add to this chat' }).click();
      await page.getByRole('menuitem', { name: 'Play a game' }).click();
      await expect(page.getByRole('dialog', { name: 'Start a game' })).toBeVisible();
    },
  ],
  ...(['Four up', 'Noughts', 'Word ladder', 'Chess'] as const).map((game): [string, (page: Page, d: SeedData) => Promise<void>] => [
    `chat: ${game} board`,
    async (page, d) => {
      await open(page, `/inbox/${d.gamesChatId}`);
      await page.getByRole('button', { name: `Your turn: ${game}` }).click();
      await expect(page.getByRole('dialog', { name: game })).toBeVisible();
    },
  ]),
  [
    'chat: wallpaper and colour',
    async (page, d) => {
      await open(page, `/inbox/${d.gamesChatId}`);
      await page.getByRole('button', { name: 'Conversation options' }).click();
      await page.getByRole('menuitem', { name: 'Wallpaper and colour' }).click();
      await expect(page.getByRole('dialog', { name: 'Wallpaper and colour' })).toBeVisible();
    },
  ],
  [
    'chat: send later',
    async (page, d) => {
      await open(page, `/inbox/${d.gamesChatId}`);
      await page.getByRole('textbox', { name: /message/i }).fill('See you at the market');
      await page.getByRole('button', { name: 'Send later' }).click();
      await expect(page.getByRole('dialog', { name: 'Send later' })).toBeVisible();
    },
  ],
  [
    'settings: customise your profile',
    async (page) => {
      await open(page, '/settings/account#customise');
      await page.getByRole('button', { name: 'Add a link' }).click();
      await expect(page.getByRole('heading', { name: 'Customise your profile' })).toBeVisible();
    },
  ],
  [
    'home: why am I seeing this',
    async (page) => {
      await open(page, '/home');
      await page.getByRole('button', { name: 'Post options' }).first().click();
      await page.getByRole('menuitem', { name: 'Why am I seeing this?' }).click();
      await expect(page.getByRole('dialog', { name: 'Why am I seeing this?' }).getByRole('listitem').first()).toBeVisible();
    },
  ],
  ...(['Four up', 'Noughts', 'Word ladder', 'Chess'] as const).map((game): [string, (page: Page, d: SeedData) => Promise<void>] => [
    `chat: ${game} board in 3D`,
    async (page, d) => {
      await open(page, `/inbox/${d.gamesChatId}`);
      await page.getByRole('button', { name: `Your turn: ${game}` }).click();
      const view = page.getByRole('dialog', { name: game }).getByRole('button', { name: '3D view' });
      await view.click();
      await expect(view).toHaveAttribute('aria-pressed', 'true');
    },
  ]),
  [
    'market listing: make an offer',
    async (page, d) => {
      await open(page, `/market/${d.listingId}`);
      await page.getByRole('button', { name: 'Make an offer' }).click();
      await expect(page.getByRole('dialog', { name: 'Make an offer' })).toBeVisible();
    },
  ],
  [
    'your market listing: mark reserved',
    async (page, d) => {
      await open(page, `/market/${d.myListingId}`);
      await page.getByRole('button', { name: 'Mark reserved' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  ],
  [
    'tickets: give to a friend',
    async (page) => {
      await open(page, '/tickets');
      await page.getByRole('button', { name: 'Give to a friend' }).first().click();
      await expect(page.getByRole('dialog', { name: 'Give this ticket to a friend' })).toBeVisible();
    },
  ],
  [
    'check-in: a code that is not on the list',
    async (page, d) => {
      await open(page, `/events/${d.hostEventId}/check-in`);
      await page.getByRole('textbox', { name: 'Backup code' }).fill('ZZZZ99');
      await page.getByRole('button', { name: 'Check in', exact: true }).first().click();
      await expect(page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: /\S/ }).first()).toBeVisible();
    },
  ],
  [
    'together album: viewer',
    async (page, d) => {
      await open(page, `/together/${d.togetherId}`);
      await page
        .getByRole('button', { name: /^Photo by/ })
        .first()
        .click();
      await expect(page.getByRole('dialog', { name: /^Photos and videos in/ })).toBeVisible();
    },
  ],
  [
    'together album: people',
    async (page, d) => {
      await open(page, `/together/${d.togetherId}`);
      await page
        .getByRole('button', { name: /people/ })
        .first()
        .click();
      await expect(page.getByRole('dialog', { name: 'People' })).toBeVisible();
    },
  ],
  [
    'together album: invite',
    async (page, d) => {
      await open(page, `/together/${d.togetherId}`);
      await page.getByRole('button', { name: 'Invite', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Invite guests' })).toBeVisible();
    },
  ],
  [
    'together album: adding photos',
    async (page, d) => {
      await open(page, `/together/${d.togetherId}`);
      await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES, 'market.jpg'));
      await expect(page.getByRole('dialog', { name: /^Add to/ })).toBeVisible();
    },
  ],
  [
    'echo: with your video',
    async (page, d) => {
      await open(page, `/reels/${d.reelId}/echo`);
      await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES, 'clip.mp4'));
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    },
  ],
  // A page that couldn't load says why, with Try again (a dropped connection, not "not found").
  ...(
    [
      ['board', (d: SeedData) => `/boards/${d.boardId}`, (d: SeedData) => `/v1/boards/${d.boardId}`],
      ['market listing', (d: SeedData) => `/market/${d.listingId}`, (d: SeedData) => `/v1/market/listings/${d.listingId}`],
      ['together album', (d: SeedData) => `/together/${d.togetherId}`, (d: SeedData) => `/v1/together/${d.togetherId}`],
    ] as const
  ).map(([what, url, api]): [string, (page: Page, d: SeedData) => Promise<void>] => [
    `${what}: failed to load`,
    async (page, d) => {
      await page.route(
        (u) => u.pathname === `/api${api(d)}`,
        (r) => r.abort('internetdisconnected'),
      );
      await open(page, url(d));
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    },
  ]),
  [
    'settings: change username',
    async (page, d) => {
      await open(page, '/settings/account');
      await page.getByRole('button', { name: 'Change username' }).click();
      const sheet = page.getByRole('dialog', { name: 'Change your username' });
      await sheet.getByRole('textbox', { name: 'New username' }).fill(`${d.username.slice(0, 24)}_new`);
      await expect(sheet.getByRole('status')).toHaveText(/is available/);
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
  for (const [name, run] of NEW_STATES)
    test(name, async ({ page }, info) => {
      await narrow(page, info.project.name);
      await run(page, data());
      await audit(page, name.replace(/[:/]/g, ' -'), info.project.name);
      await noSidewaysScroll(page, name);
    });

  /**
   * The developer platform: an app with a key and a webhook, its delete confirmation, and the Sign in
   * with YAPILAPI consent screen that app opens. Each project makes its own app.
   */
  test('developers: an app, and its consent screen', async ({ page }, info) => {
    await narrow(page, info.project.name);
    const made = await page.request.post('/api/v1/developer/apps', { data: { name: `Lists ${info.project.name}`, website: 'https://lists.example' } });
    expect(made.ok(), await made.text()).toBe(true);
    const { app } = await made.json();
    await page.request.put(`/api/v1/developer/apps/${app.id}/redirect-uris`, { data: { redirectUris: ['https://lists.example/cb'] } });
    await page.request.post(`/api/v1/developer/apps/${app.id}/keys`, { data: { name: 'Reader', scopes: ['read'] } });
    await open(page, '/developers');
    await page.getByRole('button', { name: `Lists ${info.project.name}` }).click();
    await expect(page.getByText(`client_id = ${app.id}`)).toBeVisible();
    await audit(page, 'developers - an app', info.project.name);
    await noSidewaysScroll(page, 'developers: an app');
    await page.getByRole('button', { name: 'Delete app' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, 'developers - delete an app', info.project.name);
    await page.keyboard.press('Escape');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: app.id,
      redirect_uri: 'https://lists.example/cb',
      scope: 'read write',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    });
    await page.goto(`/oauth/authorize?${query}`);
    await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
    await audit(page, 'oauth consent', info.project.name);
    await noSidewaysScroll(page, 'oauth consent');
    await page.request.delete(`/api/v1/developer/apps/${app.id}`);
  });

  test('report sheet on an event', async ({ page }, info) => {
    await narrow(page, info.project.name);
    // Ben's class: someone else's event, so it has Report (communities and events are reported from their page).
    await open(page, `/events/${data().ticketEventId}`);
    await page.getByRole('button', { name: 'Report', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send report' })).toBeVisible();
    await audit(page, 'event - report sheet', info.project.name);
    await noSidewaysScroll(page, 'event: report sheet');
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
 * The call screen, from the audio call button in a chat's header. A silent tone stands in for the
 * microphone. A chat has one call at a time, so each project calls in a new group (you, Ben and
 * Cleo); nobody answers, and the test hangs up.
 */
/**
 * The admin console, as Dee (an admin: see grantAdmin in global-setup.ts), one tab at a time. The
 * queue holds a reported post and an ad waiting for review; the Mini Apps tab holds one waiting,
 * and is audited again with "Turn down" open (the reason field). Skipped when nobody could be made
 * an admin (A11Y_PSQL unset); CI always sets it.
 */
const ADMIN_TABS: [string, string, (page: Page) => Promise<void>][] = [
  [
    'queue',
    'Moderation',
    async (page) => {
      await expect(page.getByText(/^Free followers, click the link in my bio/).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve ad' }).first()).toBeVisible();
    },
  ],
  ['account signals', 'Account signals', async () => {}],
  ['problems', 'Problems', async () => {}],
  ['people', 'People', async (page) => void (await expect(page.getByRole('searchbox', { name: 'Username or email' })).toBeVisible())],
  ['content', 'Content', async (page) => void (await expect(page.getByRole('searchbox', { name: 'Search the text or a username' })).toBeVisible())],
  ['overview', 'Overview', async (page) => void (await expect(page.getByRole('figure').first()).toBeVisible())],
  ['system', 'System', async (page) => void (await expect(page.getByText('Background jobs')).toBeVisible())],
  ['flags', 'Feature flags', async (page) => void (await expect(page.getByRole('switch').first()).toBeVisible())],
  ['mini apps', 'Mini Apps', async (page) => void (await expect(page.getByText('Supper polls').first()).toBeVisible())],
  ['regional rules', 'Regional rules', async () => {}],
  ['payments', 'Payments', async (page) => void (await expect(page.getByText('Orders by status')).toBeVisible())],
  ['payouts', 'Payouts', async () => {}],
  ['announcements', 'Announcements', async (page) => void (await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible())],
  ['audit log', 'Audit log', async (page) => void (await expect(page.getByRole('table')).toBeVisible())],
];

async function adminTab(page: Page, tab: string) {
  await open(page, '/admin');
  await page.getByRole('tab', { name: tab, exact: true }).click();
  await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
}

test.describe('admin console', () => {
  test.use({ storageState: ADMIN_STATE });
  test.beforeEach(() => test.skip(!data().adminReady, 'A11Y_PSQL is not set, so there is no admin to audit with'));
  for (const [name, tab, ready] of ADMIN_TABS)
    test(`admin: ${name}`, async ({ page }, info) => {
      await narrow(page, info.project.name);
      await adminTab(page, tab);
      await ready(page);
      await audit(page, `admin - ${name}`, info.project.name);
      await noSidewaysScroll(page, `admin: ${name}`);
    });
  test('admin: turning down a Mini App', async ({ page }, info) => {
    await narrow(page, info.project.name);
    await adminTab(page, 'Mini Apps');
    await page.getByRole('button', { name: 'Turn down' }).first().click();
    await expect(page.getByRole('textbox', { name: /Why it was turned down/ })).toBeFocused();
    await audit(page, 'admin - turning down a Mini App', info.project.name);
    await noSidewaysScroll(page, 'admin: turning down a Mini App');
  });
});

test.describe('a call', () => {
  test.use({ storageState: STATE });
  test('chat: calling', async ({ page }, info) => {
    const d = data();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        const out = audio.createMediaStreamDestination();
        audio.createOscillator().connect(out);
        return out.stream;
      };
    });
    const group = await page.request.post('/api/v1/conversations', { data: { memberIds: [d.friendId, d.thirdId], title: 'Supper crew' } });
    expect(group.ok(), await group.text()).toBe(true);
    const { conversation } = await group.json();
    await narrow(page, info.project.name);
    await open(page, `/inbox/${conversation.id}`);
    await page.getByRole('button', { name: 'Audio call' }).click();
    const call = page.getByRole('dialog', { name: 'Call' });
    await expect(call.getByRole('button', { name: 'Hang up' })).toBeVisible();
    await audit(page, 'chat - calling', info.project.name);
    await noSidewaysScroll(page, 'chat: calling');
    await call.getByRole('button', { name: 'Hang up' }).click();
    await expect(call).toBeHidden();
  });
});

/**
 * Right-to-left (Arabic, Hebrew, Persian, Urdu): the layout mirrors and nothing
 * pushes the page sideways. An offscreen element placed with a physical
 * `left: -9999px` once made every page scroll to blank space in RTL.
 */
test.describe('right-to-left layout', () => {
  test.use({ storageState: STATE });
  for (const [name, url] of [...APP_PAGES, ...NEW_PAGES])
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
