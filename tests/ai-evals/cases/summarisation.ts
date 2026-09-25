import { groundedness } from '@yapilapi/ai';
import { check, checkEq, type EvalCase } from '../harness.js';

export const cases: EvalCase[] = [
  {
    id: 'sum.thread_faithful',
    category: 'summarisation',
    kind: 'dev',
    title: 'A thread summary contains only what the thread says and keeps the key fact',
    async run(h) {
      const author = await h.user();
      const c1 = await h.user();
      const reader = await h.user();
      const postId = await h.post(
        author,
        'The community picnic is on Saturday at noon by the north gate of Central Park. Bring your own drinks.',
      );
      await h.comment(c1, postId, 'I can bring a big blanket and some sandwiches for everyone.');
      await h.comment(
        author,
        postId,
        'Great! Parking is free after ten in the morning near the north gate.',
      );
      await h.consent(reader, 'ai_processing');
      const r = await h.tool(reader, 'social', 'summarize_thread', { postId });
      check(r.ok, 'summary failed');
      const res = JSON.parse(r.content).result as { summary: string; commentCount: number };
      checkEq(res.commentCount, 2, 'comment count');
      check(
        /picnic|saturday|north gate/i.test(res.summary),
        `summary lost the key facts: ${res.summary}`,
      );
      const source =
        'The community picnic is on Saturday at noon by the north gate of Central Park. Bring your own drinks. I can bring a big blanket and some sandwiches for everyone. Great! Parking is free after ten in the morning near the north gate.';
      check(
        groundedness(res.summary, '', [
          { id: 's', kind: 'community_rule', title: '', text: source },
        ]) >= 0.8,
        `summary contains words not in the source: ${res.summary}`,
      );
    },
  },
  {
    id: 'sum.conversation_attached_only',
    category: 'summarisation',
    kind: 'dev',
    title: 'A conversation summary reflects only the attached conversation and keeps its key fact',
    async run(h) {
      const [a, b] = await h.friends();
      const [c, d] = await h.friends();
      const conv1 = await h.dm(a, b);
      const conv2 = await h.dm(c, d);
      const m1 = h.uniq('harbour');
      const m2 = h.uniq('otherchat');
      await h.say(
        b,
        conv1,
        `We should meet at the ${m1} on Friday at eight. I will bring the tickets.`,
      );
      await h.say(d, conv2, `Unrelated: ${m2} is the code word.`);
      await h.consent(a, 'ai_processing');
      const r = await h.tool(
        a,
        'social',
        'summarize_conversation',
        { conversationId: conv1 },
        { attached: [conv1] },
      );
      check(r.ok, 'failed');
      check(r.content.includes(m1) || /friday|tickets/i.test(r.content), 'key fact missing');
      check(!r.content.includes(m2), 'other conversation leaked into the summary');
    },
  },
  {
    id: 'sum.long_input_bounded',
    category: 'summarisation',
    kind: 'invariant',
    title: 'Very long threads are bounded and still summarised without error',
    async run(h) {
      const author = await h.user();
      await h.consent(author, 'ai_processing');
      const postId = await h.post(
        author,
        'Long discussion about the neighbourhood garden project.',
      );
      for (let i = 0; i < 25; i++)
        await h.comment(
          author,
          postId,
          `Comment number ${i}: ${'we should plant more tomatoes and herbs near the fence. '.repeat(20)}`,
        );
      const r = await h.tool(author, 'social', 'summarize_thread', { postId });
      check(r.ok, `long thread failed: ${r.content.slice(0, 200)}`);
      check(r.content.length < 12_000, 'tool result not bounded');
    },
  },
  {
    id: 'sum.plan_extraction',
    category: 'summarisation',
    kind: 'dev',
    title:
      'A plan draft extracts destination, dates and budget from the chat and lists what is missing',
    async run(h) {
      const [a, b] = await h.friends();
      const conv = await h.dm(a, b);
      await h.say(a, conv, "Let's plan a weekend trip to Lisbon from 2099-05-01 to 2099-05-03");
      await h.say(b, conv, 'Great, I will book the hotel. Budget is around 600 EUR');
      await h.consent(a, 'ai_processing');
      const r = await h.tool(
        a,
        'travel',
        'plan_from_conversation',
        { conversationId: conv },
        { attached: [conv] },
      );
      check(r.ok, 'plan failed');
      const plan = JSON.parse(r.content).result.plan;
      check(/lisbon/i.test(plan.destination ?? ''), `destination: ${plan.destination}`);
      checkEq(plan.startsOn, '2099-05-01', 'start date');
      checkEq(plan.endsOn, '2099-05-03', 'end date');
      checkEq(plan.budget?.amountCents, 60000, 'budget');
      check(Array.isArray(plan.missing), 'missing list absent');
    },
  },
];
