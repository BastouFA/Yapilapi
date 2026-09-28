import { describe, expect, it } from 'vitest';
import { REPORT_TARGETS } from './constants.ts';
import { PROFILE_TABS } from './profile-style.ts';
import { listingFingerprintText, marketDaysLeft, marketDistanceKm, prohibitedMatch } from './market.ts';
import { createListingSchema, marketSearchSchema } from './market-schemas.ts';

describe('Market checks before publishing', () => {
  it('finds prohibited things by whole words, in several languages', () => {
    expect(prohibitedMatch('Hunting rifle')).toBe('weapons');
    expect(prohibitedMatch('Cannabis seeds')).toBe('drugs');
    expect(prohibitedMatch('Two kittens need a home')).toBe('animals');
    expect(prohibitedMatch('Case of beer')).toBe('alcohol');
    expect(prohibitedMatch('Vape pen')).toBe('tobacco');
    expect(prohibitedMatch('Replica watch')).toBe('counterfeit');
    expect(prohibitedMatch('Stroller', 'This model was recalled last year')).toBe('recalled');
    expect(prohibitedMatch('Leftover antibiotics')).toBe('medicines');
    expect(prohibitedMatch('Réplica de reloj')).toBe('counterfeit');
    expect(prohibitedMatch('Cerveza artesanal')).toBe('alcohol');
  });

  it('leaves everyday things alone', () => {
    for (const ok of [
      'Drum kit',
      'Hot glue gun',
      'Wine glasses, set of six',
      'Puppy pads, unopened',
      'Rumba dance shoes',
      'Gunmetal grey laptop',
      'Tablet stand',
    ])
      expect(prohibitedMatch(ok)).toBeNull();
  });

  it('spots the same words however they are spaced or written', () => {
    expect(listingFingerprintText('Blue  SOFA', 'Like new!')).toBe(listingFingerprintText('blue sofa', 'like new'));
  });

  it('rounds distances to whole kilometres, never under one', () => {
    expect(marketDistanceKm(120)).toBe(1);
    expect(marketDistanceKm(2_600)).toBe(3);
    expect(marketDaysLeft(new Date(Date.now() + 2.5 * 86_400_000).toISOString())).toBe(3);
    expect(marketDaysLeft(new Date(Date.now() - 1000).toISOString())).toBe(0);
  });

  it('checks the forms and knows listings can be reported and shown on profiles', () => {
    const base = {
      title: 'Desk',
      category: 'furniture',
      condition: 'good',
      priceCents: null,
      photos: [{ mediaId: crypto.randomUUID() }],
      area: 'Yaba',
      delivery: ['pickup'],
    };
    expect(createListingSchema.safeParse(base).success).toBe(true);
    expect(createListingSchema.safeParse({ ...base, photos: [] }).success).toBe(false);
    expect(createListingSchema.safeParse({ ...base, delivery: ['teleport'] }).success).toBe(false);
    expect(marketSearchSchema.safeParse({ radiusKm: 10 }).success).toBe(true);
    expect(marketSearchSchema.safeParse({ radiusKm: 3 }).success).toBe(false);
    expect(marketSearchSchema.safeParse({ minPriceCents: 500, maxPriceCents: 100 }).success).toBe(false);
    expect(REPORT_TARGETS).toContain('listing');
    expect(PROFILE_TABS).toContain('market');
  });
});
