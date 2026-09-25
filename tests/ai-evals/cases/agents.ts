import { AGENTS, AGENT_IDS } from '@yapilapi/ai';
import { check, checkEq, type EvalCase, type Harness } from '../harness.js';

/** Each agent's own declarative eval cases, run through the real gateway. */
async function seed(
  h: Harness,
  needs: string | undefined,
): Promise<{ agent?: string; scopeId?: string; user: Awaited<ReturnType<Harness['user']>> }> {
  const user = await h.user();
  if (needs === 'community' || needs === 'community_empty') {
    const c = await h.community(
      needs === 'community'
        ? { rules: [{ title: 'Memes', body: 'Memes are allowed on Fridays only.' }] }
        : {},
    );
    await h.join(user, c.id);
    return { scopeId: c.id, user };
  }
  if (needs === 'business' || needs === 'business_disabled') {
    const b = await h.business({
      entries: [
        {
          title: 'Opening hours',
          content:
            'We are open from nine in the morning until five in the evening, Monday to Friday.',
        },
      ],
      enable: needs === 'business',
    });
    return { scopeId: b.id, user };
  }
  return { user };
}

export const cases: EvalCase[] = AGENT_IDS.flatMap((id) =>
  AGENTS[id].evals.map((ev): EvalCase => ({
    id: `agent.${ev.id}`,
    category: 'agents',
    kind: ev.expect.tools || ev.expect.contains ? 'dev' : 'invariant',
    title: `${AGENTS[id].name}: ${ev.prompt}`,
    async run(h) {
      const { scopeId, user } = await seed(h, ev.needs);
      const r = await h.chat(user, ev.prompt, { agent: id, ...(scopeId ? { scopeId } : {}) });
      checkEq(r.status, 200, `status (${JSON.stringify(r.body).slice(0, 200)})`);
      const called: string[] = r.body.toolCalls.map((t: { tool: string }) => t.tool);
      const text: string = r.body.message.content;
      const e = ev.expect;
      for (const t of e.tools ?? [])
        check(called.includes(t), `expected tool ${t}, called [${called.join(', ')}]`);
      if (e.noTools) checkEq(called, [], 'tools called');
      for (const s of e.contains ?? [])
        check(
          text.toLowerCase().includes(s.toLowerCase()),
          `answer should contain "${s}": ${text.slice(0, 200)}`,
        );
      for (const s of e.notContains ?? [])
        check(!text.toLowerCase().includes(s.toLowerCase()), `answer should not contain "${s}"`);
      if (e.refusal !== undefined) checkEq(r.body.safety.refused, e.refusal, 'refusal');
      if (e.supportResources) check(r.body.support, 'support resources expected');
      if (e.documented !== undefined) checkEq(r.body.documented, e.documented, 'documented');
    },
  })),
);
