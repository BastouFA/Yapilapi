import { randomBytes } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Calls between two people, each way, with Chromium's made-up camera and microphone. The person
 * called is signed in on two devices, as most people are: both ring, the one answered connects, and
 * the caller gets one answer, from that one.
 */
test.use({
  permissions: ['camera', 'microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});
test.beforeEach(({}, info) => test.skip(!info.project.name.startsWith('desktop-light'), 'one run is enough: this is about connecting, not layout'));

const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const password = randomBytes(18).toString('base64url');

async function account(ctx: APIRequestContext, name: string) {
  const username = `ca_${name}_${run}`.slice(0, 30);
  const email = `${username}@a11y.example.test`;
  const res = await ctx.post('/api/v1/auth/register', { data: { email, password, username, displayName: name, birthDate: '1990-05-01', locale: 'en' } });
  expect(res.status(), await res.text()).toBe(201);
  await ctx.post('/api/v1/me/onboarding/complete', { data: {} });
  return { id: (await res.json()).user.id as string, email };
}

/** A browser that keeps hold of its connections, and counts the answers that reach it. */
async function device(browser: Browser, baseURL: string, email: string) {
  const ctx = await browser.newContext({ baseURL, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(() => {
    const Real = window.RTCPeerConnection;
    const made: RTCPeerConnection[] = [];
    (window as unknown as { made: RTCPeerConnection[] }).made = made;
    window.RTCPeerConnection = function (...args: ConstructorParameters<typeof Real>) {
      const pc = new Real(...args);
      made.push(pc);
      return pc;
    } as unknown as typeof RTCPeerConnection;
    window.RTCPeerConnection.prototype = Real.prototype;
  });
  expect((await ctx.request.post('/api/v1/auth/login', { data: { email, password } })).ok()).toBeTruthy();
  const page = await ctx.newPage();
  const answers: string[] = [];
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('call.signal') && f.payload.includes('"type":"answer"')) answers.push(f.payload);
    }),
  );
  return { page, answers };
}

const hearing = (page: Page) =>
  page.evaluate(async () => {
    const pc = (window as unknown as { made: RTCPeerConnection[] }).made.at(-1);
    if (pc?.connectionState !== 'connected') return 0;
    let bytes = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived;
    });
    return bytes;
  });

test('a call connects each way, on the device that answered', async ({ browser, baseURL }) => {
  const one = await request.newContext({ baseURL });
  const two = await request.newContext({ baseURL });
  const sam = await account(one, 'sam');
  const lea = await account(two, 'lea');
  expect((await one.post(`/api/v1/users/${lea.id}/follow`)).ok()).toBeTruthy();
  expect((await two.post(`/api/v1/users/${sam.id}/follow`)).ok()).toBeTruthy();
  const chat = (await (await one.post('/api/v1/conversations', { data: { memberIds: [lea.id] } })).json()).conversation.id as string;

  const samPhone = await device(browser, baseURL!, sam.email);
  const leaPhone = await device(browser, baseURL!, lea.email);
  const leaComputer = await device(browser, baseURL!, lea.email);
  await samPhone.page.goto(`/inbox/${chat}`);
  await leaPhone.page.goto('/home');
  await leaComputer.page.goto('/home');
  await expect(samPhone.page.getByRole('button', { name: 'Audio call' })).toBeVisible();
  await expect(leaPhone.page.getByRole('navigation').first()).toBeVisible();
  await expect(leaComputer.page.getByRole('navigation').first()).toBeVisible();

  // Sam calls. Both of Léa's devices ring, she answers on the phone, and the computer stops.
  await expect(async () => {
    await samPhone.page.getByRole('button', { name: 'Audio call' }).click();
    await expect(leaComputer.page.getByRole('button', { name: 'Answer' })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await leaPhone.page.getByRole('button', { name: 'Answer' }).click();
  await expect(leaComputer.page.getByRole('button', { name: 'Answer' })).toHaveCount(0);
  await expect.poll(() => hearing(samPhone.page), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => hearing(leaPhone.page), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(samPhone.answers).toHaveLength(1);

  // Hanging up ends it on both sides.
  await leaPhone.page.getByRole('button', { name: 'Hang up' }).click();
  await expect(samPhone.page.getByRole('button', { name: 'Hang up' })).toHaveCount(0);

  // The other way, with a picture.
  await leaPhone.page.goto(`/inbox/${chat}`);
  await expect(async () => {
    await leaPhone.page.getByRole('button', { name: 'Video call' }).click();
    await expect(samPhone.page.getByRole('button', { name: 'Answer' })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await samPhone.page.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => hearing(leaPhone.page), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => hearing(samPhone.page), { timeout: 20_000 }).toBeGreaterThan(0);
  await samPhone.page.getByRole('button', { name: 'Hang up' }).click();
  await expect(leaPhone.page.getByRole('button', { name: 'Hang up' })).toHaveCount(0);
});
