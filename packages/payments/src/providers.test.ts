import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, signWebhook } from '@yapilapi/security';
import { DEV_SIGNATURE_HEADER, DevPaymentProvider, parseDevToken } from './dev-provider.js';
import {
  STRIPE_API_VERSION,
  StripePaymentProvider,
  encodeStripeForm,
  normaliseStripeEvent,
  parseStripeSignature,
  signStripePayload,
  verifyStripeSignature,
} from './stripe-provider.js';
import { PaymentProviderError, WebhookSignatureError } from './errors.js';
import {
  containsCardNumber,
  containsCardNumberDeep,
  isPaymentMethodRef,
  luhnValid,
} from './card-guard.js';
import { createPaymentProvider } from './factory.js';

const SECRET = 'dev-webhook-secret-for-tests';
const NOW = new Date('2026-05-01T12:00:00Z');
const dev = () => new DevPaymentProvider({ webhookSecret: SECRET, now: () => NOW });

describe('card data guard', () => {
  it('luhn and PAN detection', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(containsCardNumber('my card is 4242 4242 4242 4242 ok')).toBe(true);
    expect(containsCardNumber('4242-4242-4242-4242')).toBe(true);
    expect(containsCardNumber('order 1234567890123 shipped')).toBe(false); // fails Luhn
    expect(containsCardNumber('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(containsCardNumberDeep({ a: [{ b: 'x 5555555555554444 y' }] })).toBe(true);
    expect(containsCardNumberDeep({ amount: 12_345, note: 'hello' })).toBe(false);
  });
  it('accepts only opaque payment method references', () => {
    expect(isPaymentMethodRef('tok_success')).toBe(true);
    expect(isPaymentMethodRef('pm_1NxYzAbC')).toBe(true);
    expect(isPaymentMethodRef('4242424242424242')).toBe(false);
    expect(isPaymentMethodRef('tok_4242424242424242')).toBe(false);
    expect(isPaymentMethodRef('tok_ bad')).toBe(false);
    expect(isPaymentMethodRef('src_')).toBe(false);
  });
});

describe('dev provider', () => {
  it('is deterministic and idempotent', async () => {
    const p = dev();
    const a = await p.createPaymentIntent({
      amount: 5_000,
      currency: 'USD',
      idempotencyKey: 'k1',
      metadata: { orderId: 'o1' },
      paymentMethod: 'tok_success',
    });
    const b = await p.createPaymentIntent({
      amount: 5_000,
      currency: 'USD',
      idempotencyKey: 'k1',
      metadata: { orderId: 'o1' },
      paymentMethod: 'tok_success',
    });
    expect(a.status).toBe('succeeded');
    expect(b.ref).toBe(a.ref);
    await expect(
      dev().createPaymentIntent({
        amount: 5_000,
        currency: 'USD',
        idempotencyKey: 'k1',
        metadata: {},
      }),
    ).resolves.toMatchObject({ ref: a.ref });
    await expect(
      p.createPaymentIntent({ amount: 6_000, currency: 'USD', idempotencyKey: 'k1', metadata: {} }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('test tokens: success, decline, insufficient funds, requires action', async () => {
    const p = dev();
    const mk = (pm: string, k: string) =>
      p.createPaymentIntent({
        amount: 1_000,
        currency: 'USD',
        idempotencyKey: k,
        metadata: {},
        paymentMethod: pm,
      });
    expect((await mk('tok_success', 'a')).status).toBe('succeeded');
    expect(await mk('tok_decline', 'b')).toMatchObject({
      status: 'failed',
      failureCode: 'card_declined',
    });
    expect(await mk('tok_insufficient_funds', 'c')).toMatchObject({
      status: 'failed',
      failureCode: 'insufficient_funds',
    });
    const ra = await mk('tok_requires_action', 'd');
    expect(ra).toMatchObject({ status: 'requires_action', nextAction: { type: 'dev_challenge' } });
    const done = await p.confirmPayment(ra.ref, {});
    expect(done.status).toBe('succeeded');
    await expect(mk('tok_unknown', 'e')).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(mk('4242424242424242', 'f')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('token modifiers control fingerprint and country deterministically', async () => {
    expect(parseDevToken('tok_success:fp=abc:cc=gb')).toEqual({
      outcome: 'success',
      fingerprint: 'fp_dev_abc',
      country: 'GB',
    });
    expect(parseDevToken('tok_success')).toEqual({
      outcome: 'success',
      fingerprint: 'fp_dev_success',
      country: 'US',
    });
    expect(await dev().describePaymentMethod('tok_decline:cc=NG')).toMatchObject({ country: 'NG' });
  });

  it('emits HMAC-signed webhooks that verify, with stable event ids', async () => {
    const p = dev();
    await p.createPaymentIntent({
      amount: 1_000,
      currency: 'USD',
      idempotencyKey: 'w1',
      metadata: { orderId: 'o' },
      paymentMethod: 'tok_success',
    });
    const out = p.drainWebhookOutbox();
    expect(out).toHaveLength(1);
    expect(p.drainWebhookOutbox()).toHaveLength(0);
    const events = p.verifyWebhook(out[0]!.rawBody, out[0]!.headers);
    expect(events[0]).toMatchObject({
      type: 'payment.succeeded',
      amount: 1_000,
      currency: 'USD',
      metadata: { orderId: 'o' },
    });
    const p2 = dev();
    await p2.createPaymentIntent({
      amount: 1_000,
      currency: 'USD',
      idempotencyKey: 'w1',
      metadata: { orderId: 'o' },
      paymentMethod: 'tok_success',
    });
    expect(
      p2.verifyWebhook(
        ...(Object.values(p2.drainWebhookOutbox()[0]!) as [string, Record<string, string>]),
      )[0]!.id,
    ).toBe(events[0]!.id);
  });

  it('rejects tampered, unsigned, wrongly signed and stale webhooks', () => {
    const p = dev();
    const good = p.buildWebhook({
      id: 'evt_1',
      type: 'payment.succeeded',
      data: { providerRef: 'pi_dev_x', amount: 5, currency: 'USD' },
    });
    expect(() => p.verifyWebhook(good.rawBody, good.headers)).not.toThrow();
    expect(() =>
      p.verifyWebhook(good.rawBody.replace('"amount":5', '"amount":500'), good.headers),
    ).toThrow(WebhookSignatureError);
    expect(() => p.verifyWebhook(good.rawBody, {})).toThrow(/Missing/);
    const wrong = {
      [DEV_SIGNATURE_HEADER]: signWebhook(
        'other-secret',
        good.rawBody,
        Math.floor(NOW.getTime() / 1000),
      ),
    };
    expect(() => p.verifyWebhook(good.rawBody, wrong)).toThrow(WebhookSignatureError);
    const stale = p.buildWebhook(
      { id: 'evt_2', type: 'payment.succeeded', data: {} },
      Math.floor(NOW.getTime() / 1000) - 3_600,
    );
    try {
      p.verifyWebhook(stale.rawBody, stale.headers);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WebhookSignatureError).reason).toBe('stale_timestamp');
    }
    const future = p.buildWebhook(
      { id: 'evt_3', type: 'payment.succeeded', data: {} },
      Math.floor(NOW.getTime() / 1000) + 3_600,
    );
    expect(() => p.verifyWebhook(future.rawBody, future.headers)).toThrow(WebhookSignatureError);
  });

  it('refunds are idempotent and cannot exceed the charge', async () => {
    const p = dev();
    const pi = await p.createPaymentIntent({
      amount: 1_000,
      currency: 'USD',
      idempotencyKey: 'r1',
      metadata: {},
      paymentMethod: 'tok_success',
    });
    const r1 = await p.refund({
      paymentRef: pi.ref,
      amount: 400,
      currency: 'USD',
      idempotencyKey: 'ref-a',
    });
    expect(r1.status).toBe('succeeded');
    expect(
      (
        await p.refund({
          paymentRef: pi.ref,
          amount: 400,
          currency: 'USD',
          idempotencyKey: 'ref-a',
        })
      ).ref,
    ).toBe(r1.ref);
    await p.refund({ paymentRef: pi.ref, amount: 600, currency: 'USD', idempotencyKey: 'ref-b' });
    await expect(
      p.refund({ paymentRef: pi.ref, amount: 1, currency: 'USD', idempotencyKey: 'ref-c' }),
    ).rejects.toMatchObject({ code: 'charge_already_refunded' });
    await expect(
      p.refund({ paymentRef: 'pi_other', amount: 1, currency: 'USD', idempotencyKey: 'x' }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('connected accounts gate payouts on KYC', async () => {
    const p = dev();
    const acct = await p.createConnectedAccount({
      ownerType: 'user',
      ownerId: 'u',
      country: 'US',
      idempotencyKey: 'k',
    });
    expect(acct).toMatchObject({ kycStatus: 'pending', payoutsEnabled: false });
    await expect(
      p.createPayout({
        accountRef: acct.accountRef,
        amount: 100,
        currency: 'USD',
        idempotencyKey: 'p1',
      }),
    ).rejects.toMatchObject({ code: 'account_not_verified' });
    p.devSetKyc(acct.accountRef, 'verified');
    expect((await p.getConnectedAccount(acct.accountRef)).payoutsEnabled).toBe(true);
    const po = await p.createPayout({
      accountRef: acct.accountRef,
      amount: 100,
      currency: 'USD',
      idempotencyKey: 'p1',
    });
    expect(po.status).toBe('paid');
    expect(
      (
        await p.createPayout({
          accountRef: acct.accountRef,
          amount: 100,
          currency: 'USD',
          idempotencyKey: 'p1',
        })
      ).ref,
    ).toBe(po.ref);
    p.devFailPayoutsFor(acct.accountRef);
    expect(
      (
        await p.createPayout({
          accountRef: acct.accountRef,
          amount: 100,
          currency: 'USD',
          idempotencyKey: 'p2',
        })
      ).status,
    ).toBe('failed');
  });

  it('lists records for reconciliation', async () => {
    const p = dev();
    const pi = await p.createPaymentIntent({
      amount: 1_000,
      currency: 'USD',
      idempotencyKey: 'l1',
      metadata: {},
      paymentMethod: 'tok_success',
    });
    await p.refund({ paymentRef: pi.ref, amount: 100, currency: 'USD', idempotencyKey: 'l1r' });
    const recs = await p.listRecords({
      from: new Date(NOW.getTime() - 1000),
      to: new Date(NOW.getTime() + 1000),
    });
    expect(recs.map((r) => r.kind).sort()).toEqual(['payment', 'refund']);
  });

  it('factory selects the provider', () => {
    expect(createPaymentProvider({ provider: 'dev', webhookSigningSecret: SECRET }).name).toBe(
      'dev',
    );
    expect(
      createPaymentProvider({
        provider: 'stripe',
        webhookSigningSecret: SECRET,
        stripeSecretKey: 'sk_test_x',
        stripeWebhookSecret: 'whsec_x',
      }).name,
    ).toBe('stripe');
    expect(() =>
      createPaymentProvider({ provider: 'stripe', webhookSigningSecret: SECRET }),
    ).toThrow();
  });
});

describe('Stripe signature verification', () => {
  const secret = 'whsec_test_secret';
  const payload = '{"id":"evt_1","object":"event","type":"payment_intent.succeeded"}';
  // Independently computed with: printf '%s' "1700000000.$payload" | openssl dgst -sha256 -hmac whsec_test_secret
  const KNOWN_V1 = '67da5088c63e080c71bd2bb0cb5c03d85a8fc6a21ce3aaf484df809654745b92';
  const T = 1_700_000_000;

  it('matches an independently computed HMAC vector', () => {
    expect(hmacSha256Hex(secret, `${T}.${payload}`)).toBe(KNOWN_V1);
    expect(signStripePayload(secret, payload, T)).toBe(`t=${T},v1=${KNOWN_V1}`);
    expect(() =>
      verifyStripeSignature({
        secret,
        header: `t=${T},v1=${KNOWN_V1}`,
        rawBody: payload,
        nowSec: T + 10,
      }),
    ).not.toThrow();
  });
  it('accepts any matching v1 among several and ignores v0', () => {
    const h = `t=${T},v1=${'0'.repeat(64)},v0=abc,v1=${KNOWN_V1}`;
    expect(() =>
      verifyStripeSignature({ secret, header: h, rawBody: payload, nowSec: T }),
    ).not.toThrow();
    expect(parseStripeSignature(h)).toEqual({ t: T, v1: ['0'.repeat(64), KNOWN_V1] });
  });
  it('rejects bad signature, tampered body, wrong secret, malformed and missing headers', () => {
    const rejects = (o: Parameters<typeof verifyStripeSignature>[0], reason: string) => {
      try {
        verifyStripeSignature(o);
        throw new Error('expected rejection');
      } catch (e) {
        expect((e as WebhookSignatureError).reason).toBe(reason);
      }
    };
    rejects(
      { secret, header: `t=${T},v1=${'a'.repeat(64)}`, rawBody: payload, nowSec: T },
      'bad_signature',
    );
    rejects(
      { secret, header: `t=${T},v1=${KNOWN_V1}`, rawBody: payload + ' ', nowSec: T },
      'bad_signature',
    );
    rejects(
      { secret: 'whsec_other', header: `t=${T},v1=${KNOWN_V1}`, rawBody: payload, nowSec: T },
      'bad_signature',
    );
    rejects({ secret, header: 'garbage', rawBody: payload, nowSec: T }, 'malformed_header');
    rejects({ secret, header: `v1=${KNOWN_V1}`, rawBody: payload, nowSec: T }, 'malformed_header');
    rejects({ secret, header: undefined, rawBody: payload, nowSec: T }, 'missing_header');
  });
  it('rejects timestamps outside the tolerance in both directions', () => {
    const h = `t=${T},v1=${KNOWN_V1}`;
    expect(() =>
      verifyStripeSignature({ secret, header: h, rawBody: payload, nowSec: T + 299 }),
    ).not.toThrow();
    for (const now of [T + 301, T - 301]) {
      try {
        verifyStripeSignature({ secret, header: h, rawBody: payload, nowSec: now });
        throw new Error('expected rejection');
      } catch (e) {
        expect((e as WebhookSignatureError).reason).toBe('stale_timestamp');
      }
    }
    expect(() =>
      verifyStripeSignature({
        secret,
        header: h,
        rawBody: payload,
        nowSec: T + 500,
        toleranceSeconds: 600,
      }),
    ).not.toThrow();
  });
});

describe('Stripe adapter request construction', () => {
  interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }
  function harness(responses: Array<{ status?: number; json: unknown }>) {
    const calls: Call[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(JSON.stringify(r.json), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const provider = new StripePaymentProvider({
      secretKey: 'sk_test_abc',
      webhookSecret: 'whsec_test_secret',
      fetchImpl,
      now: () => new Date(1_700_000_010_000),
    });
    return { provider, calls };
  }
  const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));

  it('encodes nested form fields like Stripe expects', () => {
    expect(
      encodeStripeForm({
        amount: 100,
        metadata: { a: 'b c', n: 1 },
        list: ['x', 'y'],
        skip: undefined,
        none: null,
        flag: true,
      }),
    ).toBe(
      'amount=100&metadata%5Ba%5D=b%20c&metadata%5Bn%5D=1&list%5B0%5D=x&list%5B1%5D=y&flag=true',
    );
  });

  it('creates a payment intent with auth, version, idempotency key and lower-case currency', async () => {
    const { provider, calls } = harness([
      { json: { id: 'pi_123', status: 'succeeded', client_secret: 'pi_123_secret_x' } },
    ]);
    const r = await provider.createPaymentIntent({
      amount: 4_200,
      currency: 'EUR',
      idempotencyKey: 'pay:1',
      metadata: { orderId: 'o-1', paymentId: 'p-1' },
      paymentMethod: 'pm_card_visa',
      description: 'Order o-1',
    });
    expect(r).toMatchObject({
      ref: 'pi_123',
      status: 'succeeded',
      clientSecret: 'pi_123_secret_x',
    });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(c.method).toBe('POST');
    expect(c.headers).toMatchObject({
      authorization: 'Bearer sk_test_abc',
      'idempotency-key': 'pay:1',
      'stripe-version': STRIPE_API_VERSION,
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(form(c)).toMatchObject({
      amount: '4200',
      currency: 'eur',
      payment_method: 'pm_card_visa',
      confirm: 'true',
      capture_method: 'automatic',
      'metadata[orderId]': 'o-1',
      'metadata[paymentId]': 'p-1',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      transfer_group: 'o-1',
    });
  });

  it('without a payment method it does not confirm; zero-decimal currencies are passed through untouched', async () => {
    const { provider, calls } = harness([
      { json: { id: 'pi_1', status: 'requires_payment_method', client_secret: 'cs' } },
    ]);
    const r = await provider.createPaymentIntent({
      amount: 1_500,
      currency: 'JPY',
      idempotencyKey: 'k',
      metadata: { paymentId: 'p' },
    });
    expect(r.status).toBe('requires_payment_method');
    expect(form(calls[0]!)).toMatchObject({ amount: '1500', currency: 'jpy' });
    expect(form(calls[0]!).confirm).toBeUndefined();
  });

  it('refuses anything that is not an opaque payment method reference (no card numbers)', () => {
    const { provider, calls } = harness([{ json: {} }]);
    expect(() =>
      provider.createPaymentIntent({
        amount: 100,
        currency: 'USD',
        idempotencyKey: 'k',
        metadata: {},
        paymentMethod: '4242424242424242',
      }),
    ).toThrow(PaymentProviderError);
    expect(calls).toHaveLength(0);
  });

  it('maps declines (HTTP 402 with the intent) to a failed result, not an exception', async () => {
    const { provider } = harness([
      {
        status: 402,
        json: {
          error: {
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'generic_decline',
            message: 'declined',
            payment_intent: {
              id: 'pi_dec',
              status: 'requires_payment_method',
              client_secret: 'cs',
              last_payment_error: { code: 'card_declined', decline_code: 'generic_decline' },
            },
          },
        },
      },
    ]);
    const r = await provider.createPaymentIntent({
      amount: 100,
      currency: 'USD',
      idempotencyKey: 'k',
      metadata: {},
      paymentMethod: 'pm_card_chargeDeclined',
    });
    expect(r).toMatchObject({ ref: 'pi_dec', status: 'failed', failureCode: 'generic_decline' });
  });

  it('classifies transient errors as retryable and others as final', async () => {
    const a = harness([{ status: 503, json: { error: { message: 'down' } } }]);
    await expect(
      a.provider.refund({ paymentRef: 'pi_1', amount: 10, currency: 'USD', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ retryable: true, httpStatus: 503 });
    const b = harness([
      { status: 400, json: { error: { code: 'charge_already_refunded', message: 'nope' } } },
    ]);
    await expect(
      b.provider.refund({ paymentRef: 'pi_1', amount: 10, currency: 'USD', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ retryable: false, code: 'charge_already_refunded' });
    const provider = new StripePaymentProvider({
      secretKey: 'sk',
      webhookSecret: 'wh',
      fetchImpl: (async () => {
        throw new TypeError('network');
      }) as unknown as typeof fetch,
    });
    await expect(
      provider.refund({ paymentRef: 'pi_1', amount: 10, currency: 'USD', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ retryable: true, code: 'provider_unreachable' });
  });

  it('builds refund, transfer, account and account-link requests', async () => {
    const { provider, calls } = harness([
      { json: { id: 're_1', status: 'succeeded' } },
      { json: { id: 'tr_1', reversed: false } },
      { json: { id: 'acct_1', details_submitted: false, payouts_enabled: false } },
      { json: { url: 'https://connect.stripe.com/setup/x' } },
      { json: { id: 'acct_1', details_submitted: true, payouts_enabled: true } },
    ]);
    expect(
      await provider.refund({
        paymentRef: 'pi_9',
        amount: 250,
        currency: 'USD',
        idempotencyKey: 'refund:1',
        reason: 'duplicate',
      }),
    ).toEqual({ ref: 're_1', status: 'succeeded', failureCode: null });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/refunds');
    expect(form(calls[0]!)).toMatchObject({
      payment_intent: 'pi_9',
      amount: '250',
      reason: 'duplicate',
    });
    expect(calls[0]!.headers['idempotency-key']).toBe('refund:1');

    expect(
      (
        await provider.createPayout({
          accountRef: 'acct_7',
          amount: 900,
          currency: 'GBP',
          idempotencyKey: 'payout:1',
          metadata: { payoutId: 'x' },
        })
      ).status,
    ).toBe('paid');
    expect(calls[1]!.url).toBe('https://api.stripe.com/v1/transfers');
    expect(form(calls[1]!)).toMatchObject({
      amount: '900',
      currency: 'gbp',
      destination: 'acct_7',
      'metadata[payoutId]': 'x',
    });

    const acct = await provider.createConnectedAccount({
      ownerType: 'business',
      ownerId: 'b1',
      country: 'GB',
      email: 'a@b.test',
      idempotencyKey: 'acct:b1',
      returnUrl: 'https://app.test/done',
    });
    expect(acct).toMatchObject({
      accountRef: 'acct_1',
      kycStatus: 'unverified',
      onboardingUrl: 'https://connect.stripe.com/setup/x',
    });
    expect(calls[2]!.url).toBe('https://api.stripe.com/v1/accounts');
    expect(form(calls[2]!)).toMatchObject({
      type: 'express',
      country: 'GB',
      'capabilities[transfers][requested]': 'true',
      'metadata[ownerId]': 'b1',
    });
    expect(calls[3]!.url).toBe('https://api.stripe.com/v1/account_links');
    expect(form(calls[3]!)).toMatchObject({ account: 'acct_1', type: 'account_onboarding' });

    expect(await provider.getConnectedAccount('acct_1')).toMatchObject({
      kycStatus: 'verified',
      payoutsEnabled: true,
    });
    expect(calls[4]!.method).toBe('GET');
    expect(calls[4]!.url).toBe('https://api.stripe.com/v1/accounts/acct_1');
  });

  it('verifies webhooks end to end and normalises events', () => {
    const { provider } = harness([{ json: {} }]);
    const evt = {
      id: 'evt_9',
      type: 'payment_intent.succeeded',
      created: 1_700_000_000,
      data: {
        object: {
          id: 'pi_5',
          amount: 999,
          amount_received: 999,
          currency: 'usd',
          metadata: { paymentId: 'p1' },
        },
      },
    };
    const raw = JSON.stringify(evt);
    const header = signStripePayload('whsec_test_secret', raw, 1_700_000_005);
    const [n] = provider.verifyWebhook(raw, { 'stripe-signature': header });
    expect(n).toMatchObject({
      id: 'evt_9',
      type: 'payment.succeeded',
      providerRef: 'pi_5',
      amount: 999,
      currency: 'USD',
      metadata: { paymentId: 'p1' },
    });
    expect(() => provider.verifyWebhook(raw + ' ', { 'stripe-signature': header })).toThrow(
      WebhookSignatureError,
    );
    expect(() =>
      provider.verifyWebhook(raw, {
        'stripe-signature': signStripePayload('whsec_test_secret', raw, 1_699_000_000),
      }),
    ).toThrow(/tolerance/);
  });

  it('normalises refund, dispute, transfer and account events', () => {
    const mk = (type: string, object: Record<string, unknown>) =>
      normaliseStripeEvent({ id: `evt_${type}`, type, created: 1, data: { object } });
    expect(
      mk('refund.updated', {
        id: 're_1',
        status: 'succeeded',
        payment_intent: 'pi_1',
        amount: 5,
        currency: 'usd',
      }),
    ).toMatchObject({ type: 'refund.succeeded', paymentRef: 'pi_1', amount: 5 });
    expect(
      mk('refund.updated', {
        id: 're_1',
        status: 'failed',
        payment_intent: 'pi_1',
        amount: 5,
        currency: 'usd',
        failure_reason: 'lost_or_stolen_card',
      }),
    ).toMatchObject({ type: 'refund.failed', failureCode: 'lost_or_stolen_card' });
    expect(
      mk('refund.updated', { id: 're_1', status: 'pending', amount: 5, currency: 'usd' }).type,
    ).toBe('ignored');
    expect(
      mk('charge.dispute.created', {
        id: 'dp_1',
        payment_intent: 'pi_1',
        amount: 5,
        currency: 'usd',
        reason: 'fraudulent',
      }),
    ).toMatchObject({ type: 'dispute.opened', disputeReason: 'fraudulent' });
    expect(
      mk('charge.dispute.closed', { id: 'dp_1', status: 'lost', payment_intent: 'pi_1' }),
    ).toMatchObject({ type: 'dispute.closed', disputeOutcome: 'lost' });
    expect(mk('charge.dispute.closed', { id: 'dp_1', status: 'won' })).toMatchObject({
      disputeOutcome: 'won',
    });
    expect(mk('transfer.reversed', { id: 'tr_1', amount: 5, currency: 'usd' }).type).toBe(
      'payout.failed',
    );
    expect(
      mk('account.updated', { id: 'acct_1', details_submitted: true, payouts_enabled: true }),
    ).toMatchObject({ type: 'account.updated', account: { kycStatus: 'verified' } });
    expect(
      mk('account.updated', { id: 'acct_1', requirements: { disabled_reason: 'rejected.fraud' } })
        .account?.kycStatus,
    ).toBe('rejected');
    expect(mk('customer.created', { id: 'cus_1' }).type).toBe('ignored');
  });
});
