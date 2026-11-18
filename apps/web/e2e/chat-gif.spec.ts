import { randomBytes } from 'node:crypto';
import { expect, request, test, type APIRequestContext } from '@playwright/test';

/**
 * The GIF tab in a chat: beside the emojis, trending GIFs and a search ("Search KLIPY", as KLIPY
 * asks), and a tap sends one, still moving, to the other person. Runs on the API's sample GIFs
 * (KLIPY_API_KEY=dev); the real ones come from KLIPY.
 */
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

async function account(ctx: APIRequestContext, name: string) {
  const username = `cg_${name}_${run}`.slice(0, 30);
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

test('send a GIF from the GIF tab in a chat', async ({ page, baseURL }, info) => {
  const tag = info.project.name.startsWith('mobile') ? 'm' : 'd';
  const me = await account(page.request, `me${tag}`);
  const friend = await request.newContext({ baseURL });
  const them = await account(friend, `fr${tag}`);
  expect((await page.request.post(`/api/v1/users/${them.id}/follow`)).ok()).toBeTruthy();
  expect((await friend.post(`/api/v1/users/${me.id}/follow`)).ok()).toBeTruthy();
  const chat = await (await friend.post('/api/v1/conversations', { data: { memberIds: [me.id] } })).json();
  const id = chat.conversation.id as string;

  await page.goto(`/inbox/${id}`);
  await page.getByRole('button', { name: 'Emoji' }).click();
  await page.getByRole('tab', { name: 'GIF' }).click();
  const search = page.getByRole('searchbox', { name: 'Search KLIPY' });
  await expect(search).toHaveAttribute('placeholder', 'Search KLIPY');
  await expect(page.getByText('Powered by KLIPY')).toBeVisible();
  // Nothing found says so.
  await search.fill('nothing');
  await expect(page.getByText('No GIFs found')).toBeVisible();
  await search.fill('dance');
  const first = page.getByRole('button', { name: 'Send GIF: dance 1' });
  await expect(first).toBeVisible();
  await first.click();

  // It's in the chat, for both of them, as a GIF.
  const sent = page.locator('.chat-msg--mine img').last();
  await expect(sent).toHaveAttribute('src', /\.gif$/);
  await expect
    .poll(async () => {
      const r = await (await friend.get(`/api/v1/conversations/${id}/messages`)).json();
      return r.items.at(-1)?.attachments?.[0]?.url ?? '';
    })
    .toMatch(/\.gif$/);
  // Back on the emojis, the tab remembered is GIF: open it again and it's there.
  await page.getByRole('button', { name: 'Emoji' }).click();
  await expect(page.getByRole('tab', { name: 'GIF' })).toHaveAttribute('aria-selected', 'true');
});
