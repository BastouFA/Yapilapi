import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Yaps (docs/product/yaps.md): record a Yap with the browser's fake microphone, post it, find its
 * card on Pulse's Yaps filter, play it and open its transcript, then answer it by voice from
 * another account. Chrome's fake media flags stand in for a real microphone. With a speech-to-text
 * provider the transcript's words show; without one, "Transcript not available".
 */
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  permissions: ['microphone'],
});
test.beforeEach(({}, info) => test.skip(!info.project.name.startsWith('desktop-light'), 'one browser is enough for recording'));

async function account(request: APIRequestContext, name: string) {
  const username = `yap_${name}_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 30);
  const res = await request.post('/api/v1/auth/register', {
    data: {
      email: `${username}@yaps.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: `[Dev data] ${name}`,
      birthDate: '1990-05-01',
    },
  });
  expect(res.status()).toBe(201);
  expect((await request.put('/api/v1/me/interests', { data: { topics: ['music', 'food', 'design'] } })).ok()).toBeTruthy();
  expect((await request.post('/api/v1/me/onboarding/complete', { data: {} })).ok()).toBeTruthy();
  return username;
}

/** Record for about `ms` with tap-to-start and tap-to-stop (the keyboard and screen reader path). */
async function record(page: Page, ms: number) {
  const button = page.getByTestId('yap-record');
  await button.click();
  await page.waitForTimeout(ms);
  await page.getByTestId('yap-record').click();
  await expect(page.getByTestId('yap-preview')).toBeVisible();
}

test('records, posts, plays and transcribes a Yap, and takes a voice reply', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const speakerName = await account(page.request, 'speaker');

  // Create opens on Yap from Spark; the big button records.
  await page.goto('/create?mode=yap');
  await record(page, 2500);
  await page.getByLabel('Add a line (optional)').fill('[Dev data] Good morning from the test microphone #mornings');
  await page.getByTestId('yap-post').click();

  // Pulse, Yaps only: the card, its player and its transcript.
  await page.waitForURL(/\/home/);
  if (!/mode=yaps/.test(page.url())) await page.goto('/home?mode=yaps');
  const card = page.getByTestId('yap-card').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Good morning from the test microphone');
  const play = card.getByTestId('yap-play');
  await play.click();
  await expect(card.getByTestId('yap-play')).toHaveAccessibleName('Pause');
  await card.getByTestId('yap-transcript-toggle').click();
  await expect(card.getByText(/Hello from the test microphone|Transcript not available/)).toBeVisible({ timeout: 30_000 });
  const mine = (await (await page.request.get(`/api/v1/users/${speakerName}/posts`)).json()).items as { id: string; format: string }[];
  expect(mine[0]?.format).toBe('yap');
  const href = `/p/${mine[0]!.id}`;

  // Someone else answers by voice, on the Yap's page.
  const listener = await browser.newContext({ baseURL, permissions: ['microphone'] });
  const other = await listener.newPage();
  await account(other.request, 'listener');
  await other.goto(href!);
  await expect(other.getByTestId('yap-card')).toBeVisible();
  // The transcript is open on the Yap's own page.
  await expect(other.getByTestId('yap-card').getByText(/Hello from the test microphone|Transcript not available/)).toBeVisible();
  await other
    .getByRole('button', { name: /^Comments/ })
    .first()
    .click();
  await other.getByTestId('voice-reply').click();
  await record(other, 1800);
  await other
    .getByRole('group', { name: 'Reply by voice' })
    .getByRole('button', { name: /^(Post|Comment|Send)/ })
    .click();
  const reply = other.getByTestId('comment-voice');
  await expect(reply).toBeVisible({ timeout: 20_000 });
  await expect(reply.getByTestId('yap-play')).toBeVisible();

  // The speaker sees the voice reply under their Yap.
  await page.goto(href!);
  await page
    .getByRole('button', { name: /^Comments/ })
    .first()
    .click();
  await expect(page.getByTestId('comment-voice').first()).toBeVisible({ timeout: 20_000 });
  await listener.close();
});
