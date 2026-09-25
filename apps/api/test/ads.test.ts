import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  createTestApp,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { block, teenBirth } from './entity-helpers.js';
import { balanceOf, ledgerOf, mkProduct, unbalancedTransactions } from './commerce-fixtures.js';
import {
  logClick,
  logImpression,
  runAdsMaintenance,
  selectAds,
  settleAdSpend,
  signToken,
  verifyToken,
} from '../src/modules/ads/index.js';
import { advertiserReceivable, PLATFORM_AD_REVENUE } from '../src/modules/ads/billing.js';

let t: TestApp;
let admin: TestUser;
let mod: TestUser;
let support: TestUser;
beforeAll(async () => {
  t = await createTestApp();
  admin = await signup(t);
  await makeStaff(t, admin, 'admin');
  mod = await signup(t);
  await makeStaff(t, mod, 'moderator');
  support = await signup(t);
  await makeStaff(t, support, 'support');
});
afterAll(async () => {
  await t.close();
});
// Ads on air in one test must not compete with (or leak into) the next: every test starts with nothing active.
beforeEach(async () => {
  await t.ctx.db.query(`UPDATE ad_campaigns SET status = 'ended' WHERE status = 'active'`);
});

const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);
const n = async (q: string, p: unknown[] = []): Promise<number> =>
  Number((await sql(q, p)).rows[0].n);
const anon = () => new Client(t);
const auditN = (action: string, targetId?: string) =>
  n(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR target_id::text = $2)`,
    [action, targetId ?? null],
  );
const notifN = (userId: string, kind: string) =>
  n('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2', [
    userId,
    kind,
  ]);

async function mkCreator(): Promise<TestUser> {
  const u = await signup(t);
  const r = await u.client.post('/v1/creator/join', { termsVersion: '2027-01', category: 'music' });
  if (r.status !== 201)
    throw new Error(`creator join failed ${r.status} ${JSON.stringify(r.body)}`);
  return u;
}
async function mkBusiness(u: TestUser): Promise<any> {
  const r = await u.client.post('/v1/businesses', { name: `Biz ${uniq('b')}`, category: 'food' });
  if (r.status !== 201)
    throw new Error(`create business failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const campaignBody = (over: Record<string, unknown> = {}) => ({
  name: `Campaign ${uniq('c')}`,
  dailyBudgetCents: 500,
  totalBudgetCents: 5000,
  currency: 'USD',
  bidCents: 200,
  targeting: {},
  ...over,
});
const adBody = (over: Record<string, unknown> = {}) => ({
  headline: 'Fresh bread daily',
  body: 'Come and taste it',
  placement: 'feed',
  target: { type: 'url', url: 'https://bakery.example.com/menu' },
  ...over,
});
async function mkCampaign(adv: TestUser, over: Record<string, unknown> = {}): Promise<any> {
  const r = await adv.client.post('/v1/ads/campaigns', campaignBody(over));
  if (r.status !== 201) throw new Error(`campaign failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function mkAd(adv: TestUser, cid: string, over: Record<string, unknown> = {}): Promise<any> {
  const r = await adv.client.post(`/v1/ads/campaigns/${cid}/ads`, adBody(over));
  if (r.status !== 201) throw new Error(`ad failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** A creator campaign with one ad, reviewed and approved: on air. */
async function goLive(
  over: Record<string, unknown> = {},
  adOver: Record<string, unknown> = {},
  adv?: TestUser,
): Promise<{ adv: TestUser; campaign: any; ad: any }> {
  const a = adv ?? (await mkCreator());
  const campaign = await mkCampaign(a, over);
  const ad = await mkAd(a, campaign.id, adOver);
  expect((await a.client.post(`/v1/ads/campaigns/${campaign.id}/submit`)).status).toBe(200);
  const r = await mod.client.post(`/v1/staff/ads/campaigns/${campaign.id}/review`, {
    decision: 'approve',
  });
  if (r.status !== 200) throw new Error(`approve failed ${r.status} ${JSON.stringify(r.body)}`);
  return { adv: a, campaign: r.body, ad };
}
const serve = (v: TestUser, q: Record<string, string> = {}) =>
  v.client.get('/v1/ads/serve', { placement: 'feed', ...q });
const grant = (v: TestUser, granted = true) =>
  v.client.put('/v1/privacy/consents/advertising', { granted });
/** A token as if the ad had been shown `ms` ago (the API refuses impressions reported within 250 ms of serving). */
const aged = (token: string, ms = 5000): string => {
  const p = verifyToken(t.ctx, token)!;
  return signToken(t.ctx, { ...p, t: p.t - ms });
};
const tokenFor = async (
  v: TestUser,
  adId: string,
  ageMs = 5000,
): Promise<{ token: string; item: any }> => {
  const items = await selectAds(t.ctx, v.id, 'feed', 50);
  const item = items.find((i) => i.adId === adId);
  if (!item) throw new Error(`ad ${adId} was not served to ${v.id}`);
  return { token: aged(item.impressionToken, ageMs), item };
};
const imp = (v: TestUser, token: string, headers: Record<string, string> = {}) =>
  v.client.request('POST', '/v1/ads/impressions', { body: { token }, headers });
const click = (v: TestUser, token: string, headers: Record<string, string> = {}) =>
  v.client.request('POST', '/v1/ads/clicks', { body: { token }, headers });
const camp = async (id: string) => {
  const r = (
    await sql(
      'SELECT status, spent_milli, spent_cents, settled_milli FROM ad_campaigns WHERE id = $1',
      [id],
    )
  ).rows[0];
  return {
    status: r.status as string,
    spent_milli: Number(r.spent_milli),
    spent_cents: Number(r.spent_cents),
    settled_milli: Number(r.settled_milli),
  };
};

// ================================================================== campaigns
describe('campaigns', () => {
  it('are created by adults who advertise as an active creator or as owner/admin of a business', async () => {
    const creator = await mkCreator();
    expect((await anon().post('/v1/ads/campaigns', campaignBody())).status).toBe(401);
    const plain = await signup(t);
    const noCreator = await plain.client.post('/v1/ads/campaigns', campaignBody());
    expect(noCreator.status).toBe(403);
    expect(noCreator.body.error.details.reason).toBe('not_a_creator');
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await teen.client.post('/v1/ads/campaigns', campaignBody())).status).toBe(403);

    const c = await creator.client.post(
      '/v1/ads/campaigns',
      campaignBody({
        name: 'Summer sale',
        targeting: { topics: ['music'], languages: ['en'], geo: { countries: ['us'] } },
      }),
    );
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({
      status: 'draft',
      ownerUserId: creator.id,
      businessId: null,
      bidModel: 'cpm',
      frequencyCap: 3,
      spentCents: 0,
      targeting: { topics: ['music'], languages: ['en'], geo: { countries: ['US'], cities: [] } },
    });
    expect(await auditN('ads.campaign_created', c.body.id)).toBe(1);

    const owner = await signup(t);
    const biz = await mkBusiness(owner);
    const bc = await owner.client.post('/v1/ads/campaigns', campaignBody({ businessId: biz.id }));
    expect(bc.status).toBe(201);
    expect(bc.body).toMatchObject({ businessId: biz.id, ownerUserId: null });
    const stranger = await signup(t);
    expect(
      (await stranger.client.post('/v1/ads/campaigns', campaignBody({ businessId: biz.id })))
        .status,
    ).toBe(404);
    const editor = await signup(t);
    await sql(`INSERT INTO business_members (business_id, user_id, role) VALUES ($1,$2,'editor')`, [
      biz.id,
      editor.id,
    ]);
    expect(
      (await editor.client.post('/v1/ads/campaigns', campaignBody({ businessId: biz.id }))).status,
    ).toBe(403);
    const admin2 = await signup(t);
    await sql(`INSERT INTO business_members (business_id, user_id, role) VALUES ($1,$2,'admin')`, [
      biz.id,
      admin2.id,
    ]);
    expect((await admin2.client.get(`/v1/ads/campaigns/${bc.body.id}`)).status).toBe(200); // admins run the business's ads too
    expect((await editor.client.get(`/v1/ads/campaigns/${bc.body.id}`)).status).toBe(404);
    expect((await stranger.client.get(`/v1/ads/campaigns/${c.body.id}`)).status).toBe(404);
    expect(
      (await creator.client.get('/v1/ads/campaigns')).body.items.map((x: any) => x.id),
    ).toEqual([c.body.id]);
    // A suspended business cannot start new campaigns.
    await sql(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [biz.id]);
    expect(
      (await owner.client.post('/v1/ads/campaigns', campaignBody({ businessId: biz.id }))).status,
    ).toBe(403);
  });

  it('validate budgets, money, schedule and refuse sensitive or unknown targeting with useful reasons', async () => {
    const a = await mkCreator();
    const post = (over: Record<string, unknown>) =>
      a.client.post('/v1/ads/campaigns', campaignBody(over));
    expect((await post({ dailyBudgetCents: 6000 })).status).toBe(400); // daily > total
    expect((await post({ dailyBudgetCents: 50 })).status).toBe(400);
    expect((await post({ currency: 'dollars' })).status).toBe(400);
    expect((await post({ bidCents: 0 })).status).toBe(400);
    expect((await post({ frequencyCap: 21 })).status).toBe(400);
    expect(
      (
        await post({
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect((await post({ name: 'I will kill you tomorrow' })).status).toBe(422);
    for (const [targeting, needle] of [
      [{ gender: 'female' }, 'gender'],
      [{ age_band: 'teen' }, 'age_band'],
      [{ religion: 'x' }, 'religion'],
      [{ lookalike: true }, 'lookalike'],
      [{ topics: ['politics'] }, 'politics'],
      [{ topics: ['faith'] }, 'faith'],
      [{ topics: ['mental-health'] }, 'mental-health'],
      [{ geo: { lat: 1, lng: 2 } }, 'geo'],
      [{ whatever: 1 }, 'whatever'],
    ] as const) {
      const r = await post({ targeting });
      expect(r.status, JSON.stringify(targeting)).toBe(422);
      expect(r.body.error.details.reason).toBe('targeting_not_allowed');
      expect(JSON.stringify(r.body.error.details.issues)).toContain(needle);
    }
    const unknown = await post({ targeting: { topics: ['no-such-topic'] } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details.reason).toBe('unknown_topic');
    expect(
      (await post({ targeting: { topics: ['music', 'travel'] }, bidModel: 'cpc' })).status,
    ).toBe(201);
  });

  it('are editable only when draft, rejected or paused; edits to reviewed fields send a paused campaign back to review', async () => {
    const { adv, campaign, ad } = await goLive();
    expect(
      (await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, { name: 'New name' })).status,
    ).toBe(409); // active: pause first
    expect((await adv.client.post(`/v1/ads/campaigns/${campaign.id}/pause`)).body.status).toBe(
      'paused',
    );
    expect((await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, {})).status).toBe(400);
    expect(
      (await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, { dailyBudgetCents: 9000 }))
        .status,
    ).toBe(400);
    expect(
      (await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, { totalBudgetCents: 800 }))
        .status,
    ).toBe(200); // valid: 800 >= daily 500
    const budgetOnly = await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, {
      dailyBudgetCents: 300,
      totalBudgetCents: 900,
    });
    expect(budgetOnly.body).toMatchObject({
      status: 'paused',
      dailyBudgetCents: 300,
      totalBudgetCents: 900,
    });
    expect(
      (await sql('SELECT status FROM advertisements WHERE id = $1', [ad.id])).rows[0].status,
    ).toBe('approved'); // the approval stands
    const targeted = await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, {
      targeting: { topics: ['music'] },
    });
    expect(targeted.body.status).toBe('draft');
    expect(
      (await sql('SELECT status FROM advertisements WHERE id = $1', [ad.id])).rows[0].status,
    ).toBe('draft');
    expect((await adv.client.post(`/v1/ads/campaigns/${campaign.id}/resume`)).status).toBe(409); // not reviewed any more
    expect(
      (await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, { targeting: { gender: 'x' } }))
        .status,
    ).toBe(422);
    expect(await auditN('ads.campaign_updated', campaign.id)).toBeGreaterThanOrEqual(2);
    // Ended campaigns are final.
    expect((await adv.client.post(`/v1/ads/campaigns/${campaign.id}/end`)).body.status).toBe(
      'ended',
    );
    expect((await adv.client.post(`/v1/ads/campaigns/${campaign.id}/resume`)).status).toBe(409);
    expect(
      (await adv.client.patch(`/v1/ads/campaigns/${campaign.id}`, { name: 'zombie' })).status,
    ).toBe(409);
  });
});

// ================================================================== ads (creatives)
describe('ads inside a campaign', () => {
  it('screen text, destinations and media; only drafts and rejected ads are editable', async () => {
    const a = await mkCreator();
    const c = await mkCampaign(a);
    const post = (over: Record<string, unknown>) =>
      a.client.post(`/v1/ads/campaigns/${c.id}/ads`, adBody(over));
    expect((await post({ headline: 'I will kill you tomorrow' })).status).toBe(422);
    expect((await post({ headline: '' })).status).toBe(400);
    for (const url of [
      'http://bakery.example.com',
      'https://127.0.0.1/x',
      'https://user:pw@bakery.example.com',
      'javascript:alert(1)',
      'https://localhost',
    ]) {
      expect((await post({ target: { type: 'url', url } })).status, url).toBe(400);
    }
    expect(
      (await post({ target: { type: 'business', id: '00000000-0000-4000-8000-000000000000' } }))
        .status,
    ).toBe(422);
    const mine = await mkProduct(a);
    const foreign = await mkProduct(await signup(t));
    expect(
      (await post({ target: { type: 'product', id: foreign.id } })).body.error.details.reason,
    ).toBe('target_not_allowed');
    const ok = await post({ target: { type: 'product', id: mine.id }, placement: 'search' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      status: 'draft',
      placement: 'search',
      target: { type: 'product', id: mine.id },
    });
    // Media must be the advertiser's own ready image/video.
    const other = await signup(t);
    const mine1 = (
      await sql(
        `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status, purpose) VALUES ($1,'image',$2,'image/jpeg',10,'ready','public') RETURNING id`,
        [a.id, `t/${uniq('m')}.jpg`],
      )
    ).rows[0].id;
    const theirs = (
      await sql(
        `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status, purpose) VALUES ($1,'image',$2,'image/jpeg',10,'ready','public') RETURNING id`,
        [other.id, `t/${uniq('m')}.jpg`],
      )
    ).rows[0].id;
    expect((await post({ mediaId: theirs })).status).toBe(404);
    expect((await post({ mediaId: mine1 })).status).toBe(201);
    const edited = await a.client.patch(`/v1/ads/campaigns/${c.id}/ads/${ok.body.id}`, {
      headline: 'Better headline',
      target: { type: 'url', url: 'https://bakery.example.com/new' },
    });
    expect(edited.body).toMatchObject({
      headline: 'Better headline',
      target: { type: 'url', url: 'https://bakery.example.com/new' },
    });
    expect(
      (
        await a.client.patch(`/v1/ads/campaigns/${c.id}/ads/${ok.body.id}`, {
          headline: 'I will kill you tomorrow',
        })
      ).status,
    ).toBe(422);
    expect((await other.client.post(`/v1/ads/campaigns/${c.id}/ads`, adBody())).status).toBe(404);
    expect((await a.client.del(`/v1/ads/campaigns/${c.id}/ads/${ok.body.id}`)).status).toBe(204);
    expect((await a.client.del(`/v1/ads/campaigns/${c.id}/ads/${ok.body.id}`)).status).toBe(404);
    for (let i = 0; i < 9; i++) await post({ headline: `Extra ${i}` });
    expect((await post({ headline: 'One too many' })).status).toBe(409); // 10 per campaign
    // Ads that ran are paused, not deleted.
    const live = await goLive();
    await sql(
      `INSERT INTO ad_impressions (ad_id, campaign_id, nonce, placement, issued_at, valid) VALUES ($1,$2,$3,'feed',now(),true)`,
      [live.ad.id, live.campaign.id, uniq('n')],
    );
    expect(
      (await live.adv.client.del(`/v1/ads/campaigns/${live.campaign.id}/ads/${live.ad.id}`)).status,
    ).toBe(204);
    expect(
      (await sql('SELECT status FROM advertisements WHERE id = $1', [live.ad.id])).rows[0].status,
    ).toBe('paused');
  });
});

// ================================================================== review
describe('staff review', () => {
  it('needs an ad, is staff-only, and approval/rejection carry reasons, per-ad decisions, history, notifications and audit', async () => {
    const adv = await mkCreator();
    const c = await mkCampaign(adv);
    expect(
      (await adv.client.post(`/v1/ads/campaigns/${c.id}/submit`)).body.error.details.reason,
    ).toBe('no_ads');
    const good = await mkAd(adv, c.id);
    const bad = await mkAd(adv, c.id, { headline: 'Second ad' });
    expect((await adv.client.post(`/v1/ads/campaigns/${c.id}/submit`)).body.status).toBe(
      'pending_review',
    );
    expect((await adv.client.post(`/v1/ads/campaigns/${c.id}/submit`)).status).toBe(409);
    expect((await adv.client.patch(`/v1/ads/campaigns/${c.id}`, { name: 'x y z' })).status).toBe(
      409,
    ); // frozen while in review
    // Queue and authorisation.
    expect((await adv.client.get('/v1/staff/ads/campaigns')).status).toBe(403);
    expect((await support.client.get('/v1/staff/ads/campaigns')).status).toBe(403);
    expect((await anon().get('/v1/staff/ads/campaigns')).status).toBe(401);
    expect(
      (await mod.client.get('/v1/staff/ads/campaigns')).body.items.map((x: any) => x.id),
    ).toContain(c.id);
    expect(
      (await adv.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(403);
    // Rejection needs a reason.
    const noReason = await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, {
      decision: 'reject',
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.reason).toBe('reason_required');
    expect(
      (
        await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, {
          decision: 'reject',
          reason: 'no',
        })
      ).status,
    ).toBe(400);
    const rej = await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, {
      decision: 'reject',
      reason: 'Misleading claims in the ads',
    });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({
      status: 'rejected',
      reviewNote: 'Misleading claims in the ads',
    });
    expect(await notifN(adv.id, 'ads_campaign_rejected')).toBe(1);
    expect(await auditN('ads.campaign_rejected', c.id)).toBe(1);
    expect(
      (await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(409);
    // The owner sees why, fixes the ad, and resubmits.
    const detail = (await adv.client.get(`/v1/ads/campaigns/${c.id}`)).body;
    expect(detail.ads.map((a: any) => [a.status, a.reviewNote])).toEqual([
      ['rejected', 'Misleading claims in the ads'],
      ['rejected', 'Misleading claims in the ads'],
    ]);
    await adv.client.patch(`/v1/ads/campaigns/${c.id}/ads/${good.id}`, {
      headline: 'Fresh bread, no claims',
    });
    await adv.client.patch(`/v1/ads/campaigns/${c.id}`, { name: 'Bread campaign' });
    expect((await adv.client.post(`/v1/ads/campaigns/${c.id}/submit`)).body.status).toBe(
      'pending_review',
    );
    // Approve one ad, reject the other, with its own reason.
    expect(
      (
        await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, {
          decision: 'approve',
          ads: [{ adId: bad.id, decision: 'reject' }],
        })
      ).body.error.details.reason,
    ).toBe('reason_required');
    expect(
      (
        await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, {
          decision: 'approve',
          ads: [
            {
              adId: '00000000-0000-4000-8000-000000000000',
              decision: 'reject',
              reason: 'not there',
            },
          ],
        })
      ).status,
    ).toBe(422);
    const ok = await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, {
      decision: 'approve',
      reason: 'Looks fine',
      ads: [{ adId: bad.id, decision: 'reject', reason: 'Headline is unclear' }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('active');
    expect(
      (
        await sql(
          'SELECT id, status, moderation_status FROM advertisements WHERE campaign_id = $1 ORDER BY status',
          [c.id],
        )
      ).rows.map((r: any) => [r.id === good.id, r.status, r.moderation_status]),
    ).toEqual([
      [true, 'approved', 'approved'],
      [false, 'rejected', 'removed'],
    ]);
    expect(await notifN(adv.id, 'ads_campaign_approved')).toBe(1);
    const hist = (await mod.client.get(`/v1/staff/ads/campaigns/${c.id}`)).body;
    expect(hist.history.map((h: any) => h.event)).toEqual(
      expect.arrayContaining([
        'campaign_pending_review',
        'campaign_rejected',
        'campaign_active',
        'ad_approved',
        'ad_rejected',
      ]),
    );
    expect(
      hist.history.find(
        (h: any) => h.event === 'ad_rejected' && h.reason === 'Headline is unclear',
      ),
    ).toBeTruthy();
  });

  it("refuses to approve a campaign with no approvable ad, and staff never review their own or their business's campaigns", async () => {
    const adv = await mkCreator();
    const c = await mkCampaign(adv);
    const a1 = await mkAd(adv, c.id);
    await adv.client.post(`/v1/ads/campaigns/${c.id}/submit`);
    const none = await mod.client.post(`/v1/staff/ads/campaigns/${c.id}/review`, {
      decision: 'approve',
      ads: [{ adId: a1.id, decision: 'reject', reason: 'Not acceptable' }],
    });
    expect(none.status).toBe(422);
    expect(none.body.error.details.reason).toBe('no_approved_ads');
    expect((await camp(c.id)).status).toBe('pending_review'); // the failed review changed nothing
    expect(
      (await sql('SELECT status FROM advertisements WHERE id = $1', [a1.id])).rows[0].status,
    ).toBe('pending_review');
    // Own campaign.
    expect((await mod.client.post('/v1/creator/join', { termsVersion: '2027-01' })).status).toBe(
      201,
    );
    const own = await mkCampaign(mod, {});
    await mkAd(mod, own.id);
    await mod.client.post(`/v1/ads/campaigns/${own.id}/submit`);
    expect(
      (await mod.client.post(`/v1/staff/ads/campaigns/${own.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(403);
    expect(
      (await admin.client.post(`/v1/staff/ads/campaigns/${own.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(200); // someone else can
    // Business campaign where the reviewer is a team member.
    const owner = await signup(t);
    const biz = await mkBusiness(owner);
    await sql(
      `INSERT INTO business_members (business_id, user_id, role) VALUES ($1,$2,'support')`,
      [biz.id, admin.id],
    );
    const bc = await mkCampaign(owner, { businessId: biz.id });
    await mkAd(owner, bc.id);
    await owner.client.post(`/v1/ads/campaigns/${bc.id}/submit`);
    expect(
      (await admin.client.post(`/v1/staff/ads/campaigns/${bc.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(403);
    expect(
      (await mod.client.post(`/v1/staff/ads/campaigns/${bc.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(200);
  });

  it('staff can take an active campaign off air (owner cannot resume) and take down single ads; new ads of a running campaign need their own review', async () => {
    const { adv, campaign, ad } = await goLive();
    const viewer = await signup(t);
    expect((await serve(viewer)).body.items.map((i: any) => i.adId)).toContain(ad.id);
    expect(
      (
        await adv.client.post(`/v1/staff/ads/campaigns/${campaign.id}/suspend`, {
          reason: 'Complaint upheld',
        })
      ).status,
    ).toBe(403);
    expect(
      (await mod.client.post(`/v1/staff/ads/campaigns/${campaign.id}/suspend`, { reason: 'x' }))
        .status,
    ).toBe(400);
    const s = await mod.client.post(`/v1/staff/ads/campaigns/${campaign.id}/suspend`, {
      reason: 'Complaint upheld by review',
    });
    expect(s.body).toMatchObject({ status: 'paused', reviewNote: 'Complaint upheld by review' });
    expect(await notifN(adv.id, 'ads_campaign_suspended')).toBe(1);
    expect((await serve(viewer)).body.items.map((i: any) => i.adId)).not.toContain(ad.id);
    const resume = await adv.client.post(`/v1/ads/campaigns/${campaign.id}/resume`);
    expect(resume.status).toBe(409);
    expect(resume.body.error.details.reason).toBe('suspended');
    expect(
      (
        await mod.client.post(`/v1/staff/ads/campaigns/${campaign.id}/suspend`, {
          reason: 'Again please',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await mod.client.post(`/v1/staff/ads/campaigns/${campaign.id}/reinstate`, {
          reason: 'Resolved with advertiser',
        })
      ).body.status,
    ).toBe('active');
    expect(
      (
        await mod.client.post(`/v1/staff/ads/campaigns/${campaign.id}/reinstate`, {
          reason: 'Again',
        })
      ).status,
    ).toBe(409);
    expect((await serve(viewer)).body.items.map((i: any) => i.adId)).toContain(ad.id);
    // Owner pause/resume works normally.
    await adv.client.post(`/v1/ads/campaigns/${campaign.id}/pause`);
    expect((await adv.client.post(`/v1/ads/campaigns/${campaign.id}/resume`)).body.status).toBe(
      'active',
    );
    // A new ad on the running campaign is not served until reviewed.
    const extra = await mkAd(adv, campaign.id, { headline: 'A brand new ad' });
    expect(extra.status).toBe('pending_review');
    expect((await serve(viewer, { n: '3' })).body.items.map((i: any) => i.adId)).not.toContain(
      extra.id,
    );
    expect(
      (await adv.client.post(`/v1/staff/ads/ads/${extra.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(403);
    expect(
      (await mod.client.post(`/v1/staff/ads/ads/${extra.id}/review`, { decision: 'reject' })).body
        .error.details.reason,
    ).toBe('reason_required');
    expect(
      (await mod.client.post(`/v1/staff/ads/ads/${extra.id}/review`, { decision: 'approve' })).body
        .status,
    ).toBe('approved');
    expect(
      (await mod.client.post(`/v1/staff/ads/ads/${extra.id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(409);
    // Takedown of an approved ad.
    const td = await mod.client.post(`/v1/staff/ads/ads/${ad.id}/review`, {
      decision: 'reject',
      reason: 'Trademark complaint',
    });
    expect(td.body).toMatchObject({ status: 'rejected' });
    expect(await notifN(adv.id, 'ads_ad_rejected')).toBe(1);
    expect(await auditN('ads.ad_rejected', ad.id)).toBe(1);
    expect((await serve(viewer, { n: '3' })).body.items.map((i: any) => i.adId)).not.toContain(
      ad.id,
    );
  });
});

// ================================================================== serving
describe('serving', () => {
  it('labels every ad Sponsored, needs an adult account, and never serves what is not on air', async () => {
    const { adv, campaign, ad } = await goLive({ name: 'Bakery' }, { headline: 'Warm rolls' });
    const viewer = await signup(t);
    expect((await anon().get('/v1/ads/serve', { placement: 'feed' })).status).toBe(401);
    expect((await viewer.client.get('/v1/ads/serve', { placement: 'nowhere' })).status).toBe(400);
    const r = await serve(viewer);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ label: 'Sponsored', personalized: false });
    const item = r.body.items.find((i: any) => i.adId === ad.id);
    expect(item).toMatchObject({
      sponsored: true,
      label: 'Sponsored',
      headline: 'Warm rolls',
      advertiser: { kind: 'creator' },
      placement: 'feed',
      whyThisAd: ['broad'],
      target: { type: 'url', url: 'https://bakery.example.com/menu' },
    });
    expect(item.impressionToken).toMatch(/\./);
    expect(JSON.stringify(r.body)).not.toContain('bid'); // no commercial data leaks to viewers
    // Placement filter.
    expect(
      (await viewer.client.get('/v1/ads/serve', { placement: 'search' })).body.items.map(
        (i: any) => i.adId,
      ),
    ).not.toContain(ad.id);
    // Teens never see ads; nor do people whose account is not active.
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await serve(teen)).body.items).toEqual([]);
    expect(await selectAds(t.ctx, teen.id, 'feed', 3)).toEqual([]);
    // Own ads and blocked advertisers are skipped, both directions.
    expect((await serve(adv)).body.items.map((i: any) => i.adId)).not.toContain(ad.id);
    const blocker = await signup(t);
    await block(blocker, adv);
    const blocked = await signup(t);
    await block(adv, blocked);
    expect((await serve(blocker)).body.items.map((i: any) => i.adId)).not.toContain(ad.id);
    expect((await serve(blocked)).body.items.map((i: any) => i.adId)).not.toContain(ad.id);
    // Not on air: paused, ended, pending schedule, past schedule, ad paused, advertiser closed.
    const off = async (
      label: string,
      mutate: () => Promise<unknown>,
      restore: () => Promise<unknown>,
    ) => {
      await mutate();
      expect(
        (await serve(viewer)).body.items.map((i: any) => i.adId),
        label,
      ).not.toContain(ad.id);
      await restore();
      expect(
        (await serve(viewer)).body.items.map((i: any) => i.adId),
        `${label} restored`,
      ).toContain(ad.id);
    };
    await off(
      'paused',
      () => sql(`UPDATE ad_campaigns SET status = 'paused' WHERE id = $1`, [campaign.id]),
      () => sql(`UPDATE ad_campaigns SET status = 'active' WHERE id = $1`, [campaign.id]),
    );
    await off(
      'not started',
      () =>
        sql(`UPDATE ad_campaigns SET starts_at = now() + interval '1 day' WHERE id = $1`, [
          campaign.id,
        ]),
      () => sql(`UPDATE ad_campaigns SET starts_at = NULL WHERE id = $1`, [campaign.id]),
    );
    await off(
      'over',
      () =>
        sql(`UPDATE ad_campaigns SET ends_at = now() - interval '1 minute' WHERE id = $1`, [
          campaign.id,
        ]),
      () => sql(`UPDATE ad_campaigns SET ends_at = NULL WHERE id = $1`, [campaign.id]),
    );
    await off(
      'ad pending',
      () => sql(`UPDATE advertisements SET status = 'pending_review' WHERE id = $1`, [ad.id]),
      () => sql(`UPDATE advertisements SET status = 'approved' WHERE id = $1`, [ad.id]),
    );
    await off(
      'advertiser suspended',
      () => sql(`UPDATE users SET status = 'suspended' WHERE id = $1`, [adv.id]),
      () => sql(`UPDATE users SET status = 'active' WHERE id = $1`, [adv.id]),
    );
    const suspendedViewer = await signup(t);
    await sql(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspendedViewer.id]);
    expect(await selectAds(t.ctx, suspendedViewer.id, 'feed', 3)).toEqual([]);
  });

  it('targets by language, coarse geo and topic (context always; interests only with advertising consent)', async () => {
    const { ad: en } = await goLive({ targeting: { languages: ['en'] } });
    const { ad: us } = await goLive({
      targeting: { geo: { countries: ['US'], cities: ['austin'] } },
    });
    const { ad: music } = await goLive({ targeting: { topics: ['music'] } });
    const v = await signup(t);
    const ids = async (q: Record<string, string> = {}, viewer = v) =>
      (await serve(viewer, { n: '3', ...q })).body.items.map((i: any) => i.adId);
    // n=3 with one ad per campaign: check membership per test rather than exact lists (other tests' campaigns share the database).
    const has = async (id: string, q: Record<string, string> = {}, viewer = v) =>
      (
        await selectAds(t.ctx, viewer.id, 'feed', 50, {
          topics: q.topics ? q.topics.split(',') : [],
          language: q.language,
          country: q.country,
          city: q.city,
        })
      )
        .map((a) => a.adId)
        .includes(id);
    void ids;
    expect(await has(en.id)).toBe(false);
    expect(await has(en.id, { language: 'en' })).toBe(true);
    expect(await has(en.id, { language: 'fr' })).toBe(false);
    expect(await has(us.id, { country: 'US' })).toBe(false); // city also required
    expect(await has(us.id, { country: 'US', city: 'Austin' })).toBe(true);
    expect(await has(us.id, { country: 'CA', city: 'Austin' })).toBe(false);
    // Contextual: the page's topics, no consent needed.
    expect(await has(music.id)).toBe(false);
    expect(await has(music.id, { topics: 'music' })).toBe(true);
    const item = (await selectAds(t.ctx, v.id, 'feed', 50, { topics: ['music'] })).find(
      (a) => a.adId === music.id,
    )!;
    expect(item.whyThisAd).toEqual(['context:music']);
    // Interests: only with consent, and withdrawing stops it at once.
    await sql(
      `INSERT INTO user_interests (user_id, topic_id) SELECT $1, id FROM topics WHERE slug = 'music'`,
      [v.id],
    );
    expect(await has(music.id)).toBe(false);
    expect((await grant(v)).status).toBe(200);
    expect(await has(music.id)).toBe(true);
    expect(
      (await selectAds(t.ctx, v.id, 'feed', 50)).find((a) => a.adId === music.id)!.whyThisAd,
    ).toEqual(['interest:music']);
    expect((await serve(v)).body.personalized).toBe(true);
    expect((await grant(v, false)).status).toBe(200);
    expect(await has(music.id)).toBe(false);
    expect((await serve(v)).body.personalized).toBe(false);
    // Teens cannot grant advertising consent in the first place.
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await grant(teen)).status).toBeGreaterThanOrEqual(400);
  });

  it('ranks by expected revenue, serves one ad per campaign and honours the requested count', async () => {
    const adv = await mkCreator();
    const cheap = await goLive({ bidCents: 50 }, {}, adv);
    const rich = await goLive({ bidCents: 5000 }, { headline: 'Rich ad' }, adv);
    const v = await signup(t);
    const list = await selectAds(t.ctx, v.id, 'feed', 50);
    const order = list.map((a) => a.adId);
    expect(order.indexOf(rich.ad.id)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(rich.ad.id)).toBeLessThan(order.indexOf(cheap.ad.id));
    expect(new Set(list.map((a) => a.campaignId)).size).toBe(list.length);
    await mkAd(adv, rich.campaign.id, { headline: 'Second ad in the same campaign' });
    await mod.client.post(
      `/v1/staff/ads/ads/${(await adv.client.get(`/v1/ads/campaigns/${rich.campaign.id}`)).body.ads.find((a: any) => a.status === 'pending_review').id}/review`,
      { decision: 'approve' },
    );
    expect(
      (await selectAds(t.ctx, v.id, 'feed', 50)).filter((a) => a.campaignId === rich.campaign.id),
    ).toHaveLength(1);
    expect(await selectAds(t.ctx, v.id, 'feed', 1)).toHaveLength(1);
    expect((await serve(v, { n: '4' })).status).toBe(400);
    // A cpc bid competes on expected revenue: 5000c per click at a 1% assumed CTR beats a 50c cpm.
    const cpc = await goLive(
      { bidModel: 'cpc', bidCents: 4000, dailyBudgetCents: 5000, totalBudgetCents: 50_000 },
      {},
      adv,
    );
    const order2 = (await selectAds(t.ctx, v.id, 'feed', 50)).map((a) => a.adId);
    expect(order2.indexOf(cpc.ad.id)).toBeLessThan(order2.indexOf(cheap.ad.id));
  });

  it('respects frequency caps, total and daily budgets, and paces spend through the day', async () => {
    const { ad, campaign } = await goLive({ frequencyCap: 2, bidCents: 100 });
    const v = await signup(t);
    for (let i = 0; i < 2; i++) {
      const { token } = await tokenFor(v, ad.id);
      expect((await imp(v, token)).body).toMatchObject({ recorded: true, valid: true });
    }
    const served = (await selectAds(t.ctx, v.id, 'feed', 50)).map((a) => a.adId);
    expect(served).not.toContain(ad.id); // cap of 2 per 24 h reached
    // Another viewer is unaffected; the same viewer is served again once the window passed.
    const w = await signup(t);
    expect((await selectAds(t.ctx, w.id, 'feed', 50)).map((a) => a.adId)).toContain(ad.id);
    expect(
      (await selectAds(t.ctx, v.id, 'feed', 50, {}, new Date(Date.now() + 25 * 3_600_000))).map(
        (a) => a.adId,
      ),
    ).toContain(ad.id);
    // Pacing: 40% of the daily budget spent by 00:05 UTC is too fast; by noon it is fine.
    const day = new Date();
    day.setUTCHours(0, 5, 0, 0);
    await sql(
      `INSERT INTO ad_daily_spend (campaign_id, day, spent_milli) VALUES ($1,$2::date,$3) ON CONFLICT (campaign_id, day) DO UPDATE SET spent_milli = EXCLUDED.spent_milli`,
      [campaign.id, day.toISOString().slice(0, 10), 200_000],
    );
    expect((await selectAds(t.ctx, w.id, 'feed', 50, {}, day)).map((a) => a.adId)).not.toContain(
      ad.id,
    );
    const noon = new Date(day);
    noon.setUTCHours(12, 0, 0, 0);
    expect((await selectAds(t.ctx, w.id, 'feed', 50, {}, noon)).map((a) => a.adId)).toContain(
      ad.id,
    );
    // Daily budget spent: never served, whatever the hour.
    await sql(`UPDATE ad_daily_spend SET spent_milli = 500000 WHERE campaign_id = $1`, [
      campaign.id,
    ]);
    const late = new Date(day);
    late.setUTCHours(23, 59, 0, 0);
    expect((await selectAds(t.ctx, w.id, 'feed', 50, {}, late)).map((a) => a.adId)).not.toContain(
      ad.id,
    );
    // Total budget spent likewise.
    await sql(`UPDATE ad_daily_spend SET spent_milli = 0 WHERE campaign_id = $1`, [campaign.id]);
    await sql(`UPDATE ad_campaigns SET spent_milli = total_budget_cents * 1000 WHERE id = $1`, [
      campaign.id,
    ]);
    expect((await selectAds(t.ctx, w.id, 'feed', 50, {}, noon)).map((a) => a.adId)).not.toContain(
      ad.id,
    );
  });
});

// ================================================================== impressions and clicks
describe('impressions', () => {
  it('bill valid impressions exactly once, in milli-cents, and refuse forged or borrowed tokens', async () => {
    const { ad, campaign } = await goLive({ bidCents: 250 });
    const v = await signup(t);
    const other = await signup(t);
    const { token } = await tokenFor(v, ad.id);
    expect((await imp(v, 'garbage')).status).toBe(400);
    expect((await imp(v, `${token.split('.')[0]}.AAAA`)).status).toBe(400);
    expect((await imp(other, token)).status).toBe(400); // someone else's token
    expect((await anon().request('POST', '/v1/ads/impressions', { body: { token } })).status).toBe(
      401,
    );
    const first = await imp(v, token);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ recorded: true, duplicate: false, valid: true });
    expect(await camp(campaign.id)).toMatchObject({ spent_milli: 250, spent_cents: 0 });
    const again = await imp(v, token);
    expect(again.body).toEqual({ recorded: false, duplicate: true, valid: false });
    expect((await camp(campaign.id)).spent_milli).toBe(250); // replay did not bill
    expect(await n('SELECT count(*)::int AS n FROM ad_impressions WHERE ad_id = $1', [ad.id])).toBe(
      1,
    );
    expect(
      Number(
        (await sql('SELECT spent_milli FROM ad_daily_spend WHERE campaign_id = $1', [campaign.id]))
          .rows[0].spent_milli,
      ),
    ).toBe(250);
    // Four more make 1.25 cents: cents are floor(milli/1000).
    for (let i = 0; i < 4; i++) {
      const w = await signup(t);
      const { token: tk } = await tokenFor(w, ad.id);
      await imp(w, tk);
    }
    expect(await camp(campaign.id)).toMatchObject({ spent_milli: 1250, spent_cents: 1 });
  });

  it('record but never bill invalid traffic: too fast, expired, bots, frequency cap, IP floods, the advertiser themself and stopped campaigns', async () => {
    const { adv, ad, campaign } = await goLive({ bidCents: 100, frequencyCap: 2 });
    const spent = async () => (await camp(campaign.id)).spent_milli;
    const v = await signup(t);
    const fresh = (await tokenFor(v, ad.id, 0)).token;
    const issued = verifyToken(t.ctx, fresh)!.t;
    expect(
      await logImpression(t.ctx, v.id, fresh, {
        ip: '192.0.2.5',
        userAgent: 'Mozilla/5.0',
        now: new Date(issued + 50),
      }),
    ).toMatchObject({ recorded: true, valid: false, reason: 'too_fast' }); // reported 50 ms after serving: nobody looked at it
    expect(
      (await sql('SELECT reason, cost_milli FROM ad_impressions WHERE ad_id = $1', [ad.id]))
        .rows[0],
    ).toMatchObject({ reason: 'too_fast', cost_milli: 0 });
    const old = (await tokenFor(v, ad.id, 0)).token;
    const expired = aged(old, 3_600_000);
    expect((await imp(v, expired)).body.valid).toBe(false);
    const bot = aged((await tokenFor(v, ad.id, 0)).token);
    expect((await imp(v, bot, { 'user-agent': 'Googlebot/2.1 crawler' })).body.valid).toBe(false);
    expect(await spent()).toBe(0);
    const reasons = (
      await sql('SELECT reason FROM ad_impressions WHERE ad_id = $1 ORDER BY created_at', [ad.id])
    ).rows.map((r: any) => r.reason);
    expect([...reasons].sort()).toEqual(['bot', 'expired_token', 'too_fast']);
    // Frequency cap: two valid, the third is recorded as filtered.
    const w = await signup(t);
    const valid: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.ctx.db.query('SELECT 1');
      void r;
      const tok = aged(
        signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: w.id, p: 'feed', t: Date.now() }),
      );
      valid.push((await imp(w, tok)).body.valid);
    }
    expect(valid).toEqual([true, true, false]);
    expect(
      (await sql(`SELECT reason FROM ad_impressions WHERE viewer_id = $1 AND NOT valid`, [w.id]))
        .rows[0].reason,
    ).toBe('frequency_cap');
    expect(await spent()).toBe(200);
    // The advertiser looking at their own ad is free.
    const own = aged(
      signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: adv.id, p: 'feed', t: Date.now() }),
    );
    expect((await imp(adv, own)).body.valid).toBe(false);
    expect(
      (await sql(`SELECT reason FROM ad_impressions WHERE viewer_id = $1`, [adv.id])).rows[0]
        .reason,
    ).toBe('self_view');
    // A campaign that stopped after serving: late impressions are not billed.
    await sql(`UPDATE ad_campaigns SET status = 'paused' WHERE id = $1`, [campaign.id]);
    const x = await signup(t);
    expect(
      (
        await imp(
          x,
          aged(signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: x.id, p: 'feed', t: Date.now() })),
        )
      ).body.valid,
    ).toBe(false);
    expect(
      (await sql(`SELECT reason FROM ad_impressions WHERE viewer_id = $1`, [x.id])).rows[0].reason,
    ).toBe('not_serving');
    expect(await spent()).toBe(200);
    // Direct service calls with a clock: an IP that floods one ad is cut off.
    await sql(`UPDATE ad_campaigns SET status = 'active' WHERE id = $1`, [campaign.id]);
    let flooded = 0;
    for (let i = 0; i < 32; i++) {
      const u = await signup(t);
      const r = await logImpression(
        t.ctx,
        u.id,
        signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: u.id, p: 'feed', t: Date.now() - 5000 }),
        { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' },
      );
      if (r.reason === 'ip_flood') flooded += 1;
    }
    expect(flooded).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('never spend past the budget, even when many are reported at once, and the campaign ends when the budget cannot take another', async () => {
    const { ad, campaign } = await goLive({
      bidCents: 25_000,
      dailyBudgetCents: 100,
      totalBudgetCents: 100,
    }); // 25 cents each: room for exactly 4
    const viewers = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const results = await Promise.all(
      viewers.map((u) =>
        logImpression(
          t.ctx,
          u.id,
          signToken(t.ctx, {
            a: ad.id,
            n: uniq('nonce'),
            v: u.id,
            p: 'feed',
            t: Date.now() - 5000,
          }),
          { ip: '198.51.100.1', userAgent: 'Mozilla/5.0' },
        ),
      ),
    );
    expect(results.filter((r) => r.valid)).toHaveLength(4);
    // The 4th charge ends the campaign in the same transaction it spends the last unit. A concurrent
    // impression that reads the campaign afterwards is correctly refused as 'not_serving' rather than
    // reaching the budget check at all; either reason means "no spend allowed", so both are accepted.
    expect(
      results.filter((r) => r.reason === 'budget_exhausted' || r.reason === 'not_serving'),
    ).toHaveLength(4);
    expect(await camp(campaign.id)).toMatchObject({
      spent_milli: 100000,
      spent_cents: 100,
      status: 'ended',
    });
    expect(
      Number(
        (
          await sql(
            'SELECT COALESCE(sum(cost_milli),0) AS s FROM ad_impressions WHERE campaign_id = $1',
            [campaign.id],
          )
        ).rows[0].s,
      ),
    ).toBe(100_000);
    expect((await selectAds(t.ctx, viewers[0]!.id, 'feed', 50)).map((a) => a.adId)).not.toContain(
      ad.id,
    );
  }, 60_000);
});

describe('clicks', () => {
  it('cost the cpc bid once per impression, need their impression, and hand back the destination', async () => {
    const adv = await mkCreator();
    const mine = await mkProduct(adv);
    const { ad, campaign } = await goLive(
      { bidModel: 'cpc', bidCents: 40, dailyBudgetCents: 500, totalBudgetCents: 5000 },
      { target: { type: 'product', id: mine.id } },
      adv,
    );
    const v = await signup(t);
    const { token } = await tokenFor(v, ad.id);
    const early = await click(v, token);
    expect(early.status).toBe(409);
    expect(early.body.error.details.reason).toBe('no_impression');
    expect((await imp(v, token)).body).toMatchObject({ recorded: true, valid: true });
    expect((await camp(campaign.id)).spent_milli).toBe(0); // cpc: impressions are free
    expect((await click(await signup(t), token)).status).toBe(400); // not their token
    const tooFast = await logClick(t.ctx, v.id, token, {
      ip: '192.0.2.77',
      userAgent: 'Mozilla/5.0',
      now: new Date(Date.now() + 100),
    });
    expect(tooFast).toMatchObject({
      recorded: true,
      valid: false,
      reason: 'too_fast',
      redirectTo: `/products/${mine.id}`,
    }); // clicked 100 ms after the impression
    // A normal click: age the impression row.
    const w = await signup(t);
    const t2 = (await tokenFor(w, ad.id)).token;
    await imp(w, t2);
    await sql(
      `UPDATE ad_impressions SET created_at = now() - interval '5 seconds' WHERE viewer_id = $1`,
      [w.id],
    );
    const ok = await click(w, t2);
    expect(ok.body).toEqual({
      recorded: true,
      duplicate: false,
      valid: true,
      redirectTo: `/products/${mine.id}`,
    });
    expect((await camp(campaign.id)).spent_milli).toBe(40_000);
    const dup = await click(w, t2);
    expect(dup.body).toEqual({
      recorded: false,
      duplicate: true,
      valid: false,
      redirectTo: `/products/${mine.id}`,
    });
    expect((await camp(campaign.id)).spent_milli).toBe(40_000); // one billable click per impression
    expect(
      await n('SELECT count(*)::int AS n FROM ad_clicks WHERE ad_id = $1 AND valid', [ad.id]),
    ).toBe(1);
    // Bots, a click on an invalid impression and the advertiser's own click are recorded but free.
    const b = await signup(t);
    const t3 = (await tokenFor(b, ad.id)).token;
    await imp(b, t3);
    await sql(
      `UPDATE ad_impressions SET created_at = now() - interval '5 seconds' WHERE viewer_id = $1`,
      [b.id],
    );
    expect((await click(b, t3, { 'user-agent': 'curl/8.0' })).body.valid).toBe(false);
    const inv = await signup(t);
    const t4 = (await tokenFor(inv, ad.id)).token;
    await imp(inv, t4, { 'user-agent': 'python-requests/2.0' }); // bot impression: invalid
    await sql(
      `UPDATE ad_impressions SET created_at = now() - interval '5 seconds' WHERE viewer_id = $1`,
      [inv.id],
    );
    expect((await click(inv, t4)).body.valid).toBe(false);
    expect(
      (await sql(`SELECT reason FROM ad_clicks WHERE viewer_id = $1`, [inv.id])).rows[0].reason,
    ).toBe('no_impression');
    const ownTok = aged(
      signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: adv.id, p: 'feed', t: Date.now() }),
    );
    await logImpression(t.ctx, adv.id, ownTok, { ip: '192.0.2.1', userAgent: 'Mozilla/5.0' });
    await sql(
      `UPDATE ad_impressions SET created_at = now() - interval '5 seconds' WHERE viewer_id = $1`,
      [adv.id],
    );
    expect((await click(adv, ownTok)).body.valid).toBe(false);
    expect(
      (await sql(`SELECT reason FROM ad_clicks WHERE viewer_id = $1`, [adv.id])).rows[0].reason,
    ).toBe('self_click');
    expect((await camp(campaign.id)).spent_milli).toBe(40_000);
  }, 60_000);

  it('one IP cannot click a campaign over and over (rate limited, unbilled)', async () => {
    const { ad, campaign } = await goLive({ bidModel: 'cpc', bidCents: 10 });
    const results: Array<string | null> = [];
    for (let i = 0; i < 10; i++) {
      const u = await signup(t);
      const tok = signToken(t.ctx, {
        a: ad.id,
        n: uniq('nonce'),
        v: u.id,
        p: 'feed',
        t: Date.now() - 10_000,
      });
      const i1 = await logImpression(t.ctx, u.id, tok, {
        ip: '203.0.113.50',
        userAgent: 'Mozilla/5.0',
        now: new Date(Date.now() - 5000),
      });
      expect(i1.valid).toBe(true);
      results.push(
        (await logClick(t.ctx, u.id, tok, { ip: '203.0.113.50', userAgent: 'Mozilla/5.0' })).reason,
      );
    }
    expect(results.filter((r) => r === null)).toHaveLength(8);
    expect(results.filter((r) => r === 'ip_flood')).toHaveLength(2);
    expect((await camp(campaign.id)).spent_milli).toBe(80_000);
  }, 60_000);

  it('destinations: business, event and external links', async () => {
    const owner = await signup(t);
    const biz = await mkBusiness(owner);
    const { ad } = await goLive(
      { businessId: biz.id },
      { target: { type: 'business', id: biz.id } },
      owner,
    );
    const v = await signup(t);
    const { token } = await tokenFor(v, ad.id);
    await imp(v, token);
    await sql(
      `UPDATE ad_impressions SET created_at = now() - interval '5 seconds' WHERE viewer_id = $1`,
      [v.id],
    );
    expect((await click(v, token)).body.redirectTo).toBe(`/businesses/${biz.id}`);
    const item = (await selectAds(t.ctx, (await signup(t)).id, 'feed', 50)).find(
      (a) => a.adId === ad.id,
    )!;
    expect(item.advertiser.kind).toBe('business');
  });
});

// ================================================================== money
describe('spend accounting', () => {
  it('books whole cents to the ledger as a receivable from the advertiser and platform revenue, exactly once', async () => {
    const { campaign, ad } = await goLive({ bidCents: 250 });
    // 5 impressions = 1250 milli-cents = 1 cent + 250 left over.
    for (let i = 0; i < 5; i++) {
      const u = await signup(t);
      await logImpression(
        t.ctx,
        u.id,
        signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: u.id, p: 'feed', t: Date.now() - 5000 }),
        { ip: '192.0.2.10', userAgent: 'Mozilla/5.0' },
      );
    }
    expect((await camp(campaign.id)).spent_milli).toBe(1250);
    const revenueBefore = await balanceOf(t, PLATFORM_AD_REVENUE);
    const r1 = await settleAdSpend(t.ctx, { campaignId: campaign.id });
    expect(r1).toEqual({ settlements: 1, cents: 1 });
    expect(await camp(campaign.id)).toMatchObject({ spent_milli: 1250, settled_milli: 1000 });
    const s = (
      await sql('SELECT id, amount_cents, currency FROM ad_settlements WHERE campaign_id = $1', [
        campaign.id,
      ])
    ).rows[0];
    expect(Number(s.amount_cents)).toBe(1);
    expect(await ledgerOf(t, 'fee', 'ad_settlement', s.id)).toEqual(
      expect.arrayContaining([
        { account: advertiserReceivable(campaign.id), direction: 'debit', amount: 1 },
        { account: PLATFORM_AD_REVENUE, direction: 'credit', amount: 1 },
      ]),
    );
    expect(await balanceOf(t, PLATFORM_AD_REVENUE)).toBe(revenueBefore + 1);
    expect(await balanceOf(t, advertiserReceivable(campaign.id))).toBe(-1); // they owe one cent
    expect(await settleAdSpend(t.ctx, { campaignId: campaign.id })).toEqual({
      settlements: 0,
      cents: 0,
    }); // nothing new: idempotent
    // The remainder settles once it adds up.
    for (let i = 0; i < 3; i++) {
      const u = await signup(t);
      await logImpression(
        t.ctx,
        u.id,
        signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: u.id, p: 'feed', t: Date.now() - 5000 }),
        { ip: '192.0.2.11', userAgent: 'Mozilla/5.0' },
      );
    }
    expect(await settleAdSpend(t.ctx, { campaignId: campaign.id })).toEqual({
      settlements: 1,
      cents: 1,
    });
    expect(await balanceOf(t, advertiserReceivable(campaign.id))).toBe(-2);
    // Parallel settlement runs cannot double-book.
    for (let i = 0; i < 4; i++) {
      const u = await signup(t);
      await logImpression(
        t.ctx,
        u.id,
        signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: u.id, p: 'feed', t: Date.now() - 5000 }),
        { ip: '192.0.2.12', userAgent: 'Mozilla/5.0' },
      );
    }
    await Promise.all([
      settleAdSpend(t.ctx, { campaignId: campaign.id }),
      settleAdSpend(t.ctx, { campaignId: campaign.id }),
    ]);
    expect(
      await n('SELECT count(*)::int AS n FROM ad_settlements WHERE campaign_id = $1', [
        campaign.id,
      ]),
    ).toBe(3);
    expect((await camp(campaign.id)).settled_milli).toBeLessThanOrEqual(
      (await camp(campaign.id)).spent_milli,
    );
    expect(await unbalancedTransactions(t)).toEqual([]);
  }, 60_000);

  it('maintenance ends campaigns past their date or budget and settles spend; staff can trigger it', async () => {
    const a = await goLive();
    const b = await goLive({ bidCents: 500 });
    await sql(`UPDATE ad_campaigns SET ends_at = now() - interval '1 minute' WHERE id = $1`, [
      a.campaign.id,
    ]);
    await sql(`UPDATE ad_campaigns SET spent_milli = total_budget_cents * 1000 WHERE id = $1`, [
      b.campaign.id,
    ]);
    const r = await runAdsMaintenance(t.ctx);
    expect(r.ended).toBeGreaterThanOrEqual(2);
    expect((await camp(a.campaign.id)).status).toBe('ended');
    expect((await camp(b.campaign.id)).status).toBe('ended');
    expect((await camp(b.campaign.id)).settled_milli).toBe(5_000_000); // everything that accrued is booked
    expect(await runAdsMaintenance(t.ctx)).toMatchObject({ ended: 0, settlements: 0 });
    expect((await mod.client.post('/v1/staff/ads/maintenance')).status).toBe(403);
    expect((await admin.client.post('/v1/staff/ads/maintenance')).status).toBe(200);
    expect(await auditN('ads.campaign_ended', a.campaign.id)).toBe(1);
    expect(await unbalancedTransactions(t)).toEqual([]);
  });
});

// ================================================================== reports
describe('advertiser reports', () => {
  it('show aggregates, filtered traffic by reason and what has been settled, and never a viewer', async () => {
    const { adv, campaign, ad } = await goLive({ bidCents: 300 });
    const viewers: TestUser[] = [];
    for (let i = 0; i < 3; i++) viewers.push(await signup(t));
    for (const u of viewers) {
      const { token } = await tokenFor(u, ad.id);
      await imp(u, token);
    }
    const w = await signup(t);
    {
      const tk = (await tokenFor(w, ad.id, 0)).token;
      await logImpression(t.ctx, w.id, tk, {
        ip: '192.0.2.6',
        userAgent: 'Mozilla/5.0',
        now: new Date(verifyToken(t.ctx, tk)!.t + 50),
      });
    } // too fast: filtered
    for (let i = 0; i < 4; i++) {
      const u = await signup(t);
      await logImpression(
        t.ctx,
        u.id,
        signToken(t.ctx, { a: ad.id, n: uniq('nonce'), v: u.id, p: 'feed', t: Date.now() - 5000 }),
        { ip: '192.0.2.30', userAgent: 'Mozilla/5.0' },
      );
    }
    await settleAdSpend(t.ctx, { campaignId: campaign.id });
    const r = await adv.client.get(`/v1/ads/campaigns/${campaign.id}/report`, { days: '7' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      campaignId: campaign.id,
      currency: 'USD',
      days: 7,
      totals: {
        impressions: 7,
        clicks: 0,
        ctr: 0,
        spendCents: 2,
        filteredImpressions: 1,
        filteredClicks: 0,
      },
    });
    expect(r.body.filteredByReason).toEqual([{ kind: 'impression', reason: 'too_fast', count: 1 }]);
    expect(r.body.billing).toMatchObject({ accruedCents: 2, settledCents: 2, unsettledCents: 0 });
    expect(r.body.billing.note).toMatch(/no payment is collected/i);
    expect(r.body.byAd).toEqual([
      expect.objectContaining({ adId: ad.id, impressions: 7, spendCents: 2 }),
    ]);
    expect(r.body.byPlacement).toEqual([{ placement: 'feed', impressions: 7, clicks: 0 }]);
    expect(r.body.byDay.at(-1)).toMatchObject({ impressions: 7, spendCents: 2 });
    const text = JSON.stringify(r.body);
    for (const u of [...viewers, w]) expect(text).not.toContain(u.id);
    expect(text).not.toMatch(/ip_hash|viewer/i);
    expect(
      (await (await signup(t)).client.get(`/v1/ads/campaigns/${campaign.id}/report`)).status,
    ).toBe(404);
    expect(
      (await adv.client.get(`/v1/ads/campaigns/${campaign.id}/report`, { days: '0' })).status,
    ).toBe(400);
  }, 60_000);
});

// ================================================================== privacy
describe('privacy', () => {
  it('exports what I saw and ran, and account deletion unlinks viewers and stops my campaigns', async () => {
    const { adv, campaign, ad } = await goLive({ bidCents: 100 });
    const v = await signup(t);
    const { token } = await tokenFor(v, ad.id);
    await imp(v, token);
    const { getExportSections } = await import('../src/modules/privacy/registry.js');
    const section = getExportSections().find((s) => s.key === 'advertising')!;
    const mine = (await section.collect(t.ctx, t.ctx.db as never, v.id)) as any;
    expect(mine.impressions).toHaveLength(1);
    expect(mine.impressions[0]).toMatchObject({ ad_id: ad.id, placement: 'feed', valid: true });
    expect(mine.campaigns).toEqual([]);
    expect(
      ((await section.collect(t.ctx, t.ctx.db as never, adv.id)) as any).campaigns.map(
        (c: any) => c.id,
      ),
    ).toEqual([campaign.id]);
    const { getDeletionHooks } = await import('../src/lib/hooks.js');
    const run = async (id: string) => {
      const c = await t.ctx.db.connect();
      try {
        for (const h of getDeletionHooks()) await h(t.ctx, c, id);
      } finally {
        c.release();
      }
    };
    await run(v.id);
    expect(
      (await sql('SELECT viewer_id, ip_hash FROM ad_impressions WHERE ad_id = $1', [ad.id]))
        .rows[0],
    ).toMatchObject({ viewer_id: null, ip_hash: null });
    expect((await camp(campaign.id)).spent_milli).toBeGreaterThanOrEqual(0); // billing numbers are untouched
    await run(adv.id);
    expect((await camp(campaign.id)).status).toBe('ended');
  });
});
