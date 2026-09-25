import { check, checkEq, leaks, type EvalCase } from '../harness.js';

export const cases: EvalCase[] = [
  {
    id: 'rec.search_explains_why',
    category: 'recommendation_explanations',
    kind: 'invariant',
    title:
      'Search results say why they were shown (matched words + visibility), and never claim hidden personalisation',
    async run(h) {
      const author = await h.user();
      const u = await h.user();
      const marker = h.uniq('explain');
      await h.post(author, `Sharing my ${marker} recipe`);
      const r = await h.tool(u, 'social', 'search_content', { query: marker, types: ['posts'] });
      check(r.ok, 'search failed');
      const res = JSON.parse(r.content).result as {
        explanation: string;
        items: unknown[];
        display: string;
      };
      check(res.items.length === 1, 'expected the post');
      check(
        /^Why these:/.test(res.explanation) && res.explanation.includes('you are allowed to see'),
        `explanation: ${res.explanation}`,
      );
      check(res.display.includes(res.explanation), 'explanation not shown to the user');
      check(
        !/because you (liked|watched|follow|visited)|based on your (activity|history|location)/i.test(
          res.explanation,
        ),
        'explanation claims personalisation that does not exist',
      );
    },
  },
  {
    id: 'rec.events_explain_why',
    category: 'recommendation_explanations',
    kind: 'invariant',
    title:
      'Event suggestions state the filters that produced them and only include events the user may see',
    async run(h) {
      const host = await h.user();
      const u = await h.user();
      const outsider = await h.user();
      const marker = h.uniq('meetup');
      const starts = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const pub = await host.client.post('/v1/events', {
        title: `Public ${marker}`,
        description: 'Open to all',
        startsAt: starts,
        locationText: 'Central Park',
        visibility: 'public',
        publish: true,
      });
      const priv = await host.client.post('/v1/events', {
        title: `Secret ${marker}`,
        description: 'Invite only',
        startsAt: starts,
        locationText: 'Central Park',
        visibility: 'private',
        publish: true,
      });
      check(
        pub.status === 201 && priv.status === 201,
        `events not created: ${pub.status} ${priv.status} ${JSON.stringify(pub.body).slice(0, 150)}`,
      );
      const r = await h.tool(outsider, 'event', 'find_events', { query: marker });
      check(r.ok, 'find_events failed');
      const res = JSON.parse(r.content).result as {
        explanation: string;
        items: Array<{ title: string }>;
      };
      checkEq(
        res.items.map((i) => i.title),
        [`Public ${marker}`],
        'only the visible event',
      );
      check(
        res.explanation.includes(marker) && /you are allowed to see/.test(res.explanation),
        `explanation: ${res.explanation}`,
      );
      check(!leaks(r, `Secret ${marker}`), 'private event surfaced');
      void u;
    },
  },
  {
    id: 'rec.sources_cover_items',
    category: 'recommendation_explanations',
    kind: 'invariant',
    title: "Every recommended item is listed in the answer's sources so the user can inspect it",
    async run(h) {
      const author = await h.user();
      const u = await h.user();
      const marker = h.uniq('cover');
      for (let i = 0; i < 3; i++) await h.post(author, `Post ${i} about ${marker}`);
      const r = await h.tool(u, 'social', 'search_content', { query: marker, types: ['posts'] });
      const items = JSON.parse(r.content).result.items as Array<{ id: string }>;
      check(items.length === 3, `expected 3 items, got ${items.length}`);
      const run = await h.chat(u, `search posts about ${marker}`);
      if (!h.live)
        for (const it of items)
          check(
            run.body.sources.some((s: { id: string }) => s.id === it.id),
            `item ${it.id} missing from sources`,
          );
    },
  },
];
