import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Watch together as two people on phones (390 px wide), the way the owner uses it from the home
 * screen: starting again doesn't fill the chat with lines, a shared reel's card starts a session
 * with that reel, the other person joins from the chat's header, sees who's watching and talks in
 * the chat sheet, the add sheet has its three choices, and opening the same session on a second
 * device of the same person moves the video there ("Watching on another device", "Watch here").
 * Each state is checked with axe, in light and dark.
 */
test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(({}, info) => test.skip(!info.project.name.startsWith('mobile'), 'a phone-width check'));

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

/** No accessibility violations (the same rules as e2e/a11y.spec.ts). */
async function audit(page: Page, name: string) {
  // Sheets slide and fade in: audit once they've arrived, so colours aren't caught mid-way.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .exclude('nextjs-portal')
    .analyze();
  const report = results.violations.map((v) => `${v.id}: ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n')}`).join('\n');
  expect(results.violations, `${name} has accessibility violations:\n${report}`).toEqual([]);
}

async function account(ctx: APIRequestContext, name: string, project: string) {
  const username = `wt_${name}${project.endsWith('dark') ? 'd' : 'l'}_${run}`.slice(0, 30);
  const res = await ctx.post('/api/v1/auth/register', {
    data: { email: `${username}@a11y.example.test`, password: randomBytes(18).toString('base64url'), username, displayName: name, birthDate: '1990-05-01' },
  });
  expect(res.status(), await res.text()).toBe(201);
  await ctx.post('/api/v1/me/onboarding/complete', { data: {} });
  return (await res.json()).user as { id: string };
}

test('two people watch together from a chat, and a second device of the same person takes over', async ({ page, browser, baseURL }, info) => {
  const project = info.project.name;
  const colorScheme = info.project.use.colorScheme;
  // Ada (this page) and Cleo, who follow each other and share a chat with Cleo's reel in it.
  const ada = await account(page.request, 'Ada', project);
  const cleoApi = await request.newContext({ baseURL });
  const cleoUser = await account(cleoApi, 'Cleo', project);
  expect((await page.request.post(`/api/v1/users/${cleoUser.id}/follow`)).ok()).toBeTruthy();
  expect((await cleoApi.post(`/api/v1/users/${ada.id}/follow`)).ok()).toBeTruthy();
  const buffer = await readFile(path.join(import.meta.dirname, 'fixtures', 'clip.mp4'));
  const media = await (await cleoApi.post('/api/v1/media', { multipart: { file: { name: 'clip.mp4', mimeType: 'video/mp4', buffer } } })).json();
  const reel = await (
    await cleoApi.post('/api/v1/posts', {
      data: { format: 'reel', body: '[Dev data] Market day', media: [{ id: media.media.id, url: media.media.url, kind: 'video' }] },
    })
  ).json();
  const chatId = (await (await cleoApi.post('/api/v1/conversations', { data: { memberIds: [ada.id] } })).json()).conversation.id as string;
  await cleoApi.post(`/api/v1/conversations/${chatId}/messages`, {
    data: { body: `${baseURL}/reels?start=${reel.post.id}`, clientId: `wt-${run}-${project}` },
  });

  // Starting, going back and starting again leaves one line in the chat, not one per start.
  await page.goto(`/inbox/${chatId}`);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Watch together', exact: true }).first().click();
    await page.waitForURL(/\/watch\//);
    await expect(page.getByText(/1 person watching/)).toBeVisible();
    await page.getByRole('link', { name: 'Back to the chat' }).first().click();
    await page.waitForURL(/\/inbox\//);
  }
  await expect(page.locator('.chat-system', { hasText: 'You started watching together' })).toHaveCount(1);
  await audit(page, 'a chat with a shared reel');

  // The shared reel's card: "Watch together" starts the session with that reel on screen.
  await page.locator('.shared-post__watch').click();
  await page.waitForURL(/\/watch\//);
  const watchUrl = page.url();
  await expect(page.locator('.watch-queue__now')).toContainText('Cleo');

  // Cleo joins from the chat's header ("Join", in words while a session runs).
  const cleo = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, colorScheme, storageState: await cleoApi.storageState() });
  const cleoPage = await cleo.newPage();
  await cleoPage.goto(`/inbox/${chatId}`);
  await cleoPage.getByRole('button', { name: 'Watching together now: Join' }).click();
  await cleoPage.waitForURL(/\/watch\//);
  await expect(page.getByText('2 people watching')).toBeVisible();
  await expect(page.locator('.watch-presence__note')).toHaveText('Cleo joined');
  await audit(page, 'watch together with two people');

  // The chat is a sheet over the lower part of the screen; the video stays above it.
  await cleoPage.getByRole('button', { name: 'Chat', exact: true }).click();
  await cleoPage.locator('#watch-msg').fill('This one is good');
  await cleoPage.locator('#watch-msg').press('Enter');
  await expect(cleoPage.locator('#watch-chat')).toContainText('This one is good');
  await expect(cleoPage.locator('.watch-stage')).toBeInViewport();
  await audit(cleoPage, 'the chat sheet');
  await cleoPage.getByRole('button', { name: 'Close' }).click();

  // One place to add: from YAPILAPI, from this device (a file button), or a YouTube link.
  await page.getByRole('button', { name: 'Add to watch together' }).first().click();
  await expect(page.getByRole('button', { name: 'YAPILAPI' })).toBeVisible();
  await page.getByRole('button', { name: 'This device' }).click();
  await expect(page.getByRole('button', { name: 'Upload from this device' })).toBeVisible();
  await page.getByRole('button', { name: 'YouTube link' }).click();
  await expect(page.getByLabel('Paste a YouTube link')).toBeVisible();
  await audit(page, 'the add sheet');
  await page.keyboard.press('Escape');

  // Ada opens it on a second device: that one plays, this one stops, and Ada still counts once.
  const second = await browser.newContext({ baseURL, viewport: { width: 1280, height: 860 }, colorScheme, storageState: await page.context().storageState() });
  const secondPage = await second.newPage();
  await secondPage.goto(watchUrl);
  await expect(secondPage.getByText('2 people watching')).toBeVisible();
  await expect(page.getByText('Watching on another device')).toBeVisible();
  await expect(page.locator('video.watch-stage__video')).toHaveCount(0);
  await expect(cleoPage.getByText('2 people watching')).toBeVisible();
  await audit(page, 'watching on another device');
  // "Watch here" moves it back.
  await page.getByRole('button', { name: 'Watch here' }).click();
  await expect(secondPage.getByText('Watching on another device')).toBeVisible();
  await expect(page.getByText('Watching on another device')).toHaveCount(0);

  await second.close();
  await cleo.close();
  await cleoApi.dispose();
});
