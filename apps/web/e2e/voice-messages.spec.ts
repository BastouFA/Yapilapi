import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, request, test, type APIRequestContext } from '@playwright/test';

/**
 * Voice messages everyone understands (docs/product/speech-engine.md): Sam sends a voice note in
 * English, and Léa, whose app is in French, opens "Afficher le texte" (Show text) to read it
 * translated, "Traduit (original en anglais) · Voir l’original", and "Écouter en français" (Listen
 * in French) reads the translation out. It needs speech-to-text, a translation model and
 * text-to-speech: run the API against e2e/speech-stub.mjs (how is at its top). Without them the
 * test is skipped.
 */
test.beforeEach(({}, info) => test.skip(info.project.name.endsWith('dark'), 'covered by the light projects'));

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

async function account(ctx: APIRequestContext, name: string, locale: string) {
  const username = `vm_${name}_${run}`.slice(0, 30);
  const res = await ctx.post('/api/v1/auth/register', {
    data: {
      email: `${username}@a11y.example.test`,
      password: randomBytes(18).toString('base64url'),
      username,
      displayName: name,
      birthDate: '1990-05-01',
      locale,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  await ctx.post('/api/v1/me/onboarding/complete', { data: {} });
  return (await res.json()).user as { id: string };
}

test('a voice note in another language shows its words, translated, and can be heard', async ({ page, baseURL }, info) => {
  const flags = await (await page.request.get('/api/v1/flags')).json();
  test.skip(!flags.voiceListen, 'needs speech-to-text, a translation model and text-to-speech (e2e/speech-stub.mjs)');

  // Léa reads French (signed in in the browser); Sam speaks English. They follow each other, so they can write.
  const lea = await account(page.request, `lea${info.project.name.startsWith('mobile') ? 'm' : 'd'}`, 'fr');
  const sam = await request.newContext({ baseURL });
  const samUser = await account(sam, `sam${info.project.name.startsWith('mobile') ? 'm' : 'd'}`, 'en');
  expect((await page.request.post(`/api/v1/users/${samUser.id}/follow`)).ok()).toBeTruthy();
  expect((await sam.post(`/api/v1/users/${lea.id}/follow`)).ok()).toBeTruthy();
  const chat = await (await sam.post('/api/v1/conversations', { data: { memberIds: [lea.id] } })).json();
  const buffer = await readFile(path.join(import.meta.dirname, 'fixtures', 'voice.m4a'));
  const media = await (await sam.post('/api/v1/media', { multipart: { file: { name: 'voice.m4a', mimeType: 'audio/mp4', buffer } } })).json();
  const sent = await sam.post(`/api/v1/conversations/${chat.conversation.id}/messages`, {
    data: { body: '', attachments: [{ mediaId: media.media.id }], clientId: `vm-${run}-${info.project.name}` },
  });
  expect(sent.status(), await sent.text()).toBe(201);

  // The transcript is made in the background: reload until "Show text" is there.
  await page.goto(`/inbox/${chat.conversation.id}`);
  const show = page.getByRole('button', { name: 'Afficher le texte' });
  await expect(async () => {
    if (!(await show.isVisible())) await page.reload();
    await expect(show).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(page.getByRole('button', { name: 'Masquer le texte' })).toHaveAttribute('aria-expanded', 'true');

  // Translated by itself, and labelled as a machine translation.
  await expect(page.getByText('On se voit à six heures, j’apporte le gâteau et les boissons.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Traduit \(original en anglais\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Voir l’original' }).click();
  await expect(page.getByText('See you at six, I am bringing the cake and the drinks.')).toBeVisible();
  await page.getByRole('button', { name: 'Voir la traduction' }).click();

  // "Listen in French": the clip is asked for when tapped.
  const listen = page.getByRole('button', { name: 'Écouter en français' });
  await expect(listen).toBeVisible();
  const spoken = page.waitForResponse((r) => r.url().includes('/transcript/speech') && r.request().method() === 'POST');
  await listen.click();
  const res = await spoken;
  expect(res.status()).toBe(200);
  expect((await res.json()).language).toBe('fr');
  await sam.dispose();
});
