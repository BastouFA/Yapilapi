import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  chooseRadio,
  expectNoSeriousA11yViolations,
  registerViaApi,
  watchPage,
} from '../support/helpers';
import { WEB_URL } from '../support/env';

async function person(browser: Browser, opts: Parameters<typeof registerViaApi>[1] = {}) {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    locale: 'en-GB',
    timezoneId: 'Africa/Lagos',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const user = await registerViaApi(context.request, opts);
  return { context, page, user };
}
const suffix = () => Math.random().toString(36).slice(2, 8);
const log = (page: Page) => page.getByRole('log');

test.describe('communities', () => {
  test('create, join, post, channels with live chat, members, leave', async ({ browser }) => {
    const name = `Lagos Cooks ${suffix()}`;
    const a = await person(browser, { prefix: 'olu', displayName: 'Olu Owner' });
    const b = await person(browser, { prefix: 'ify', displayName: 'Ify Joiner' });
    const watchA = watchPage(a.page);
    const watchB = watchPage(b.page);

    await a.page.goto('/communities');
    await expect(a.page.getByRole('heading', { level: 1, name: 'Communities' })).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'communities (discover)');
    await a.page.getByTestId('create-community').click();
    await expect(
      a.page.getByRole('heading', { level: 1, name: 'Create a community' }),
    ).toBeVisible();
    await a.page.getByTestId('community-submit').click();
    await expect(
      a.page.getByText('Give the community a name of at least 3 characters.'),
    ).toBeVisible();
    await a.page.getByTestId('community-name').fill(name);
    await a.page
      .getByTestId('community-description')
      .fill('Recipes, markets and street food from Lagos.');
    await a.page.getByRole('group', { name: 'Topics' }).getByRole('checkbox').first().check();
    await a.page.getByRole('button', { name: 'Add a rule' }).click();
    await a.page.getByLabel('Rule 1 title').fill('Be kind');
    await a.page.getByLabel('Rule 1 details').fill('Cook with love, comment with care.');
    await expectNoSeriousA11yViolations(a.page, 'create community form');
    await a.page.getByTestId('community-submit').click();
    await expect(a.page).toHaveURL(/\/communities\/(?!new$)[a-z0-9-]+$/);
    await expect(a.page.getByRole('heading', { level: 1, name })).toBeVisible();
    const communityUrl = a.page.url();
    await expect(a.page.getByText('Owner', { exact: true }).first()).toBeVisible();

    // Post in the community.
    await expect(a.page.getByText('No posts yet')).toBeVisible();
    await a.page
      .getByTestId('community-post-body')
      .fill('Welcome, cooks! Share your best jollof tips.');
    await a.page.getByTestId('community-post-submit').click();
    await expect(a.page.getByRole('article').filter({ hasText: 'Welcome, cooks!' })).toBeVisible();
    await expect(
      a.page
        .getByRole('article')
        .filter({ hasText: 'Welcome, cooks!' })
        .getByText('Community', { exact: true }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'community with a post');

    // Channels: create, then open it.
    await a.page.getByRole('tab', { name: 'Channels' }).click();
    // Every community starts with a general channel.
    await expect(a.page.getByTestId('channel-link')).toHaveCount(1);
    await a.page.getByTestId('channel-name').fill('Not Valid!');
    await a.page.getByTestId('channel-create').click();
    await expect(
      a.page.getByRole('tabpanel').getByText(/lowercase letters, numbers or hyphens/i),
    ).toBeVisible();
    await a.page.getByTestId('channel-name').fill('announcements');
    await a.page.getByTestId('channel-create').click();
    await expect(a.page.getByTestId('channel-link')).toHaveCount(2);
    await a.page.getByTestId('channel-link').first().click();
    await expect(a.page.getByRole('heading', { level: 1, name: '#general' })).toBeVisible();
    await expect(a.page.getByText(`Channel of ${name}`)).toBeVisible();
    await a.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Channel is open');
    await a.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(log(a.page).getByText('Channel is open')).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'channel chat');

    // Ify finds it via search and joins.
    await b.page.goto('/communities');
    await b.page.getByTestId('community-search').fill(name);
    const card = b.page.getByTestId('community-card').filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Anyone can join');
    await card.getByRole('link', { name }).click();
    await expect(b.page.getByRole('heading', { level: 1, name })).toBeVisible();
    await b.page.getByTestId('join-community').click();
    await expect(b.page.getByTestId('leave-community')).toBeVisible();
    await expect(b.page.getByRole('article').filter({ hasText: 'Welcome, cooks!' })).toBeVisible();
    await b.page.getByTestId('community-post-body').fill('Try a bit of smoky pepper!');
    await b.page.getByTestId('community-post-submit').click();
    await expect(b.page.getByRole('article').filter({ hasText: 'smoky pepper' })).toBeVisible();

    // Live channel chat both ways.
    await b.page.getByRole('tab', { name: 'Channels' }).click();
    await b.page.getByTestId('channel-link').first().click();
    await expect(log(b.page).getByText('Channel is open')).toBeVisible();
    await b.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello from Ify');
    await b.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(log(a.page).getByText('Hello from Ify')).toBeVisible();
    await a.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Welcome Ify');
    await a.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(log(b.page).getByText('Welcome Ify')).toBeVisible();

    // Members list, then Ify leaves (confirmation) and can join again.
    await a.page.goto(communityUrl);
    await a.page.getByRole('tab', { name: 'Members' }).click();
    const members = a.page.getByRole('list', { name: 'Community members' });
    await expect(members.getByText('Ify Joiner')).toBeVisible();
    await expect(members.getByText('Olu Owner')).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'community members');
    await a.page.getByRole('tab', { name: 'About' }).click();
    await expect(a.page.getByText('Be kind')).toBeVisible();
    await expect(a.page.getByText('Cook with love, comment with care.')).toBeVisible();

    await b.page.goto(communityUrl);
    await b.page.getByTestId('leave-community').click();
    await b.page.getByRole('dialog').getByRole('button', { name: 'Leave' }).click();
    await expect(b.page.getByTestId('join-community')).toBeVisible();

    watchA.assertClean();
    watchB.assertClean();
    await a.context.close();
    await b.context.close();
  });

  test('private communities: summary for outsiders, request to join, approval by a manager', async ({
    browser,
  }) => {
    const name = `Book Club ${suffix()}`;
    const a = await person(browser, { prefix: 'ngozi', displayName: 'Ngozi Owner' });
    const b = await person(browser, { prefix: 'tunde', displayName: 'Tunde Requester' });
    const watch = watchPage(b.page);

    await a.page.goto('/communities/new');
    await a.page.getByTestId('community-name').fill(name);
    await chooseRadio(a.page, 'Who can see it', 'Private');
    await expect(a.page.getByRole('radio', { name: 'By request' })).toBeChecked();
    await expect(a.page.getByRole('radio', { name: 'Anyone' })).toBeDisabled();
    await a.page.getByTestId('community-submit').click();
    await expect(a.page).toHaveURL(/\/communities\/(?!new$)[a-z0-9-]+$/);
    await expect(a.page.getByRole('heading', { level: 1, name })).toBeVisible();
    const url = a.page.url();

    // An outsider sees only the summary and can ask to join.
    await b.page.goto(url);
    await expect(b.page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(b.page.getByRole('heading', { name: 'Join to see what is inside' })).toBeVisible();
    await expect(b.page.getByRole('tab', { name: 'Posts' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(b.page, 'private community summary');
    await b.page.getByTestId('join-community').click();
    await expect(b.page.getByText('Your request to join is waiting for approval.')).toBeVisible();
    await expect(b.page.getByRole('button', { name: 'Request sent' })).toBeDisabled();

    // The owner approves it.
    await a.page.reload();
    await a.page.getByRole('tab', { name: 'Members' }).click();
    const pending = a.page.getByRole('list', { name: 'Waiting for approval' });
    await expect(pending.getByText('Tunde Requester')).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'pending requests');
    await a.page.getByTestId('approve-request').click();
    await expect(a.page.getByRole('list', { name: 'Waiting for approval' })).toHaveCount(0);
    await expect(
      a.page.getByRole('list', { name: 'Community members' }).getByText('Tunde Requester'),
    ).toBeVisible();

    await b.page.reload();
    await expect(b.page.getByTestId('leave-community')).toBeVisible();
    await expect(b.page.getByRole('tab', { name: 'Posts' })).toBeVisible();
    watch.assertClean();
    await a.context.close();
    await b.context.close();
  });

  test('accounts under 18 can only create private communities', async ({ browser }) => {
    const t = await person(browser, { prefix: 'teen', displayName: 'Teen Maker', age: 15 });
    await t.page.goto('/communities/new');
    await expect(t.page.getByRole('radio', { name: 'Private' })).toBeChecked();
    await expect(t.page.getByRole('radio', { name: 'Public' })).toBeDisabled();
    await expect(t.page.getByRole('radio', { name: 'Secret' })).toBeDisabled();
    await t.page.getByTestId('community-name').fill(`Teen Club ${suffix()}`);
    await t.page.getByTestId('community-submit').click();
    await expect(t.page).toHaveURL(/\/communities\/(?!new$)[a-z0-9-]+$/);
    await expect(t.page.getByText('Private', { exact: true }).first()).toBeVisible();
    await t.context.close();
  });
});
