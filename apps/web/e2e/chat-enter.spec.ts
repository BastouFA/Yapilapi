import { randomBytes } from 'node:crypto';
import { expect, request, test, type APIRequestContext } from '@playwright/test';

/**
 * The Return key in a chat's message box: on a phone it starts a new line and the Send button sends,
 * as in other messaging apps; on a computer Enter sends and Shift+Enter starts a new line.
 */
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

async function account(ctx: APIRequestContext, name: string) {
  const username = `ce_${name}_${run}`.slice(0, 30);
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

test('Return starts a new line on a phone and sends on a computer', async ({ page, baseURL }, info) => {
  const phone = info.project.name.startsWith('mobile');
  const tag = phone ? 'm' : 'd';
  const me = await account(page.request, `me${tag}`);
  const friend = await request.newContext({ baseURL });
  const them = await account(friend, `fr${tag}`);
  expect((await page.request.post(`/api/v1/users/${them.id}/follow`)).ok()).toBeTruthy();
  expect((await friend.post(`/api/v1/users/${me.id}/follow`)).ok()).toBeTruthy();
  const chat = await (await friend.post('/api/v1/conversations', { data: { memberIds: [me.id] } })).json();

  await page.goto(`/inbox/${chat.conversation.id}`);
  const box = page.locator('#msg');
  await box.click();
  await box.pressSequentially('First line');
  if (phone) {
    await box.press('Enter');
    await box.pressSequentially('Second line');
    await expect(box).toHaveValue('First line\nSecond line');
    await expect(page.locator('.chat-msg--mine')).toHaveCount(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  } else {
    await box.press('Shift+Enter');
    await box.pressSequentially('Second line');
    await expect(box).toHaveValue('First line\nSecond line');
    await box.press('Enter');
  }
  await expect(box).toHaveValue('');
  await expect(page.locator('.chat-msg--mine').last()).toContainText('First line');
  await expect(page.locator('.chat-msg--mine').last()).toContainText('Second line');
});
