import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CASE_STATES,
  CONTENT_TYPES,
  DECISIONS,
  PLATFORM_ROLE_NAMES,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  RISK_LEVELS,
} from '@yapilapi/api-client';
import { LOCALES, directionOf, placeholdersOf, type Message } from './core';
import { ar } from './messages/ar';
import { en } from './messages/en';
import { fr } from './messages/fr';
import { yo } from './messages/yo';
import { makeLabel, makeT } from './index';
import { ANALYTICS_TABS } from '@/views/Analytics';
import { PAYMENT_TABS } from '@/views/Payments';

const base = en as unknown as Record<string, Message>;
const catalogs = { fr, ar, yo } as Record<'fr' | 'ar' | 'yo', Record<string, Message>>;

describe('English source catalog', () => {
  it('has no empty messages', () => {
    for (const [k, v] of Object.entries(base)) {
      for (const f of typeof v === 'string' ? [v] : Object.values(v))
        expect(f.trim(), k).not.toBe('');
    }
  });

  it('plural messages define `other` and use {count}', () => {
    for (const [k, v] of Object.entries(base)) {
      if (typeof v === 'string') continue;
      expect(typeof v.other, k).toBe('string');
      expect(placeholdersOf(v), k).toContain('count');
    }
  });

  it('never says VYVO (the product is YAPILAPI)', () => {
    expect(JSON.stringify(base)).not.toMatch(/vyvo/i);
  });

  it('every static t("key") used in the source exists', () => {
    const root = path.resolve(__dirname, '..');
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'messages') walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/\b(?:t|tx)\(\s*'([a-zA-Z0-9_.]+)'/g))
          if (!(m[1]! in base)) missing.push(`${path.relative(root, p)}: ${m[1]}`);
      }
    };
    walk(root);
    expect(missing).toEqual([]);
  });

  it('has a label for every enum value the API can send to a page (so nothing is shown raw)', () => {
    const need: Array<[string, readonly string[]]> = [
      ['role', PLATFORM_ROLE_NAMES],
      ['risk', RISK_LEVELS],
      ['caseState', CASE_STATES],
      ['decision', DECISIONS],
      ['reportReason', REPORT_REASONS],
      ['targetType', REPORT_TARGET_TYPES],
      ['appealStatus', ['open', 'upheld', 'overturned']],
      ['reportStatus', ['open', 'triaged', 'actioned', 'dismissed']],
      ['source', ['user_report', 'automated', 'staff']],
      ['miniStatus', ['draft', 'in_review', 'published', 'rejected', 'suspended']],
      ['fraudDecision', ['allow', 'review', 'block']],
      ['kyc', ['unverified', 'pending', 'verified', 'rejected']],
      ['status', ['active', 'suspended', 'deactivated', 'pending_deletion', 'deleted']],
      ['msaType', ['message', 'comment', 'post', 'plan']],
      [
        'payStatus',
        [
          'pending_review',
          'pending_payment',
          'paid',
          'fulfilled',
          'completed',
          'cancelled',
          'refunded',
          'partially_refunded',
          'disputed',
        ],
      ],
    ];
    const missing = need.flatMap(([g, values]) =>
      values.filter((v) => !(`${g}.${v}` in base)).map((v) => `${g}.${v}`),
    );
    // "violence" reports are grouped as "threat" cases; every content type has a target label.
    expect(missing).toEqual([]);
    expect(CONTENT_TYPES.filter((c) => !(`targetType.${c}` in base) && c !== 'community')).toEqual(
      [],
    );
  });

  it('has the section titles for every dynamic tab and action key', () => {
    const keys = [
      ...ANALYTICS_TABS.map((x) => `analytics.tab.${x}`),
      ...PAYMENT_TABS.map((x) => `payments.tab.${x}`),
      ...DECISIONS.map((d) => `case.decide.effect.${d}`),
      ...['off', 'all', 'partial', 'zero'].map((k) => `flags.state.${k}`),
      ...['none', 'low', 'high'].map((k) => `identity.risk.${k}`),
      ...['verify', 'unverify', 'suspend', 'reinstate'].flatMap((a) => [
        `businesses.${a}`,
        `businesses.${a}Title`,
        `businesses.${a}Desc`,
        `businesses.${a}Done`,
      ]),
      ...['approve', 'reject', 'suspend', 'reinstate'].flatMap((a) => [
        `mini.decision.${a}`,
        `mini.decision.${a}Title`,
      ]),
    ];
    expect(keys.filter((k) => !(k in base))).toEqual([]);
  });
});

describe.each(['fr', 'ar', 'yo'] as const)(
  '%s catalog (machine-drafted, needs native review)',
  (loc) => {
    const cat = catalogs[loc];

    it('only uses keys that exist in English', () => {
      expect(Object.keys(cat).filter((k) => !(k in base))).toEqual([]);
    });

    it('keeps exactly the same {placeholders} as English', () => {
      for (const [k, v] of Object.entries(cat))
        expect(placeholdersOf(v), `${loc}:${k}`).toEqual(placeholdersOf(base[k]!));
    });

    it('keeps plain strings plain and plural messages plural, with categories the locale has', () => {
      const cats = new Set(
        new Intl.PluralRules(loc).resolvedOptions().pluralCategories as string[],
      );
      cats.add('zero');
      for (const [k, v] of Object.entries(cat)) {
        expect(typeof v, `${loc}:${k}`).toBe(typeof base[k]);
        if (typeof v === 'string') continue;
        for (const form of Object.keys(v)) expect(cats.has(form), `${loc}:${k}:${form}`).toBe(true);
        expect(typeof v.other, `${loc}:${k} needs "other"`).toBe('string');
      }
    });

    it('translates the navigation, sign-in, dialog and error strings staff see first', () => {
      const core = [
        'app.consoleBadge',
        'nav.primary',
        'nav.signOut',
        'nav.dashboard',
        'nav.users',
        'nav.moderation',
        'nav.payments',
        'nav.audit',
        'nav.flags',
        'common.cancel',
        'common.close',
        'common.retry',
        'common.search',
        'common.loading',
        'common.required',
        'common.none',
        'login.title',
        'login.email',
        'login.password',
        'login.submit',
        'login.code',
        'login.verify',
        'mutation.reasonAudited',
        'mutation.typeToConfirm',
        'error.generic',
        'error.network',
        'error.forbidden',
        'gate.noAccessTitle',
        'notFound.title',
        'theme.label',
        'locale.label',
        'role.support',
        'role.moderator',
        'role.admin',
        'role.superadmin',
        'chart.suppressed',
        'chart.viewTable',
      ];
      expect(core.filter((k) => !(k in cat))).toEqual([]);
    });

    it('does not say VYVO', () => {
      expect(JSON.stringify(cat)).not.toMatch(/vyvo/i);
    });
  },
);

describe('translators', () => {
  it('fall back to English for keys a locale has not translated', () => {
    const t = makeT('yo');
    expect(t('audit.f.prefix')).toBe(en['audit.f.prefix']);
  });

  it('interpolate and pick plural forms per locale', () => {
    expect(makeT('en')('common.lastDays', { count: 1 })).toBe('Last 1 day');
    expect(makeT('en')('common.lastDays', { count: 30 })).toBe('Last 30 days');
    expect(makeT('fr')('common.lastDays', { count: 30 })).toMatch(/30 derniers jours/);
    expect(makeT('ar')('common.lastDays', { count: 2 })).toMatch(/يوم/);
    expect(makeT('en')('users.suspend.done', { name: 'ada', until: 'Oct 1' })).toBe(
      'ada is suspended until Oct 1.',
    );
  });

  it('translated labels keep their meaning for roles and states', () => {
    for (const loc of ['fr', 'ar', 'yo'] as const) {
      const label = makeLabel(makeT(loc));
      for (const role of PLATFORM_ROLE_NAMES)
        expect(label('role', role).length, `${loc}:${role}`).toBeGreaterThan(0);
    }
  });

  it('humanises a value the catalog does not know instead of showing a raw code', () => {
    const label = makeLabel(makeT('en'));
    expect(label('status', 'brand_new_state')).toBe('Brand new state');
    expect(label('status', null)).toBe('None');
  });

  it('every locale is registered and only Arabic is right-to-left', () => {
    expect([...LOCALES]).toEqual(['en', 'fr', 'ar', 'yo']);
    expect(LOCALES.filter((l) => directionOf(l) === 'rtl')).toEqual(['ar']);
  });
});
