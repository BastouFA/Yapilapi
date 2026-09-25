import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, expectNoSeriousA11yViolations, registerViaApi, watchPage } from '../support/helpers';
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

const log = (page: Page) => page.getByRole('log');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('messaging', () => {
  test('two people chat in realtime: unread badge, seen, typing, replies, reactions, delete, retry', async ({
    browser,
  }) => {
    const a = await person(browser, { prefix: 'ada', displayName: 'Ada Sender' });
    const b = await person(browser, { prefix: 'bee', displayName: 'Bee Receiver' });
    const watchA = watchPage(a.page);
    const watchB = watchPage(b.page);

    // Bee is already looking at her inbox (empty) when Ada writes.
    await b.page.goto('/inbox');
    await expect(b.page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible();
    await expect(b.page.getByText('No conversations yet')).toBeVisible();
    await expectNoSeriousA11yViolations(b.page, 'inbox (empty)');

    await a.page.goto('/inbox');
    await a.page.getByTestId('new-message').click();
    await expect(a.page.getByRole('dialog', { name: 'New message' })).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'new message dialog');
    await a.page.getByLabel('Username').fill('nobody_here_zz');
    await a.page.getByTestId('dm-start').click();
    await expect(a.page.getByText('We could not find a person with that username.')).toBeVisible();
    await a.page.getByLabel('Username').fill(`@${b.user.username}`);
    await a.page.getByTestId('dm-start').click();
    await expect(a.page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    await expect(a.page.getByRole('heading', { level: 1, name: 'Bee Receiver' })).toBeVisible();
    await expect(log(a.page).getByText('No messages yet. Say hello.')).toBeVisible();

    await send(a.page, 'Hello Bee, are you there?');
    await expect(log(a.page).getByText('Hello Bee, are you there?')).toBeVisible();

    // Bee gets it live: the row and the unread badge appear without reloading.
    await expect(b.page.getByRole('link', { name: /Ada Sender/ })).toContainText(
      'Hello Bee, are you there?',
    );
    await expect(b.page.getByRole('link', { name: 'Inbox, 1 unread message' })).toBeVisible();
    await b.page.getByRole('link', { name: /Ada Sender/ }).click();
    await expect(log(b.page).getByText('Hello Bee, are you there?')).toBeVisible();
    await expect(b.page.getByRole('link', { name: /^Inbox$/ }).first()).toBeVisible(); // badge cleared after reading
    await expectNoSeriousA11yViolations(b.page, 'chat');

    // Ada sees "Seen" once Bee has opened it.
    await expect(a.page.getByTestId('seen')).toHaveText('Seen');

    // Typing indicator both ways.
    await composer(b.page).pressSequentially('on my way', { delay: 20 });
    await expect(a.page.getByTestId('typing')).toHaveText('Bee Receiver is typing');
    await send(b.page, 'Yes, I am here.');
    await expect(log(a.page).getByText('Yes, I am here.')).toBeVisible();
    await expect(a.page.getByTestId('typing')).toHaveCount(0);

    // Ada replies to Bee's message; Bee sees the quote.
    const beeMsg = a.page.locator('[data-message-id]').filter({ hasText: 'Yes, I am here.' });
    await beeMsg.hover();
    await beeMsg.getByRole('button', { name: 'Reply' }).click();
    await expect(a.page.getByText('Replying to Bee Receiver')).toBeVisible();
    await send(a.page, 'Great, quoting you.');
    await expect(
      b.page
        .locator('[data-message-id]')
        .filter({ hasText: 'Great, quoting you.' })
        .getByText('Yes, I am here.'),
    ).toBeVisible();

    // Bee reacts to Ada's first message; Ada sees the chip live and can toggle her own reaction.
    const first = b.page
      .locator('[data-message-id]')
      .filter({ hasText: 'Hello Bee, are you there?' });
    await first.hover();
    await first.getByRole('button', { name: 'React' }).click();
    await b.page.getByRole('menuitemradio', { name: 'Love' }).click();
    await expect(first.getByRole('button', { name: 'Love, 1 person' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      a.page
        .locator('[data-message-id]')
        .filter({ hasText: 'Hello Bee, are you there?' })
        .getByRole('button', { name: 'Love, 1 person' }),
    ).toBeVisible();
    await first.getByRole('button', { name: 'Love, 1 person' }).click();
    await expect(first.getByRole('button', { name: /Love/ })).toHaveCount(0);
    await expect(a.page.getByRole('button', { name: /Love/ })).toHaveCount(0);
    await expectNoSeriousA11yViolations(a.page, 'chat with reply');

    // Delete for everyone needs a confirmation and shows a tombstone on both sides.
    const own = a.page.locator('[data-message-id]').filter({ hasText: 'Great, quoting you.' });
    await own.hover();
    await own.getByRole('button', { name: 'Message options' }).click();
    await a.page.getByRole('menuitem', { name: 'Delete message' }).click();
    await a.page
      .getByRole('dialog', { name: 'Delete this message?' })
      .getByRole('button', { name: 'Delete message' })
      .click();
    await expect(a.page.getByText('This message was deleted')).toBeVisible();
    await expect(b.page.getByText('This message was deleted')).toBeVisible();

    // A failed send stays visible, can be retried, and is never duplicated.
    await a.page.route('**/v1/conversations/*/messages', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.continue(),
    );
    await send(a.page, 'This one fails first');
    await expect(a.page.getByText('Not sent', { exact: true })).toBeVisible();
    await a.page.unroute('**/v1/conversations/*/messages');
    await a.page.getByRole('button', { name: 'Retry' }).click();
    await expect(a.page.getByText('Not sent', { exact: true })).toHaveCount(0);
    await expect(log(b.page).getByText('This one fails first')).toHaveCount(1);
    await expect(log(a.page).getByText('This one fails first')).toHaveCount(1);

    // It survives a reload (real history), newest last.
    await a.page.reload();
    await expect(log(a.page).getByText('This one fails first')).toBeVisible();
    await expect(a.page.locator('[data-message-id]').last()).toContainText('This one fails first');

    watchA.assertClean();
    watchB.assertClean();
    await a.context.close();
    await b.context.close();
  });

  test('groups: create, live delivery to members, rename, add, leave; message from a profile', async ({
    browser,
  }) => {
    const a = await person(browser, { prefix: 'gina', displayName: 'Gina Group' });
    const b = await person(browser, { prefix: 'ben', displayName: 'Ben Member' });
    const c = await person(browser, { prefix: 'cy', displayName: 'Cy Later' });
    const watch = watchPage(a.page);

    // Gina and Ben are friends, so Ben shows up as a pick in the group dialog.
    expect(
      (await api(a.context.request, 'POST', '/v1/friends/requests', { username: b.user.username }))
        .status,
    ).toBeLessThan(300);
    expect(
      (await api(b.context.request, 'POST', `/v1/friends/requests/${a.user.id}/accept`)).status,
    ).toBeLessThan(300);

    await b.page.goto('/inbox');
    await a.page.goto('/inbox');
    await a.page.getByTestId('new-group').click();
    const dialog = a.page.getByRole('dialog', { name: 'New group' });
    await dialog.getByTestId('group-create').click();
    await expect(dialog.getByRole('alert')).toContainText('Give the group a name');
    await dialog.getByLabel(/^Group name/).fill('Weekend plans');
    await dialog.getByTestId('group-create').click();
    await expect(dialog.getByRole('alert')).toContainText('Add at least one other person');
    await dialog.getByRole('checkbox', { name: /Ben Member/ }).check();
    await expectNoSeriousA11yViolations(a.page, 'new group dialog');
    await dialog.getByLabel('Add someone by username').fill(c.user.username);
    await dialog.getByTestId('picker-add').click();
    await expect(
      dialog.getByRole('list', { name: 'People in this group' }).getByText('Cy Later'),
    ).toBeVisible();
    await dialog.getByTestId('group-create').click();
    await expect(a.page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    await expect(a.page.getByRole('heading', { level: 1, name: 'Weekend plans' })).toBeVisible();

    await send(a.page, 'Who is in for Saturday?');
    // Ben sees the new group appear live; open it and answer. Cy (not yet looking) sees it after loading.
    await expect(b.page.getByRole('link', { name: /Weekend plans/ })).toContainText(
      'Who is in for Saturday?',
    );
    await b.page.getByRole('link', { name: /Weekend plans/ }).click();
    await expect(log(b.page).getByText('Who is in for Saturday?')).toBeVisible();
    await expect(log(b.page).getByRole('link', { name: 'Gina Group' })).toBeVisible(); // sender names in groups
    await send(b.page, 'Count me in');
    await expect(log(a.page).getByText('Count me in')).toBeVisible();

    await c.page.goto('/inbox');
    await expect(c.page.getByRole('link', { name: /Weekend plans/ })).toContainText('Count me in');

    // Details: rename, mute, member list.
    await a.page.getByTestId('chat-details').click();
    const details = a.page.getByRole('dialog', { name: 'Details' });
    await expect(details.getByRole('list').getByText('Cy Later')).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'group details');
    await details.getByTestId('detail-title').fill('Saturday plans');
    await details.getByRole('button', { name: 'Save name' }).click();
    await expect(a.page.getByRole('heading', { level: 1, name: 'Saturday plans' })).toBeVisible();
    await details.getByText('Mute this conversation', { exact: true }).click();
    await expect(details.getByRole('switch', { name: 'Mute this conversation' })).toBeChecked();
    await details.getByRole('button', { name: 'Done' }).click();
    await expect(a.page.getByRole('link', { name: /Saturday plans/ }).first()).toContainText(
      'Muted',
    );
    // Ben's list follows the rename live.
    await expect(b.page.getByRole('heading', { level: 1, name: 'Saturday plans' })).toBeVisible();

    // Cy leaves; Gina no longer sees Cy in the members.
    await c.page.getByRole('link', { name: /Saturday plans/ }).click();
    await c.page.getByTestId('chat-details').click();
    await c.page.getByTestId('leave-group').click();
    await c.page
      .getByRole('dialog', { name: 'Leave this group?' })
      .getByRole('button', { name: 'Leave group' })
      .click();
    await expect(c.page).toHaveURL(/\/inbox$/);
    await expect(c.page.getByRole('link', { name: /Saturday plans/ })).toHaveCount(0);

    // Message straight from a profile.
    await a.page.goto(`/u/${c.user.username}`);
    await a.page.getByTestId('message-btn').click();
    await expect(a.page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    await expect(a.page.getByRole('heading', { level: 1, name: 'Cy Later' })).toBeVisible();

    watch.assertClean();
    await a.context.close();
    await b.context.close();
    await c.context.close();
  });

  test('accounts under 18 can only message accepted friends, with a clear explanation', async ({
    browser,
  }) => {
    const adult = await person(browser, { prefix: 'adult', displayName: 'Adult Person' });
    const teen = await person(browser, { prefix: 'teen', displayName: 'Teen Person', age: 15 });

    await adult.page.goto(`/u/${teen.user.username}`);
    await adult.page.getByTestId('message-btn').click();
    await expect(
      adult.page.getByText('Accounts for people under 18 can only message accepted friends.'),
    ).toBeVisible();
    await expect(adult.page).toHaveURL(/\/u\//);

    // Same through the new-message dialog.
    await adult.page.goto('/inbox');
    await adult.page.getByTestId('new-message').click();
    await adult.page.getByLabel('Username').fill(teen.user.username);
    await adult.page.getByTestId('dm-start').click();
    await expect(adult.page.getByRole('dialog').getByRole('alert')).toContainText(
      'under 18 can only message accepted friends',
    );
    await adult.page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    // After they become friends it works.
    const req = await api(teen.context.request, 'POST', '/v1/friends/requests', {
      username: adult.user.username,
    });
    expect(req.status, JSON.stringify(req.body)).toBeLessThan(300);
    expect(
      (await api(adult.context.request, 'POST', `/v1/friends/requests/${teen.user.id}/accept`))
        .status,
    ).toBeLessThan(300);
    await adult.page.goto(`/u/${teen.user.username}`);
    await adult.page.getByTestId('message-btn').click();
    await expect(adult.page.getByRole('heading', { level: 1, name: 'Teen Person' })).toBeVisible();
    await send(adult.page, 'Hi, welcome to the friend list');
    await teen.page.goto('/inbox');
    await expect(teen.page.getByRole('link', { name: /Adult Person/ })).toContainText(
      'Hi, welcome to the friend list',
    );
    await expectNoSeriousA11yViolations(teen.page, 'teen inbox');
    await adult.context.close();
    await teen.context.close();
  });
});
