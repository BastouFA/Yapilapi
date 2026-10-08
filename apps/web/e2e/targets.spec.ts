import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { expect, request, test, type Page } from '@playwright/test';
import { DATA, STATE, THIRD_STATE, type SeedData } from './global-setup';

/**
 * Touch targets: every visible control must be at least 44 by 44 CSS pixels to press, the
 * project's rule (WCAG 2.5.5). The drawn size can be smaller: the design system widens the hit
 * area with a transparent pseudo-element (see "Touch targets" in components.css). Each control is
 * scrolled into view and the page is asked, pixel by pixel out from its centre (left, right, up and
 * down), whether a press there reaches the control, something inside it or its label: it must reach
 * 44px across and 44px down (less a pixel for rounding). What stops it is reported: a neighbour means
 * the two overlap, anything else that the hit area is too small. A control covered at its centre by
 * another is a miss. A control bigger than 44px passes if 44px fits across it somewhere else.
 *
 * Not measured: links inside a paragraph or sentence (WCAG's inline exception), controls that are
 * hidden, clipped away or covered at their centre by something that isn't a control (a file input
 * under its label, a sheet), and past the edge of the screen (a control at the edge can be pressed
 * right up to it).
 */
test.use({ storageState: STATE });
// Colors don't change sizes; run once per layout.
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const data = (): SeedData => JSON.parse(readFileSync(DATA, 'utf8'));
const BASE = process.env.A11Y_BASE_URL ?? 'http://127.0.0.1:3100';

const PAGES: [string, (d: SeedData) => string][] = [
  ['home', () => '/home'],
  ['discover', () => '/discover'],
  ['conversation', (d) => `/inbox/${d.conversationId}`],
  ['chat with games', (d) => `/inbox/${d.gamesChatId}`],
  ['inbox', () => '/inbox'],
  ['profile', (d) => `/u/${d.username}`],
  ['other profile', (d) => `/u/${d.friendUsername}`],
  ['post', (d) => `/p/${d.postId}`],
  ['notifications', () => '/notifications'],
  ['settings', () => '/settings'],
  ['settings: account', () => '/settings/account'],
  ['settings: privacy', () => '/settings/privacy'],
  ['create', () => '/create'],
  ['market', () => '/market'],
  ['near you', () => '/map'],
  ['market listing', (d) => `/market/${d.listingId}`],
  ['event', (d) => `/events/${d.eventId}`],
  ['together album', (d) => `/together/${d.togetherId}`],
  ['board', (d) => `/boards/${d.boardId}`],
  ['community', (d) => `/c/${d.communitySlug}`],
  ['events', () => '/events'],
  ['search results', () => '/search?q=Keyboard'],
  ['settings: notifications', () => '/settings/notifications'],
  ['studio', () => '/studio'],
  ['tickets', () => '/tickets'],
  ['questions', () => '/questions'],
  ['drops', () => '/drops'],
  ['saved', () => '/saved'],
  ['sound', (d) => `/sounds/${d.soundId}`],
];

interface Miss {
  control: string;
  size: string;
  sides: string[];
  hit: string[];
}

/** Runs in the page: every control (in `root`, or the whole page) too small to press, with what was found instead. */
function measure(root: string | null): { checked: number; misses: Miss[] } {
  const CONTROLS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    ...['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'switch', 'checkbox', 'radio', 'slider'].map(
      (r) => `[role="${r}"]`,
    ),
  ].join(',');
  const SIZE = 44;
  // A pixel of rounding: two 44px controls that touch are both fine.
  const ENOUGH = SIZE - 1;

  const describe = (el: Element | null): string => {
    if (!el) return 'nothing';
    const h = el as HTMLElement;
    const cls = typeof h.className === 'string' && h.className ? `.${h.className.trim().split(/\s+/).join('.')}` : '';
    const name = (h.getAttribute('aria-label') ?? h.innerText ?? h.getAttribute('title') ?? '').trim().split('\n')[0]!.slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls}${name ? ` "${name}"` : ''}`;
  };
  /** A link inside a paragraph or a sentence: WCAG's inline exception. */
  const inText = (el: HTMLElement) => {
    if (el.tagName !== 'A' || getComputedStyle(el).display !== 'inline') return false;
    let block = el.parentElement;
    while (block && getComputedStyle(block).display === 'inline') block = block.parentElement;
    return !!block && (block.tagName === 'P' || (block.textContent ?? '').trim().length > (el.textContent ?? '').trim().length);
  };
  const owns = (el: HTMLElement, hit: Element | null) => {
    if (!hit) return false;
    if (el === hit || el.contains(hit)) return true;
    const labels = (el as HTMLInputElement).labels;
    if (labels && [...labels].some((l) => l === hit || l.contains(hit))) return true;
    return hit.closest('label')?.control === el;
  };

  const controls = [...(root ? document.querySelector(root)! : document).querySelectorAll<HTMLElement>(CONTROLS)].filter(
    (el) =>
      !el.closest('[inert], [aria-hidden="true"], nextjs-portal') &&
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      el.getBoundingClientRect().width >= 2 &&
      el.getBoundingClientRect().height >= 2 &&
      !inText(el),
  );
  /** Cut off by a container that clips it (a skip link shown only on focus, a row scrolled aside). */
  const clippedAway = (el: HTMLElement, x: number, y: number) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none') continue;
      const b = a.getBoundingClientRect();
      if (x < b.left || x > b.right || y < b.top || y > b.bottom || cs.clipPath.startsWith('inset(50%')) return true;
    }
    return false;
  };
  const misses: Miss[] = [];
  let checked = 0;
  for (const el of controls) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    // A checkbox or field inside its label is pressed anywhere on the label.
    const r = ((['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.closest('label')) || el).getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (clippedAway(el, cx, cy)) continue;
    // Covered at its centre by something that isn't a control (a file input under its label, a
    // sheet over the page): not pressable as it is, so not measured. Covered by another control: a miss.
    const atCentre = document.elementFromPoint(cx, cy);
    const coveredBy = owns(el, atCentre) ? null : (atCentre?.closest(CONTROLS) ?? null);
    if (!owns(el, atCentre) && !coveredBy) continue;
    checked++;
    if (coveredBy) {
      misses.push({ control: describe(el), size: `${Math.round(r.width)}x${Math.round(r.height)}`, sides: ['centre'], hit: [describe(coveredBy)] });
      continue;
    }
    /** How far the control reaches from (x, y) in one direction, and what stops it. The edge of the screen doesn't. */
    const reach = (x: number, y: number, dx: number, dy: number): [number, Element | null] => {
      for (let n = 1; n <= SIZE; n++) {
        const px = x + dx * n;
        const py = y + dy * n;
        if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) return [SIZE, null];
        const at = document.elementFromPoint(px, py);
        if (!owns(el, at)) return [n - 1, at];
      }
      return [SIZE, null];
    };
    /** Width and height of what presses the control, along the lines through (x, y). */
    const extent = (x: number, y: number) => {
      const sides = { left: reach(x, y, -1, 0), right: reach(x, y, 1, 0), above: reach(x, y, 0, -1), below: reach(x, y, 0, 1) };
      return { sides, wide: sides.left[0] + sides.right[0] + 1 >= ENOUGH, tall: sides.above[0] + sides.below[0] + 1 >= ENOUGH };
    };
    const at = extent(cx, cy);
    if (at.wide && at.tall) continue;
    // A control bigger than 44px passes if 44px fits across it elsewhere: a card with a small button
    // laid over its middle still has room of its own.
    const xs = r.width > SIZE ? [r.left + SIZE / 2, r.right - SIZE / 2] : [cx];
    const ys = r.height > SIZE ? [r.top + SIZE / 2, r.bottom - SIZE / 2] : [cy];
    const roomy = (x: number, y: number) => {
      if (!owns(el, document.elementFromPoint(x, y))) return false;
      const e = extent(x, y);
      return e.wide && e.tall;
    };
    if (xs.some((x) => ys.some((y) => roomy(x, y)))) continue;
    const short = Object.entries(at.sides).filter(([side, [n]]) => n < SIZE && (['left', 'right'].includes(side) ? !at.wide : !at.tall));
    misses.push({
      control: describe(el),
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      sides: short.map(([side, [n]]) => `${side} ${n}px`),
      hit: short.map(([, [, stop]]) => describe(stop)),
    });
  }
  return { checked, misses };
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('main#main')).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, { timeout: 15_000 }).catch(() => {});
  // A chat scrolls to its newest message once it has loaded (and closes an open menu when it does):
  // wait until the page has held still for a few frames.
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

/**
 * Menus and sheets, which only show after an action: each is opened the way a person would, then
 * the controls inside it are measured.
 */
const STATES: [string, string, (page: Page, d: SeedData) => Promise<void>][] = [
  [
    'post options menu',
    '[role="menu"]',
    async (page) => {
      await open(page, '/home');
      await page.getByRole('button', { name: 'Post options' }).first().click();
    },
  ],
  [
    'message options menu',
    '[role="menu"]',
    async (page, d) => {
      await open(page, `/inbox/${d.conversationId}`);
      await page.getByRole('button', { name: 'Message options' }).last().click();
    },
  ],
  [
    'share profile sheet',
    '[role="dialog"]',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('button', { name: 'Share profile' }).click();
    },
  ],
  [
    'status sheet',
    '[role="dialog"]',
    async (page, d) => {
      await open(page, `/u/${d.username}`);
      await page.getByRole('button', { name: 'Edit status' }).click();
    },
  ],
  [
    // Suggested replies under a message from Cleo, in a chat of their own (other tests don't see them).
    // Their text is cut off inside the chip, so the chip's 44px layer isn't clipped in any browser.
    'suggested replies',
    '.smart-replies',
    async (page, d) => {
      const cleo = await request.newContext({ baseURL: BASE, storageState: THIRD_STATE });
      try {
        const made = await cleo.post('/api/v1/conversations', { data: { memberIds: [d.userId] } });
        expect(made.ok(), await made.text()).toBe(true);
        const id = (await made.json()).conversation.id as string;
        expect((await cleo.post(`/api/v1/conversations/${id}/messages`, { data: { body: 'Are you free for dinner on Friday?' } })).ok()).toBe(true);
        expect((await page.request.put(`/api/v1/conversations/${id}/smart-replies`, { data: { enabled: true } })).ok()).toBe(true);
        await open(page, `/inbox/${id}`);
        await expect(page.locator('.smart-replies__chip').first()).toBeVisible();
      } finally {
        await cleo.dispose();
      }
    },
  ],
];

async function check(page: Page, name: string, root: string | null, outFile: string) {
  const { checked, misses } = await page.evaluate(measure, root);
  await writeFile(outFile, JSON.stringify({ page: name, checked, misses }, null, 2));
  expect(checked, 'no controls were measured').toBeGreaterThan(0);
  const report = misses.map((m) => `  ${m.control} (${m.size}): ${m.sides.map((s, i) => `${s}, then ${m.hit[i]}`).join('; ')}`).join('\n');
  expect(misses, `${name}: ${misses.length} of ${checked} controls are smaller than 44 by 44 to press:\n${report}`).toEqual([]);
}

for (const [name, url] of PAGES)
  test(`touch targets: ${name}`, async ({ page }, info) => {
    await open(page, url(data()));
    await check(page, name, null, info.outputPath('targets.json'));
  });

/** Signed-out pages, with their language picker. */
const PUBLIC_PAGES: [string, string][] = [
  ['landing', '/'],
  ['login', '/login'],
  ['signup', '/signup'],
  ['legal', '/legal'],
];
test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  for (const [name, url] of PUBLIC_PAGES)
    test(`touch targets: ${name}`, async ({ page }, info) => {
      await page.goto(url);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await check(page, name, null, info.outputPath('targets.json'));
    });
});

for (const [name, root, show] of STATES)
  test(`touch targets: ${name}`, async ({ page }, info) => {
    // Other tests write in the same chat at the same time; a new message scrolls the chat and closes an
    // open menu, so open it again if it closed before it was measured.
    await expect(async () => {
      await show(page, data());
      await expect(page.locator(root).first()).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      await check(page, name, root, info.outputPath('targets.json'));
    }).toPass({ timeout: 45_000 });
  });
