import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, request, test, type APIRequestContext } from '@playwright/test';

/**
 * Stickers in a chat: make one from a photo in the Stickers tab (shape, moved, zoomed, a caption),
 * send it, and see it on its own without a bubble; the other person keeps it in their stickers,
 * and a sticker they send can be added to yours. The maker works with a mouse and the keyboard
 * on a computer and with touch on a phone; WebKit (Safari) can't make WebP, so it saves a PNG.
 */
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const PHOTO = path.join(import.meta.dirname, 'fixtures', 'bread.jpg');

async function account(ctx: APIRequestContext, name: string) {
  const username = `cs_${name}_${run}`.slice(0, 30);
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

test('make a sticker, send it, and keep one someone sent', async ({ page, baseURL, browserName }, info) => {
  const tag = `${info.project.name.startsWith('mobile') ? 'm' : 'd'}${browserName[0]}`;
  const me = await account(page.request, `me${tag}`);
  const friend = await request.newContext({ baseURL });
  const them = await account(friend, `fr${tag}`);
  expect((await page.request.post(`/api/v1/users/${them.id}/follow`)).ok()).toBeTruthy();
  expect((await friend.post(`/api/v1/users/${me.id}/follow`)).ok()).toBeTruthy();
  const chat = await (await friend.post('/api/v1/conversations', { data: { memberIds: [me.id] } })).json();
  const id = chat.conversation.id as string;

  await page.goto(`/inbox/${id}`);
  await page.getByRole('button', { name: 'Emoji' }).click();
  await page.getByRole('tab', { name: 'Stickers' }).click();
  await expect(page.getByText('Stickers you make or save show here.')).toBeVisible();
  await page.getByRole('button', { name: 'Make a sticker' }).click();

  const maker = page.getByRole('dialog', { name: 'Make a sticker' });
  await expect(maker.getByRole('button', { name: 'Choose a photo' })).toBeVisible();
  await maker.locator('input[type=file]').setInputFiles(PHOTO);
  const preview = maker.getByRole('img', { name: 'Sticker preview' });
  await expect(preview).toBeVisible();
  await maker.getByRole('radio', { name: 'Rounded square' }).check();
  // Moved with the pointer (a mouse here, a finger on a phone) and with the arrow keys; zoomed with the slider and +.
  const box = (await preview.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  await preview.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('+');
  await maker.getByLabel('Zoom').fill('1.5');
  await maker.getByLabel('Caption (optional)').fill('Fresh bread');
  await expect(maker.getByRole('checkbox', { name: 'White outline' })).toBeChecked();
  await maker.getByRole('button', { name: 'Save sticker' }).click();
  await expect(maker).toBeHidden();

  // It's first in the tab, kept as a 512 × 512 picture: WebP where the browser makes one, PNG in Safari.
  const send = page.getByRole('button', { name: 'Send sticker 1' });
  await expect(send).toBeVisible();
  const mine = (await (await page.request.get('/api/v1/stickers')).json()).items;
  expect(mine).toHaveLength(1);
  expect(mine[0].media.mime).toMatch(browserName === 'chromium' ? /^image\/webp$/ : /^image\/(webp|png)$/);
  await send.click();

  // In the chat on its own: no bubble behind it.
  const sent = page.locator('.chat-msg--mine.chat-msg--sticker').last();
  await expect(sent.locator('img.chat-sticker__img')).toBeVisible();
  expect(await sent.locator('.yp-bubble').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');

  // The other person sees a sticker, and keeps it in their stickers (a copy of their own).
  let messageId = '';
  await expect
    .poll(async () => {
      const r = await (await friend.get(`/api/v1/conversations/${id}/messages`)).json();
      messageId = r.items.at(-1)?.id ?? '';
      return r.items.at(-1)?.sticker ?? false;
    })
    .toBe(true);
  const saved = await friend.post('/api/v1/stickers/save', { data: { messageId } });
  expect(saved.status(), await saved.text()).toBe(201);
  expect((await (await friend.get('/api/v1/stickers')).json()).items).toHaveLength(1);

  // They send one of theirs; from its sheet, it goes into my stickers.
  const upload = await friend.post('/api/v1/media', { multipart: { file: { name: 'bread.jpg', mimeType: 'image/jpeg', buffer: await readFile(PHOTO) } } });
  expect(upload.status(), await upload.text()).toBe(201);
  const mediaId = (await upload.json()).media.id as string;
  expect((await friend.post('/api/v1/stickers', { data: { mediaId } })).status()).toBe(201);
  const theirs = await friend.post(`/api/v1/conversations/${id}/messages`, {
    data: { body: '', clientId: `st-${run}-${tag}`, attachments: [{ mediaId }], sticker: true },
  });
  expect(theirs.status(), await theirs.text()).toBe(201);
  await page.reload();
  const received = page.locator('.chat-msg:not(.chat-msg--mine).chat-msg--sticker').last();
  await received.getByRole('button', { name: 'Sticker' }).click();
  const view = page.getByRole('dialog', { name: 'Sticker' });
  await view.getByRole('button', { name: 'Add to my stickers' }).click();
  await expect(view).toBeHidden();
  await page.getByRole('button', { name: 'Emoji' }).click();
  await page.getByRole('tab', { name: 'Stickers' }).click();
  await expect(page.getByRole('button', { name: 'Send sticker 2' })).toBeVisible();

  // Removing one: "Remove stickers", then the one to go.
  await page.getByRole('button', { name: 'Remove stickers' }).click();
  await page.getByRole('button', { name: 'Remove sticker 2' }).click();
  await expect(page.getByRole('button', { name: 'Remove sticker 2' })).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/stickers')).json()).items).toHaveLength(1);
});
