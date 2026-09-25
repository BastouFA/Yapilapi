import { expect, test, type Browser } from '@playwright/test';
import {
  api,
  chooseRadio,
  expectNoSeriousA11yViolations,
  registerViaApi,
  watchPage,
  type TestUser,
} from '../support/helpers';
import { WEB_URL } from '../support/env';

async function signedInContext(browser: Browser, opts: Parameters<typeof registerViaApi>[1] = {}) {
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

test.describe('posting, feeds and reactions', () => {
  test('write a public post, see it in Following, react, comment, save, delete', async ({
    browser,
  }) => {
    const { context, page, user } = await signedInContext(browser, {
      prefix: 'poster',
      displayName: 'Pia Poster',
    });
    const watch = watchPage(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'home (empty)');

    // Nothing yet: the empty state explains what to do.
    await page.getByRole('tab', { name: 'Following' }).click();
    await expect(page.getByRole('heading', { name: /not seeing any posts/i })).toBeVisible();

    await page.getByTestId('nav-create').first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Create a post' })).toBeFocused();
    await expectNoSeriousA11yViolations(page, 'create');
    await page
      .getByLabel('What would you like to say?')
      .fill('Hello from the *first* post. https://example.com/a');
    await chooseRadio(page, 'Who can see this?', 'Public');
    await page.getByRole('button', { name: 'Post', exact: true }).click();

    await expect(page).toHaveURL(/\/post\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Pia Poster');
    await expect(page.getByText('Hello from the *first* post.')).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'post detail');
    const postUrl = page.url();

    // React on the detail page; the count survives a reload (real API state).
    await page.getByRole('button', { name: /^Like, 0 likes/ }).click();
    await expect(page.getByRole('button', { name: /^Like, 1 like/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.reload();
    await expect(page.getByRole('button', { name: /^Like, 1 like/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Comment and reply.
    await page.getByLabel('Write a comment').first().fill('First comment!');
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.getByText('First comment!')).toBeVisible();
    await page.getByRole('button', { name: /Reply/ }).first().click();
    await page.getByLabel(/Reply to/).fill('A reply to myself');
    await page.getByRole('button', { name: 'Post comment' }).last().click();
    await expect(page.getByText('A reply to myself')).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'post detail with comments');

    // Save it, then find it on the Saved page and in the Following feed.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved to your list')).toBeVisible();
    await page.goto('/saved');
    await expect(page.getByText('Hello from the *first* post.')).toBeVisible();
    await page.goto('/');
    await page.getByRole('tab', { name: 'Following' }).click();
    const card = page.getByRole('article').filter({ hasText: 'Hello from the *first* post.' });
    await expect(card).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'home with a post');

    // Delete needs a confirmation.
    await page.goto(postUrl);
    await page.getByRole('button', { name: 'More actions for this post' }).click();
    await page.getByRole('menuitem', { name: 'Delete post' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete this post?' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL('/');
    await page.getByRole('tab', { name: 'Following' }).click();
    await expect(page.getByText('Hello from the *first* post.')).toHaveCount(0);
    void user;
    watch.assertClean();
    await context.close();
  });

  test('a poll, topics, and a second person following and reacting', async ({ browser }) => {
    const a = await signedInContext(browser, { prefix: 'alice', displayName: 'Alice Author' });
    const b = await signedInContext(browser, { prefix: 'bob', displayName: 'Bob Reader' });
    const watchB = watchPage(b.page);

    // Alice publishes a public post with a poll and a topic through the real composer.
    const topics = await api<{ items: Array<{ slug: string; name: string }> }>(
      a.context.request,
      'GET',
      '/v1/topics',
    );
    expect(topics.body.items.length).toBeGreaterThan(0);
    const topic = topics.body.items[0]!;
    await a.page.goto('/create');
    await a.page.getByLabel('What would you like to say?').fill('Which snack wins?');
    await chooseRadio(a.page, 'Who can see this?', 'Public');
    await a.page.getByLabel(topic.name).check();
    await a.page.getByRole('switch', { name: 'Add a poll' }).check();
    await a.page.getByLabel('Poll question').fill('Pick one');
    await a.page.getByLabel('Option 1').fill('Plantain chips');
    await a.page.getByLabel('Option 2').fill('Chin chin');
    await a.page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(a.page).toHaveURL(/\/post\//);

    // Bob finds Alice by profile, follows her, and sees her post in Following and For You.
    await b.page.goto(`/u/${a.user.username}`);
    await expect(b.page.getByRole('heading', { level: 1, name: 'Alice Author' })).toBeVisible();
    await expectNoSeriousA11yViolations(b.page, 'profile (other)');
    await b.page.getByTestId('follow-btn').click();
    await expect(b.page.getByTestId('follow-btn')).toHaveText('Following');
    await expect(b.page.getByText('1 followers')).toBeVisible();
    await expect(
      b.page.getByRole('article').filter({ hasText: 'Which snack wins?' }),
    ).toBeVisible();

    await b.page.goto('/');
    await b.page.getByRole('tab', { name: 'Following' }).click();
    const card = b.page.getByRole('article').filter({ hasText: 'Which snack wins?' });
    await expect(card).toBeVisible();
    await card.getByRole('radio', { name: 'Chin chin' }).check();
    await card.getByRole('button', { name: 'Vote' }).click();
    await expect(card.getByText('1 vote')).toBeVisible();

    // The explanation for a For You post comes from the API.
    await b.page.getByRole('tab', { name: 'For You' }).click();
    const fyCard = b.page.getByRole('article').filter({ hasText: 'Which snack wins?' });
    await expect(fyCard).toBeVisible();
    await fyCard.getByRole('button', { name: 'Why am I seeing this?' }).click();
    await expect(
      b.page.getByRole('dialog').or(b.page.getByRole('region', { name: /Why you are seeing/ })),
    ).toBeVisible();
    await expect(b.page.getByText(`You follow @${a.user.username}`)).toBeVisible();
    await b.page.keyboard.press('Escape');

    // Alice sees Bob in her followers list.
    await a.page.goto(`/u/${a.user.username}`);
    await a.page.getByRole('button', { name: /followers/ }).click();
    await expect(a.page.getByRole('dialog').getByText(`@${b.user.username}`)).toBeVisible();
    await expectNoSeriousA11yViolations(a.page, 'followers dialog');

    // Topic discovery uses the custom feed.
    await b.page.goto('/discover');
    await b.page.getByRole('button', { name: topic.name, exact: true }).click();
    await expect(
      b.page.getByRole('article').filter({ hasText: 'Which snack wins?' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(b.page, 'discover');
    watchB.assertClean();
    await a.context.close();
    await b.context.close();
  });

  test('private accounts: follow request, approval, and blocking', async ({ browser }) => {
    const owner = await signedInContext(browser, { prefix: 'priv', displayName: 'Private Pat' });
    const fan = await signedInContext(browser, { prefix: 'fan', displayName: 'Fan Fred' });
    await api(owner.context.request, 'PATCH', '/v1/profile', { isPrivate: true });
    await api(owner.context.request, 'POST', '/v1/posts', {
      body: 'Secret garden update',
      visibility: 'followers',
    });

    await fan.page.goto(`/u/${owner.user.username}`);
    await expect(fan.page.getByText('This account is private').first()).toBeVisible();
    await expect(fan.page.getByText('Secret garden update')).toHaveCount(0);
    await fan.page.getByTestId('follow-btn').click();
    await expect(fan.page.getByTestId('follow-btn')).toHaveText('Cancel request');

    await owner.page.goto('/settings/connections');
    await expect(
      owner.page.getByRole('heading', { level: 3, name: 'Follow requests' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(owner.page, 'settings connections');
    await owner.page.getByTestId(`approve-${fan.user.username}`).click();
    await expect(owner.page.getByText('No pending follow requests.')).toBeVisible();

    await fan.page.reload();
    await expect(fan.page.getByText('Secret garden update')).toBeVisible();

    // Block: the blocked person can no longer see the profile.
    await owner.page.goto(`/u/${fan.user.username}`);
    await owner.page.getByRole('button', { name: 'More actions for this profile' }).click();
    await owner.page.getByRole('menuitem', { name: 'Block' }).click();
    await owner.page.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
    await expect(owner.page.getByText(`Blocked @${fan.user.username}.`)).toBeVisible();
    await fan.page.goto(`/u/${owner.user.username}`);
    await expect(fan.page.getByRole('heading', { name: 'No such profile' })).toBeVisible();
    await owner.context.close();
    await fan.context.close();
  });

  test('a teen account cannot post publicly and is private', async ({ browser }) => {
    const teen = await signedInContext(browser, { prefix: 'teen', age: 15 });
    await teen.page.goto('/create');
    await expect(
      teen.page.getByText('Because you are under 18, posts cannot be public.'),
    ).toBeVisible();
    await expect(teen.page.getByRole('radio', { name: 'Public' })).toBeDisabled();
    await teen.page.goto('/settings/privacy');
    await expect(teen.page.getByRole('switch', { name: 'Private account' })).toBeChecked();
    await expect(teen.page.getByRole('switch', { name: 'Private account' })).toBeDisabled();
    await teen.context.close();
  });
});
void (null as unknown as TestUser);
