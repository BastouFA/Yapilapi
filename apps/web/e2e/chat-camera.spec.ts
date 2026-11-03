import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, request, test, type APIRequestContext } from '@playwright/test';

/**
 * The camera in a chat: open it from the message box, take a photo, take another, send it, and it's
 * in the chat. Runs on Chromium's made-up camera; a phone's real one needs a phone.
 */
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

async function account(ctx: APIRequestContext, name: string) {
  const username = `cc_${name}_${run}`.slice(0, 30);
  const res = await ctx.post('/api/v1/auth/register', {
    data: {
      email: `${username}@a11y.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: name,
      birthDate: '1990-05-01',
      locale: 'en',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  await ctx.post('/api/v1/me/onboarding/complete', { data: {} });
  return (await res.json()).user as { id: string };
}

test('take a photo in a chat, take another, send it', async ({ page, baseURL }, info) => {
  const tag = info.project.name.startsWith('mobile') ? 'm' : 'd';
  const me = await account(page.request, `me${tag}`);
  const friend = await request.newContext({ baseURL });
  const them = await account(friend, `fr${tag}`);
  expect((await page.request.post(`/api/v1/users/${them.id}/follow`)).ok()).toBeTruthy();
  expect((await friend.post(`/api/v1/users/${me.id}/follow`)).ok()).toBeTruthy();
  const chat = await (await friend.post('/api/v1/conversations', { data: { memberIds: [me.id] } })).json();

  await page.goto(`/inbox/${chat.conversation.id}`);
  await page.getByRole('button', { name: 'Take photo' }).click();
  const camera = page.getByRole('dialog', { name: 'Camera' });
  const shutter = camera.getByRole('button', { name: 'Take photo' });
  await expect(shutter).toBeEnabled();
  await shutter.click();

  // A look at it first: nothing has gone, and the camera has stopped.
  const send = camera.getByRole('button', { name: 'Send' });
  await expect(send).toBeFocused();
  await expect(camera.locator('img')).toBeVisible();
  await expect(camera.locator('video')).toHaveCount(0);
  expect((await (await page.request.get(`/api/v1/conversations/${chat.conversation.id}/messages`)).json()).items).toHaveLength(0);

  // Another go, then send it.
  await camera.getByRole('button', { name: 'Retake' }).click();
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await send.click();

  await expect(camera).toHaveCount(0);
  await expect(page.locator('.chat-msg img').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeFocused();

  // The gallery button on the camera takes a video too, with the same look first.
  await page.getByRole('button', { name: 'Take photo' }).click();
  await camera.locator('input[type=file]').setInputFiles(path.join(import.meta.dirname, 'fixtures', 'clip.mp4'));
  await expect(camera.locator('video[controls]')).toBeVisible();
  await send.click();
  await expect(camera).toHaveCount(0);
  await expect(page.locator('.chat-msg video').first()).toBeVisible();
});
