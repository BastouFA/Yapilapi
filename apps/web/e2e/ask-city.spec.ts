import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Ask the city (docs/product/ask-the-city.md): ask a question out loud with the browser's fake
 * microphone, find it as someone else in the same city, answer it by voice, mark the answer helpful
 * as the asker, and see "Helped 1 person in …" on the answerer's profile.
 */
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  permissions: ['microphone'],
});
test.beforeEach(({}, info) => test.skip(!info.project.name.startsWith('desktop-light'), 'one browser is enough for recording'));

async function account(request: APIRequestContext, name: string, city: string) {
  const username = `ask_${name}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 30);
  const res = await request.post('/api/v1/auth/register', {
    data: {
      email: `${username}@ask.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: `[Dev data] ${name}`,
      birthDate: '1990-05-01',
    },
  });
  expect(res.status()).toBe(201);
  expect((await request.put('/api/v1/me/interests', { data: { topics: ['music', 'food', 'design'] } })).ok()).toBeTruthy();
  expect((await request.post('/api/v1/me/onboarding/complete', { data: {} })).ok()).toBeTruthy();
  expect((await request.patch('/api/v1/me/profile', { data: { city } })).ok()).toBeTruthy();
  return username;
}

async function record(page: Page, ms: number) {
  await page.getByTestId('yap-record').click();
  await page.waitForTimeout(ms);
  await page.getByTestId('yap-record').click();
  await expect(page.getByTestId('yap-preview')).toBeVisible();
}

test('asks the city out loud, gets a voice answer and marks it helpful', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const city = `Lagos ${randomBytes(3).toString('hex')}`;
  await account(page.request, 'asker', city);

  // Ask: by voice, about food, in my city.
  await page.goto('/ask?ask=1');
  const form = page.locator('form.askcity-form');
  await expect(form).toBeVisible();
  await record(page, 3000);
  await form.getByLabel('Add a line (optional)').fill('[Dev data] Best suya near the stadium?');
  await form.getByRole('group', { name: 'Topic' }).getByRole('button', { name: 'Food' }).click();
  await form.getByRole('textbox', { name: 'City', exact: true }).fill(city);
  await expect(form.getByText('Only the area shows, never where you are.', { exact: false })).toBeVisible();
  await form.getByRole('button', { name: 'Ask a question' }).click();
  await expect(form).toBeHidden({ timeout: 20_000 });

  // Someone else in the city finds it, unanswered first, and answers by voice.
  const other = await browser.newContext({ baseURL, permissions: ['microphone'] });
  const helperPage = await other.newPage();
  const helperName = await account(helperPage.request, 'helper', city);
  await helperPage.goto('/ask');
  await expect(helperPage.getByRole('heading', { name: `Open questions in ${city}` })).toBeVisible({ timeout: 20_000 });
  const card = helperPage.locator('article', { hasText: 'Best suya near the stadium?' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Needs an answer');
  await expect(card).toContainText('Food');
  await card
    .getByRole('button', { name: /^Comments/ })
    .first()
    .click();
  await helperPage.getByTestId('voice-reply').click();
  await record(helperPage, 3000);
  await helperPage
    .getByRole('group', { name: 'Reply by voice' })
    .getByRole('button', { name: /^(Post|Comment|Send)/ })
    .click();
  await expect(helperPage.getByTestId('comment-voice')).toBeVisible({ timeout: 20_000 });

  // The asker marks it helpful from their questions.
  await page.goto('/ask');
  await page.getByRole('button', { name: 'Your questions' }).click();
  const mine = page.locator('article', { hasText: 'Best suya near the stadium?' }).first();
  await expect(mine).toBeVisible({ timeout: 20_000 });
  await mine
    .getByRole('button', { name: /^Comments/ })
    .first()
    .click();
  const mark = page.getByRole('button', { name: 'Mark as helpful' }).first();
  await expect(mark).toBeVisible({ timeout: 20_000 });
  await mark.click();
  await expect(mark).toHaveAttribute('aria-pressed', 'true');

  // The helper's profile says so, quietly.
  await helperPage.goto(`/u/${helperName}`);
  await expect(helperPage.getByText(`Helped 1 person in ${city}`)).toBeVisible({ timeout: 20_000 });
  await other.close();
});
