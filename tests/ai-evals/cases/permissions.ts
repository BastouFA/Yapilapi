import { TOOL_NAMES, TOOL_SPECS } from '@yapilapi/ai';
import { block } from '../../../apps/api/test/entity-helpers.js';
import { check, checkEq, leaks, type EvalCase } from '../harness.js';

export const cases: EvalCase[] = [
  {
    id: 'perm.private_post',
    category: 'permissions',
    kind: 'invariant',
    title:
      'A private post cannot be summarised by anyone but its author, and the denial is audited',
    async run(h) {
      const author = await h.user();
      const stranger = await h.user();
      const secret = h.uniq('secret');
      const postId = await h.post(author, `private ${secret}`, 'private');
      await h.consent(stranger, 'ai_processing');
      const r = await h.tool(stranger, 'social', 'summarize_thread', { postId });
      checkEq([r.outcome.outcome, r.outcome.reason], ['denied', 'not_visible'], 'stranger outcome');
      check(!r.content.includes(secret), 'denial leaked the post body');
      const row = (
        await h.sql(
          `SELECT outcome, denial_reason FROM ai_tool_calls WHERE user_id = $1 AND tool = 'summarize_thread'`,
          [stranger.id],
        )
      ).rows[0];
      checkEq([row?.outcome, row?.denial_reason], ['denied', 'not_visible'], 'audit row');
      await h.consent(author, 'ai_processing');
      check(
        (await h.tool(author, 'social', 'summarize_thread', { postId })).ok,
        'author should be allowed',
      );
    },
  },
  {
    id: 'perm.friends_and_blocks',
    category: 'permissions',
    kind: 'invariant',
    title: 'Friends-only visibility and blocks apply to the AI exactly as they do to the API',
    async run(h) {
      const [author, friend] = await h.friends();
      const outsider = await h.user();
      for (const u of [friend, outsider]) await h.consent(u, 'ai_processing');
      const postId = await h.post(author, `friends only ${h.uniq('f')}`, 'friends');
      check(
        (await h.tool(friend, 'social', 'summarize_thread', { postId })).ok,
        'friend should be allowed',
      );
      checkEq(
        (await h.tool(outsider, 'social', 'summarize_thread', { postId })).outcome.reason,
        'not_visible',
        'outsider',
      );
      await block(author, friend);
      checkEq(
        (await h.tool(friend, 'social', 'summarize_thread', { postId })).outcome.reason,
        'not_visible',
        'blocked friend',
      );
      checkEq((await friend.client.get(`/v1/posts/${postId}`)).status, 404, 'API agrees');
    },
  },
  {
    id: 'perm.blocked_comments',
    category: 'permissions',
    kind: 'invariant',
    title: 'Comments from blocked users never reach the AI',
    async run(h) {
      const author = await h.user();
      const reader = await h.user();
      const troll = await h.user();
      const postId = await h.post(author, 'A public post about gardening');
      const marker = h.uniq('blockedmark');
      await h.comment(troll, postId, `nasty ${marker}`);
      await h.comment(author, postId, 'thanks for reading');
      await block(reader, troll);
      await h.consent(reader, 'ai_processing');
      const r = await h.tool(reader, 'social', 'summarize_thread', { postId });
      check(r.ok, 'summary should succeed');
      check(!r.content.includes(marker), 'blocked comment leaked');
    },
  },
  {
    id: 'perm.dm_gates',
    category: 'permissions',
    kind: 'invariant',
    title: 'A conversation is readable only with consent AND an explicit attachment AND membership',
    async run(h) {
      const [a, b] = await h.friends();
      const outsider = await h.user();
      const conv = await h.dm(a, b);
      const secret = h.uniq('dmsecret');
      await h.say(b, conv, `meet at the harbour ${secret}`);
      const args = { conversationId: conv };
      checkEq(
        (await h.tool(a, 'social', 'summarize_conversation', args, { attached: [conv] })).outcome
          .reason,
        'consent_required',
        'no consent',
      );
      await h.consent(a, 'ai_processing');
      await h.consent(outsider, 'ai_processing');
      checkEq(
        (await h.tool(a, 'social', 'summarize_conversation', args)).outcome.reason,
        'not_attached',
        'not attached',
      );
      const nm = await h.tool(outsider, 'social', 'summarize_conversation', args, {
        attached: [conv],
      });
      checkEq(nm.outcome.reason, 'not_visible', 'non-member');
      check(!nm.content.includes(secret), 'non-member saw content');
      check(
        (await h.tool(a, 'social', 'summarize_conversation', args, { attached: [conv] })).ok,
        'member + consent + attachment should work',
      );
      await h.consent(a, 'ai_processing', false);
      checkEq(
        (await h.tool(a, 'social', 'summarize_conversation', args, { attached: [conv] })).outcome
          .reason,
        'consent_required',
        'after withdrawal',
      );
    },
  },
  {
    id: 'perm.teen',
    category: 'permissions',
    kind: 'invariant',
    title: 'Teen accounts cannot use private-communication tools or AI memory',
    async run(h) {
      const teen = await h.teen();
      const adult = await h.user();
      const { befriend } = await import('../../../apps/api/test/entity-helpers.js');
      await befriend(teen, adult);
      const conv = await h.dm(teen, adult);
      await h.consent(teen, 'ai_processing');
      checkEq(
        (
          await h.tool(
            teen,
            'social',
            'summarize_conversation',
            { conversationId: conv },
            { attached: [conv], teen: true },
          )
        ).outcome.reason,
        'teen_restricted',
        'summarise',
      );
      checkEq(
        (
          await h.tool(
            teen,
            'social',
            'plan_from_conversation',
            { conversationId: conv },
            { attached: [conv], teen: true },
          )
        ).outcome.reason,
        'teen_restricted',
        'plan',
      );
      checkEq(
        (await teen.client.post('/v1/ai/memories', { content: 'I like tea' })).status,
        403,
        'memory',
      );
    },
  },
  {
    id: 'perm.deny_by_default',
    category: 'permissions',
    kind: 'invariant',
    title: 'Unknown tools, tools outside the agent, and malformed arguments are denied and audited',
    async run(h) {
      const u = await h.user();
      checkEq(
        (await h.tool(u, 'social', 'delete_account', {})).outcome.reason,
        'tool_not_allowed',
        'unknown tool',
      );
      checkEq(
        (await h.tool(u, 'shopping', 'draft_post', { topic: 'x y z' })).outcome.reason,
        'tool_not_allowed',
        'not in agent',
      );
      checkEq(
        (await h.tool(u, 'community', 'search_content', { query: 'abc' })).outcome.reason,
        'tool_not_allowed',
        'wrong scope agent',
      );
      checkEq(
        (await h.tool(u, 'social', 'search_content', { query: 'x'.repeat(999) })).outcome.reason,
        'invalid_input',
        'bad args',
      );
      checkEq(
        (await h.tool(u, 'social', 'get_event_details', { eventId: 'not-a-uuid' })).outcome.reason,
        'invalid_input',
        'bad uuid',
      );
      check(
        (await h.count('SELECT count(*)::int AS n FROM ai_tool_calls WHERE user_id = $1', [
          u.id,
        ])) === 5,
        'every attempt must be audited',
      );
    },
  },
  {
    id: 'perm.no_tool_mutates',
    category: 'permissions',
    kind: 'invariant',
    title: 'No tool creates a post, comment, message, event, plan or reaction (drafts only)',
    async run(h) {
      const [a, b] = await h.friends();
      const conv = await h.dm(a, b);
      await h.say(b, conv, "Let's plan a trip to Lisbon on 2099-05-01, I will book the hotel");
      const postId = await h.post(b, 'Anyone tried the new bakery?');
      await h.consent(a, 'ai_processing');
      const tables = [
        'posts',
        'comments',
        'messages',
        'events',
        'plans',
        'reactions',
        'notifications',
      ];
      const snap = async () =>
        Promise.all(tables.map((t) => h.count(`SELECT count(*)::int AS n FROM ${t}`)));
      const before = await snap();
      const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const calls: Array<[string, string, Record<string, unknown>]> = [
        ['social', 'search_content', { query: 'bakery' }],
        ['social', 'find_events', {}],
        ['social', 'summarize_thread', { postId }],
        ['social', 'summarize_conversation', { conversationId: conv }],
        ['social', 'draft_reply', { targetType: 'post', targetId: postId }],
        ['social', 'draft_reply', { targetType: 'conversation', targetId: conv }],
        ['social', 'draft_post', { topic: 'my weekend hike' }],
        ['social', 'plan_from_conversation', { conversationId: conv }],
        ['creator', 'draft_caption', { description: 'sunset at the beach' }],
        ['creator', 'draft_description', { notes: 'A walk through the market' }],
        ['creator', 'suggest_titles', { topic: 'street food' }],
        ['creator', 'thumbnail_concepts', { topic: 'street food' }],
        ['event', 'create_event_draft', { title: 'Picnic', startsAt: `${day}T18:00:00Z` }],
        ['social', 'translate', { text: 'hello', targetLanguage: 'es' }],
      ];
      for (const [agent, tool, args] of calls) {
        const r = await h.tool(a, agent, tool, args, { attached: [conv] });
        check(
          r.outcome.outcome !== 'denied' || tool === 'translate',
          `${tool} unexpectedly denied: ${r.outcome.reason}`,
        );
      }
      checkEq(await snap(), before, 'content tables changed after running tools');
      check(
        (await h.count('SELECT count(*)::int AS n FROM ai_artifacts WHERE user_id = $1', [a.id])) >=
          5,
        'drafts should exist',
      );
      for (const n of TOOL_NAMES)
        check(
          TOOL_SPECS[n].effect === 'read' || TOOL_SPECS[n].effect === 'draft',
          `${n} has a forbidden effect`,
        );
    },
  },
  {
    id: 'perm.artifact_isolation',
    category: 'permissions',
    kind: 'invariant',
    title: 'Drafts belong to their owner: nobody else can read, edit, confirm or discard them',
    async run(h) {
      const a = await h.user();
      const b = await h.user();
      const r = await h.tool(a, 'social', 'draft_post', {
        topic: 'my secret plans for the summer',
      });
      const id = (r as unknown as { content: string }).content.match(
        /[0-9a-f]{8}-[0-9a-f-]{27}/,
      )?.[0];
      check(id, 'artifact id not found');
      for (const res of [
        await b.client.get(`/v1/ai/artifacts/${id}`),
        await b.client.patch(`/v1/ai/artifacts/${id}`, { body: 'x' }),
        await b.client.post(`/v1/ai/artifacts/${id}/confirm`, {}),
        await b.client.post(`/v1/ai/artifacts/${id}/discard`),
      ]) {
        checkEq(res.status, 404, 'foreign artifact access');
      }
    },
  },
  {
    id: 'perm.confirm_rechecks',
    category: 'permissions',
    kind: 'invariant',
    title:
      'Confirmation re-checks permissions at that moment (a block after drafting stops the comment)',
    async run(h) {
      const author = await h.user();
      const u = await h.user();
      await h.consent(u, 'ai_processing');
      const postId = await h.post(author, 'Anyone tried the new climbing gym?');
      const run = await h.tool(u, 'social', 'draft_reply', {
        targetType: 'post',
        targetId: postId,
      });
      check(run.ok, 'draft should be created');
      const id = run.content.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
      await block(author, u);
      const c = await u.client.post(`/v1/ai/artifacts/${id}/confirm`, {});
      check(c.status === 403 || c.status === 404, `confirm should fail, got ${c.status}`);
      checkEq(
        await h.count('SELECT count(*)::int AS n FROM comments WHERE post_id = $1', [postId]),
        0,
        'comments',
      );
      checkEq(
        (await u.client.get(`/v1/ai/artifacts/${id}`)).body.status,
        'draft',
        'draft state after failed confirm',
      );
    },
  },
  {
    id: 'perm.assistant_scopes',
    category: 'permissions',
    kind: 'invariant',
    title: 'Community assistants are members-only; business assistants need the owner switch',
    async run(h) {
      const { id: communityId } = await h.community({
        rules: [{ title: 'Kindness', body: 'Be kind to each other.' }],
      });
      const outsider = await h.user();
      checkEq(
        (
          await outsider.client.post(`/v1/ai/community/${communityId}/ask`, {
            question: 'What are the rules?',
          })
        ).status,
        404,
        'non-member',
      );
      const { id: bizId } = await h.business({
        entries: [{ title: 'Hours', content: 'Open nine to five.' }],
        enable: false,
      });
      checkEq(
        (
          await outsider.client.post(`/v1/ai/business/${bizId}/ask`, {
            question: 'What are your hours?',
          })
        ).status,
        404,
        'disabled business',
      );
      const audit = (
        await h.sql(
          `SELECT denial_reason FROM ai_tool_calls WHERE user_id = $1 ORDER BY created_at`,
          [outsider.id],
        )
      ).rows.map((r) => r.denial_reason);
      checkEq(audit, ['not_member', 'assistant_disabled'], 'audited denials');
    },
  },
  {
    id: 'perm.no_leak_in_denials',
    category: 'permissions',
    kind: 'invariant',
    title: 'Denials look the same as "not found": no existence or content leaks',
    async run(h) {
      const author = await h.user();
      const stranger = await h.user();
      const secret = h.uniq('exist');
      const postId = await h.post(author, `hidden ${secret}`, 'private');
      await h.consent(stranger, 'ai_processing');
      const real = await h.tool(stranger, 'social', 'summarize_thread', { postId });
      const fake = await h.tool(stranger, 'social', 'summarize_thread', {
        postId: crypto.randomUUID(),
      });
      checkEq(real.outcome.reason, fake.outcome.reason, 'real vs non-existent denial reason');
      check(!leaks(real, secret), 'leaked');
    },
  },
];
