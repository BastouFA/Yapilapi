import { expect, test } from '@playwright/test';
import { api, expectNoSeriousA11yViolations, registerViaApi, watchPage } from '../support/helpers';

test.describe('AI assistant drafts', () => {
  test('a drafted post is never published until the person explicitly confirms it, and editing it first carries through', async ({
    page,
    context,
  }) => {
    const user = await registerViaApi(context.request, { prefix: 'aidraft' });
    const watch = watchPage(page);
    const myPosts = () =>
      api<{ items: Array<{ body: string }> }>(
        context.request,
        'GET',
        `/v1/users/${user.username}/posts`,
      );

    const before = await myPosts();

    await page.goto('/ai');
    await expect(page.getByRole('heading', { level: 1, name: 'Assistant' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'ai chat (empty)');

    // Ask the assistant to draft a post: this only creates a draft artifact, never a real post.
    await page.getByTestId('ai-composer').fill('Write a post about my first marathon');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const draft = page.getByTestId('ai-artifact');
    await expect(draft).toBeVisible();
    await expect(draft.getByText('Post draft')).toBeVisible();
    await expect(draft.getByText(/marathon/i)).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'ai chat (with draft)');

    // Nothing is posted yet.
    const afterDraft = await myPosts();
    expect(afterDraft.body.items.length).toBe(before.body.items.length);

    // Edit the draft before applying it.
    await draft.getByRole('button', { name: 'Edit' }).click();
    const editedBody = 'I finally ran my first marathon and I am so tired, edited by me.';
    await draft.getByRole('textbox').fill(editedBody);
    await draft.getByRole('button', { name: 'Save edit' }).click();
    await expect(draft.getByText('Edited by you')).toBeVisible();

    // Clicking "Confirm and apply" only opens the explicit confirmation dialog; it must not publish yet.
    await draft.getByRole('button', { name: 'Confirm and apply' }).click();
    const dialog = page.getByRole('dialog', { name: 'Apply this draft?' });
    await expect(dialog).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'ai chat (confirm dialog open)');

    const stillBefore = await myPosts();
    expect(stillBefore.body.items.length).toBe(before.body.items.length);

    // Only the dialog's own confirm button performs the real action.
    await dialog.getByRole('button', { name: 'Confirm and apply' }).click();
    await expect(page.getByText('Published as a post.')).toBeVisible();
    await expect(draft.getByText('Confirmed')).toBeVisible();

    const after = await myPosts();
    expect(after.body.items.length).toBe(before.body.items.length + 1);
    expect(after.body.items.some((p) => p.body === editedBody)).toBe(true);

    // A second click on the (now-inert) draft cannot double-publish: the card no longer offers confirm/discard.
    await expect(draft.getByRole('button', { name: 'Confirm and apply' })).toHaveCount(0);
    await expect(draft.getByRole('button', { name: 'Discard' })).toHaveCount(0);

    watch.assertClean();
  });
});
