import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_LOG, API_URL, WEB_URL } from './env';

export const PASSWORD = 'correct horse battery staple 42';
const unsafeHeaders = { origin: WEB_URL, 'x-yl-csrf': '1' };

export interface TestUser {
  email: string;
  username: string;
  displayName: string;
  password: string;
  id: string;
}

const unique = () => randomBytes(4).toString('hex');

/** Date of birth for someone who is `years` old today. */
export function birthDateFor(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 3);
  return d.toISOString().slice(0, 10);
}

/**
 * Create an account through the real API. When `request` is a browser context's request fixture the session cookie lands
 * in that browser context, so the page is signed in.
 */
export async function registerViaApi(
  request: APIRequestContext,
  opts: { prefix?: string; age?: number; onboard?: boolean; displayName?: string } = {},
): Promise<TestUser> {
  const id = unique();
  const username = `${opts.prefix ?? 'user'}_${id}`;
  const email = `${username}@example.test`;
  const displayName = opts.displayName ?? `Test ${username}`;
  const res = await request.post(`${API_URL}/v1/auth/register`, {
    headers: unsafeHeaders,
    data: {
      email,
      password: PASSWORD,
      username,
      displayName,
      birthDate: birthDateFor(opts.age ?? 30),
      acceptTerms: true,
      timezone: 'Africa/Lagos',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  if (opts.onboard !== false) {
    const done = await request.post(`${API_URL}/v1/profile/onboarding/complete`, {
      headers: unsafeHeaders,
    });
    expect(done.ok()).toBeTruthy();
  }
  return { email, username, displayName, password: PASSWORD, id: body.user.id };
}

/** POST/PUT/… to the API as the signed-in user of `request`. */
export async function api<T = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await request.fetch(`${API_URL}${path}`, {
    method,
    headers: method === 'GET' ? {} : unsafeHeaders,
    ...(data !== undefined ? { data } : {}),
  });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : undefined) as T };
}

/** Sign in through the real login form. */
export async function loginViaUi(
  page: Page,
  u: Pick<TestUser, 'email' | 'password'>,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(u.email);
  await page.getByLabel(/^Password(\s\(required\))?$/).fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The console email adapter prints message text (with links) to the API log. Poll it for a link sent to `email`. */
export async function linkFromEmailLog(
  email: string,
  path: '/verify-email' | '/reset-password',
): Promise<string> {
  const re = new RegExp(
    `${WEB_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path}\\?token=[A-Za-z0-9_-]+`,
  );
  let link: string | undefined;
  await expect
    .poll(
      () => {
        const lines = readFileSync(API_LOG, 'utf8')
          .split('\n')
          .filter((l) => l.includes(`to=${email}`) && l.includes(path));
        const last = lines[lines.length - 1];
        link = last?.match(re)?.[0];
        return link ?? null;
      },
      { message: `no ${path} link logged for ${email}`, timeout: 15_000 },
    )
    .not.toBeNull();
  return link!;
}

// ---------------------------------------------------------------- RFC 6238 TOTP (SHA-1, 6 digits, 30 s)
function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

// ---------------------------------------------------------------- accessibility & CSP
export async function expectNoSeriousA11yViolations(
  page: Page,
  label: string,
  opts: { exclude?: string[] } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page: page as never }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
    'best-practice',
  ]);
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel);
  const { violations } = await builder.analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = serious
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n   ${v.nodes
          .slice(0, 3)
          .map(
            (n) =>
              n.target.join(' ') +
              ' :: ' +
              (n.failureSummary ?? '').split('\n').slice(0, 2).join(' | '),
          )
          .join('\n   ')}`,
    )
    .join('\n');
  if (serious.length) console.log(`AXE|${label}|${report.replace(/\n/g, '\nAXE|')}`);
  expect(serious, `${label}: axe found serious/critical violations\n${report}`).toEqual([]);
}

/** Collect CSP violations and uncaught page errors; call `assertClean()` at the end of a test. */
export function watchPage(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    const text = m.text();
    if (/content security policy|refused to (load|execute|connect|apply)/i.test(text))
      problems.push(`CSP: ${text}`);
    if (m.type() === 'error' && /hydration|did not match|minified react error/i.test(text))
      problems.push(`React: ${text}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return { assertClean: () => expect(problems, problems.join('\n')).toEqual([]) };
}

/** Pick an option in a "card" radio group by clicking its visible label (the card's label overlays the input). */
export async function chooseRadio(
  page: Page,
  group: string | RegExp,
  option: string,
): Promise<void> {
  const g = page.getByRole('group', { name: group });
  await g.getByText(option, { exact: true }).click();
  await expect(g.getByRole('radio', { name: option })).toBeChecked();
}
