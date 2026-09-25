import { expect, test, type Browser } from '@playwright/test';
import { api, expectNoSeriousA11yViolations, registerViaApi, watchPage } from '../support/helpers';
import { WEB_URL } from '../support/env';

async function signedInContext(browser: Browser, opts: Parameters<typeof registerViaApi>[1] = {}) {
  const context = await browser.newContext({ baseURL: WEB_URL, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const user = await registerViaApi(context.request, opts);
  return { context, page, user };
}

test.describe('commerce', () => {
  test('browse, buy with a dev payment-method token, and see the order paid on both sides', async ({
    browser,
  }) => {
    const seller = await signedInContext(browser, {
      prefix: 'clseller',
      displayName: 'Sana Seller',
    });
    const buyer = await signedInContext(browser, { prefix: 'clbuyer', displayName: 'Bo Buyer' });
    const watch = watchPage(buyer.page);

    const title = `Handmade mug ${Date.now().toString(36)}`;
    const created = await api<{ id: string }>(seller.context.request, 'POST', '/v1/products', {
      kind: 'physical',
      title,
      description: 'A nice mug, thrown by hand.',
      priceCents: 2500,
      currency: 'USD',
      stock: 5,
      status: 'active',
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const productId = created.body.id;

    // Browse and find the product.
    await buyer.page.goto('/shop');
    await expect(buyer.page.getByRole('heading', { level: 1, name: 'Shop' })).toBeVisible();
    await expectNoSeriousA11yViolations(buyer.page, 'shop (browse)');
    await buyer.page.getByLabel('Search products').fill(title);
    await buyer.page.getByRole('button', { name: 'Search' }).click();
    await expect(buyer.page.getByRole('link', { name: title })).toBeVisible();

    // Product detail: no raw card fields anywhere on this page.
    await buyer.page.getByRole('link', { name: title }).click();
    await expect(buyer.page).toHaveURL(new RegExp(`/shop/${productId}$`));
    await expect(buyer.page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(buyer.page.getByLabel(/card number/i)).toHaveCount(0);
    await expectNoSeriousA11yViolations(buyer.page, 'product detail');

    // Checkout: shipping address + a dev payment-method token, never a card form.
    await buyer.page.getByRole('button', { name: 'Buy now' }).click();
    await expect(buyer.page).toHaveURL(new RegExp(`/shop/checkout/${productId}$`));
    await expect(buyer.page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
    await expect(buyer.page.getByLabel(/card number/i)).toHaveCount(0);
    await expect(buyer.page.getByLabel(/cvv|security code/i)).toHaveCount(0);
    await expectNoSeriousA11yViolations(buyer.page, 'checkout');

    await buyer.page.getByLabel('Full name').fill('Bo Buyer');
    await buyer.page.getByLabel('Address line 1').fill('1 River Road');
    await buyer.page.getByLabel('City').fill('Lagos');
    await buyer.page.getByLabel('Postal code').fill('100001');
    await buyer.page.getByLabel('Country (2-letter code)').fill('NG');
    await expect(buyer.page.getByLabel('Payment method')).toHaveValue('tok_success');
    await buyer.page.getByRole('button', { name: 'Place order' }).click();

    // Lands on the order page, already paid: the dev provider's webhook is delivered in-process before `pay` returns.
    await expect(buyer.page).toHaveURL(/\/shop\/orders\/[0-9a-f-]+$/);
    await expect(buyer.page.getByText('Paid')).toBeVisible();
    await expect(buyer.page.getByText(title)).toBeVisible();
    await expectNoSeriousA11yViolations(buyer.page, 'order detail (buyer)');
    const orderUrl = buyer.page.url();
    const orderId = orderUrl.split('/').pop()!;

    // The seller sees the same order, with seller-only actions (fulfil), and the buyer's name.
    await seller.page.goto(`/shop/orders/${orderId}`);
    await expect(seller.page.getByText('Paid')).toBeVisible();
    await expect(seller.page.getByText(/Buyer: Bo Buyer/)).toBeVisible();
    await expect(
      seller.page.getByRole('button', { name: 'Mark as shipped / delivered' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(seller.page, 'order detail (seller)');

    watch.assertClean();
    await seller.context.close();
    await buyer.context.close();
  });
});
