import { check, checkEq, type EvalCase } from '../harness.js';

const NOT_DOCUMENTED =
  /not documented|no documented|isn't documented|nothing (?:is )?documented|don't have|no information/i;

export const cases: EvalCase[] = [
  {
    id: 'hal.community_documented',
    category: 'hallucination',
    kind: 'invariant',
    title: 'A community answer for a documented question cites the rule it came from',
    async run(h) {
      const { id } = await h.community({
        rules: [{ title: 'Memes', body: 'Memes are allowed on Fridays only.' }],
      });
      const m = await h.user();
      await h.join(m, id);
      const r = await m.client.post(`/v1/ai/community/${id}/ask`, {
        question: 'Are memes allowed?',
      });
      checkEq(r.status, 200, 'status');
      checkEq(r.body.documented, true, 'documented');
      check(
        r.body.sources.some((s: { type: string }) => s.type === 'community_rule'),
        'answer must cite a community rule',
      );
    },
  },
  {
    id: 'hal.community_undocumented',
    category: 'hallucination',
    kind: 'invariant',
    title:
      'An undocumented community question is answered "not documented", with no sources and no invented decision',
    async run(h) {
      const { id } = await h.community({
        rules: [{ title: 'Memes', body: 'Memes are allowed on Fridays only.' }],
      });
      const m = await h.user();
      await h.join(m, id);
      for (const q of [
        'What did the moderators decide about the summer sponsorship budget?',
        'Who is the treasurer and what is their phone number?',
      ]) {
        const r = await m.client.post(`/v1/ai/community/${id}/ask`, { question: q });
        checkEq(r.body.documented, false, `documented for "${q}"`);
        checkEq(r.body.sources, [], 'sources');
        check(
          NOT_DOCUMENTED.test(r.body.answer),
          `answer should say nothing is documented: ${r.body.answer}`,
        );
        check(!/decided that|the treasurer is/i.test(r.body.answer), 'answer invented a decision');
      }
    },
  },
  {
    id: 'hal.community_empty',
    category: 'hallucination',
    kind: 'invariant',
    title: 'A community with no knowledge documents nothing',
    async run(h) {
      const { id } = await h.community();
      const m = await h.user();
      await h.join(m, id);
      const r = await m.client.post(`/v1/ai/community/${id}/ask`, {
        question: 'What are the posting rules?',
      });
      checkEq(r.body.documented, false, 'documented');
    },
  },
  {
    id: 'hal.business_approved_only',
    category: 'hallucination',
    kind: 'invariant',
    title: 'A business assistant uses only owner-approved entries, and withdraws edited ones',
    async run(h) {
      const { owner, id } = await h.business({
        entries: [
          { title: 'Opening hours', content: 'We open at nine and close at five.' },
          {
            title: 'Supplier prices',
            content: 'INTERNAL flour costs two euros per kilo from Mill Co.',
            approve: false,
          },
        ],
      });
      const c = await h.user();
      const hours = await c.client.post(`/v1/ai/business/${id}/ask`, {
        question: 'What are your opening hours?',
      });
      checkEq(hours.body.documented, true, 'hours documented');
      const priv = await c.client.post(`/v1/ai/business/${id}/ask`, {
        question: 'How much is flour per kilo from your supplier?',
      });
      checkEq(priv.body.documented, false, 'unapproved documented');
      check(!JSON.stringify(priv.body).match(/Mill Co|two euros/), 'unapproved entry leaked');
      const list = (await owner.client.get(`/v1/businesses/${id}/ai`)).body.entries;
      const hoursEntry = list.find((e: { title: string }) => e.title === 'Opening hours');
      await owner.client.patch(`/v1/businesses/${id}/ai/knowledge/${hoursEntry.id}`, {
        content: 'We open at noon and close at midnight.',
      });
      const after = await c.client.post(`/v1/ai/business/${id}/ask`, {
        question: 'What are your opening hours?',
      });
      checkEq(after.body.documented, false, 'edited entry must be withdrawn until re-approved');
    },
  },
  {
    id: 'hal.model_cannot_invent_beyond_knowledge',
    category: 'hallucination',
    kind: 'invariant',
    title:
      'If a model answers a grounded question with claims that are not in the knowledge, the reply falls back to a verbatim quote',
    async run(h) {
      const { id } = await h.community({
        rules: [{ title: 'Memes', body: 'Memes are allowed on Fridays only.' }],
      });
      const m = await h.user();
      await h.join(m, id);
      const r = await h.withProvider(
        'inventor',
        (req) =>
          req.responseFormat
            ? {
                content: JSON.stringify({
                  answer:
                    'Memes are always allowed, and the moderators voted last week to give every member a free lifetime sponsorship.',
                }),
              }
            : { content: 'x' },
        () => m.client.post(`/v1/ai/community/${id}/ask`, { question: 'Are memes allowed?' }),
      );
      check(
        !/lifetime sponsorship|voted last week/i.test(r.body.answer),
        `ungrounded claim reached the user: ${r.body.answer}`,
      );
      check(/Fridays/.test(r.body.answer), 'fallback should quote the documented rule');
    },
  },
  {
    id: 'hal.no_fabricated_events',
    category: 'hallucination',
    kind: 'dev',
    title: 'With no matching events the assistant says so and lists nothing',
    async run(h) {
      const u = await h.user();
      const r = await h.chat(u, 'find events about zzqxunicorn convention');
      checkEq(r.status, 200, 'status');
      check(
        /no upcoming events|couldn't find/i.test(r.body.message.content),
        `expected an honest empty answer: ${r.body.message.content}`,
      );
      checkEq(r.body.sources, [], 'sources');
    },
  },
  {
    id: 'hal.no_fabricated_search',
    category: 'hallucination',
    kind: 'dev',
    title: 'A search with no results says nothing was found',
    async run(h) {
      const u = await h.user();
      const r = await h.chat(u, `search posts about zzqx${h.uniq('none')}`);
      check(/couldn't find anything/i.test(r.body.message.content), r.body.message.content);
      checkEq(r.body.sources, [], 'sources');
    },
  },
  {
    id: 'hal.sources_are_real',
    category: 'hallucination',
    kind: 'invariant',
    title: 'Every source listed on an answer exists and is visible to the user',
    async run(h) {
      const author = await h.user();
      const u = await h.user();
      const marker = h.uniq('sourcecheck');
      await h.post(author, `A post about ${marker} and baking`);
      const r = await h.tool(u, 'social', 'search_content', { query: marker, types: ['posts'] });
      check(r.ok, 'search failed');
      const parsed = JSON.parse(r.content).result.items as Array<{ id: string }>;
      for (const it of parsed)
        checkEq(
          (await u.client.get(`/v1/posts/${it.id}`)).status,
          200,
          'listed source visible via the API',
        );
    },
  },
  {
    id: 'hal.empty_thread',
    category: 'hallucination',
    kind: 'invariant',
    title: 'Summarising a post with no comments does not invent a discussion',
    async run(h) {
      const author = await h.user();
      const postId = await h.post(author, 'Short post about tea');
      await h.consent(author, 'ai_processing');
      const r = await h.tool(author, 'social', 'summarize_thread', { postId });
      check(r.ok, 'failed');
      check(JSON.parse(r.content).result.commentCount === 0, 'should report zero comments');
    },
  },
];
