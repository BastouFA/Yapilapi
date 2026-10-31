import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Go out together (docs/product/go-out-together.md) at phone width (390 px): Ada says she's free;
 * Ben, her friend, sees her in "Who's free" in Chats and taps to make a plan with her; Ada answers
 * I'm in and is in the plan's chat, with its card at the top; Ben adds an expense and the plan says
 * who owes whom, and that no money moves through YAPILAPI. SHOTS (a folder) keeps screenshots.
 */
const SHOTS = process.env.SHOTS;

async function account(request: APIRequestContext, name: string): Promise<{ id: string; displayName: string }> {
  const username = `go_${name}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 30);
  const displayName = `[Dev data] ${name}`;
  const res = await request.post('/api/v1/auth/register', {
    data: { email: `${username}@plans.example.test`, password: randomBytes(18).toString('base64url'), username, displayName, birthDate: '1990-05-01' },
  });
  expect(res.status()).toBe(201);
  expect((await request.post('/api/v1/me/onboarding/complete', { data: {} })).ok()).toBeTruthy();
  return { id: (await res.json()).user.id, displayName };
}

async function person(browser: Browser, colorScheme: 'light' | 'dark') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme, isMobile: true, hasTouch: true });
  return { context, page: await context.newPage() };
}

const shot = async (page: Page, name: string, project: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project}-plans-${name}.png`, fullPage: false });
};
/** Nothing at phone width scrolls sideways. */
const fits = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test('who is free, make a plan, answer, its chat and the cost split, at 390 px', async ({ browser }, info) => {
  test.skip(!info.project.name.startsWith('mobile'), 'the phone-width flow');
  test.setTimeout(120_000);
  const scheme = info.project.name.endsWith('dark') ? 'dark' : 'light';
  const ada = await person(browser, scheme);
  const ben = await person(browser, scheme);
  const a = await account(ada.page.request, 'ada');
  const b = await account(ben.page.request, 'ben');
  // Friends: each asks the other.
  expect((await ada.page.request.post(`/api/v1/users/${b.id}/friend-request`, { data: {} })).ok()).toBeTruthy();
  expect((await ben.page.request.post(`/api/v1/users/${a.id}/friend-request`, { data: {} })).ok()).toBeTruthy();

  // Ada says she's free tonight, with a few words.
  await ada.page.goto('/inbox');
  const strip = ada.page.getByRole('region', { name: 'Who’s free' });
  await strip.getByRole('button', { name: 'I’m free' }).click();
  await strip.getByLabel('A few words (optional)').fill('[Dev data] Up for suya');
  await strip.getByRole('button', { name: 'Now' }).click();
  await expect(strip.getByText(/You’re free until/)).toBeVisible();
  await fits(ada.page);

  // Ben sees her and starts a plan with her.
  await ben.page.goto('/inbox');
  const free = ben.page.getByRole('link', { name: new RegExp(`Make a plan with ${a.displayName.replace(/[[\]]/g, '\\$&')}`) });
  await expect(free).toBeVisible();
  await shot(ben.page, 'free', info.project.name);
  await free.click();
  await ben.page.waitForURL(/\/plans\/new/);
  await ben.page.getByLabel('What’s the plan').fill('[Dev data] Suya and a film');
  await ben.page.getByLabel('Where (optional)').fill('Yaba');
  await expect(ben.page.getByRole('checkbox', { name: new RegExp(a.displayName.replace(/[[\]]/g, '\\$&')) })).toBeChecked();
  await fits(ben.page);
  await shot(ben.page, 'form', info.project.name);
  await ben.page.getByRole('button', { name: 'Make the plan' }).click();
  await ben.page.waitForURL(/\/plans\/[0-9a-f-]{36}$/);
  const planUrl = new URL(ben.page.url()).pathname;
  await expect(ben.page.getByRole('heading', { name: '[Dev data] Suya and a film', level: 1 })).toBeVisible();

  // Ada answers I'm in and opens the plan's chat: its card is at the top.
  await ada.page.goto(planUrl);
  const answers = ada.page.getByRole('group', { name: 'Your answer' });
  await answers.getByRole('button', { name: 'I’m in' }).click();
  await expect(answers.getByRole('button', { name: 'I’m in' })).toHaveAttribute('aria-pressed', 'true');
  await fits(ada.page);
  await shot(ada.page, 'plan', info.project.name);
  await ada.page.getByRole('link', { name: 'Open the chat' }).click();
  await ada.page.waitForURL(/\/inbox\/[0-9a-f-]{36}/);
  await expect(ada.page.getByRole('link', { name: /Plan: \[Dev data\] Suya and a film/ })).toBeVisible();
  await fits(ada.page);
  await shot(ada.page, 'chat', info.project.name);

  // Ben adds an expense, split between them: Ada owes him half; no money moves through YAPILAPI.
  await ben.page.reload();
  await expect(ben.page.getByText('No money moves through YAPILAPI', { exact: false })).toBeVisible();
  await ben.page.getByRole('button', { name: 'Add an expense' }).click();
  await ben.page.getByLabel('What for').fill('Tickets');
  await ben.page.getByLabel('Amount').fill('5000');
  await ben.page.getByLabel('Currency').selectOption('NGN');
  await ben.page.getByRole('button', { name: 'Add an expense' }).click();
  await expect(ben.page.getByText(/owes You/)).toBeVisible();
  await fits(ben.page);
  await shot(ben.page, 'costs', info.project.name);
  await ben.page.getByRole('button', { name: 'Mark paid back' }).click();
  await expect(ben.page.getByText('All square.')).toBeVisible();

  await ada.context.close();
  await ben.context.close();
});
