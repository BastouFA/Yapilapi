import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/** Regression tests for the bugs found in the bug hunt of 2026-09-28 (docs/product/status.md). */

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const ADULT = '1990-04-02';
const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe('a place says whether its business is yours', () => {
  it('so only the owner asks for its bookings', async () => {
    const owner = await signUp(t.app, { birthDate: ADULT });
    const guest = await signUp(t.app, { birthDate: ADULT });
    const biz = (await as(t.app, owner).post('/v1/businesses', { name: 'Hunt Kitchen', slug: `hunt-${tag()}` })).body.business;
    const created = await as(t.app, owner).post('/v1/places', { name: 'Hunt Kitchen', category: 'restaurant', businessId: biz.id });
    expect(created.status).toBe(201);
    expect(created.body.place.business).toMatchObject({ slug: biz.slug, mine: true });
    const id = created.body.place.id;

    expect((await as(t.app, owner).get(`/v1/places/${id}`)).body.place.business.mine).toBe(true);
    expect((await as(t.app, guest).get(`/v1/places/${id}`)).body.place.business.mine).toBe(false);
    const signedOut = await as(t.app, null).get(`/v1/places/${id}`);
    expect(signedOut.body.place.business).toEqual({ slug: biz.slug, name: 'Hunt Kitchen', mine: false });
    // No leftovers from the query.
    expect(signedOut.body.place).not.toHaveProperty('business_slug');
    expect(signedOut.body.place).not.toHaveProperty('business_mine');
  });
});
