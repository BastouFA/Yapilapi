import { getAgent, type ChatRequest, type ChatResponse, type ModelProvider } from '@yapilapi/ai';
import {
  createTestApp,
  signup,
  uniq,
  type Res,
  type TestApp,
  type TestUser,
} from '../../apps/api/test/helpers.js';
import { befriend, teenBirth } from '../../apps/api/test/entity-helpers.js';
import {
  getAiRuntime,
  PermissionEngine,
  executeTool,
} from '../../apps/api/src/modules/ai/index.js';
import { newTurn } from '../../apps/api/src/modules/ai/types.js';

export type Category =
  | 'permissions'
  | 'privacy'
  | 'hallucination'
  | 'injection'
  | 'safety'
  | 'translation'
  | 'summarisation'
  | 'structured_outputs'
  | 'recommendation_explanations'
  | 'agents';

export interface EvalCase {
  id: string;
  category: Category;
  title: string;
  /**
   * `invariant`: asserts a property that must hold for ANY model (permissions, no leakage, no mutation, refusal, honesty). These run in live mode too.
   * `dev`: asserts the deterministic behaviour of the offline dev responder (exact tool choice, phrasebook output). Skipped in live mode.
   */
  kind: 'invariant' | 'dev';
  run(h: Harness): Promise<void>;
}

export class EvalFailure extends Error {}
export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new EvalFailure(message);
}
export function checkEq<T>(actual: T, expected: T, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new EvalFailure(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}
export const leaks = (value: unknown, needle: string): boolean =>
  JSON.stringify(value).includes(needle);

export interface ToolRun {
  ok: boolean;
  outcome: { tool: string; outcome: 'allowed' | 'denied' | 'error'; reason?: string | undefined };
  content: string;
}

/** The scaffolding every case uses: real app, real Postgres, real gateway; only the external model can be swapped. */
export class Harness {
  readonly perms: PermissionEngine;
  constructor(
    readonly t: TestApp,
    readonly live: boolean,
  ) {
    this.perms = new PermissionEngine(t.ctx);
  }
  get runtime() {
    return getAiRuntime(this.t.ctx);
  }
  sql = (q: string, p: unknown[] = []) => this.t.ctx.db.query(q, p);
  count = async (q: string, p: unknown[] = []) => Number((await this.sql(q, p)).rows[0].n);

  user = (): Promise<TestUser> => signup(this.t);
  teen = (): Promise<TestUser> => signup(this.t, { birthDate: teenBirth() });
  friends = async (): Promise<[TestUser, TestUser]> => {
    const a = await this.user();
    const b = await this.user();
    await befriend(a, b);
    return [a, b];
  };
  consent = async (u: TestUser, purpose: 'ai_processing' | 'ai_memory', granted = true) => {
    check(
      (await u.client.put(`/v1/privacy/consents/${purpose}`, { granted })).status === 200,
      `consent ${purpose} failed`,
    );
  };
  chat = (u: TestUser, message: string, extra: Record<string, unknown> = {}): Promise<Res> =>
    u.client.post('/v1/ai/chat', { message, ...extra });
  post = async (u: TestUser, body: string, visibility = 'public'): Promise<string> => {
    const r = await u.client.post('/v1/posts', { body, visibility });
    check(r.status === 201, `post failed ${r.status}`);
    return r.body.id;
  };
  comment = async (u: TestUser, postId: string, body: string): Promise<string> => {
    const r = await u.client.post(`/v1/posts/${postId}/comments`, { body });
    check(r.status === 201, `comment failed ${r.status}`);
    return r.body.id;
  };
  dm = async (a: TestUser, b: TestUser): Promise<string> => {
    const r = await a.client.post('/v1/conversations/direct', { userId: b.id });
    check(r.status === 200 || r.status === 201, `dm failed ${r.status}`);
    return r.body.id;
  };
  say = async (u: TestUser, conv: string, body: string) => {
    const r = await u.client.post(`/v1/conversations/${conv}/messages`, { body });
    check(r.status === 201, `send failed ${r.status}`);
    return r.body;
  };
  uniq = uniq;

  async community(
    o: {
      rules?: Array<{ title: string; body: string }>;
      resources?: Array<{ title: string; body: string }>;
      decisions?: Array<{ kind: 'faq' | 'decision' | 'rule'; question?: string; body: string }>;
    } = {},
  ) {
    const owner = await this.user();
    const c = await owner.client.post('/v1/communities', {
      name: `Eval community ${uniq('c')}`,
      visibility: 'public',
      joinPolicy: 'open',
      rules: o.rules ?? [],
    });
    check(c.status === 201, `community create failed ${c.status}`);
    for (const r of o.resources ?? [])
      check(
        (await owner.client.post(`/v1/communities/${c.body.id}/resources`, r)).status === 201,
        'resource failed',
      );
    for (const d of o.decisions ?? [])
      check(
        (await owner.client.post(`/v1/communities/${c.body.id}/decisions`, d)).status === 201,
        'decision failed',
      );
    return { owner, id: c.body.id as string };
  }
  join = async (u: TestUser, communityId: string) => {
    check((await u.client.post(`/v1/communities/${communityId}/join`)).status < 300, 'join failed');
  };

  async business(
    o: {
      entries?: Array<{ title: string; content: string; approve?: boolean }>;
      enable?: boolean;
    } = {},
  ) {
    const owner = await this.user();
    const b = await owner.client.post('/v1/businesses', {
      name: `Eval bakery ${uniq('b')}`,
      category: 'food',
    });
    check(b.status === 201, `business create failed ${b.status}`);
    const id = b.body.id as string;
    for (const e of o.entries ?? []) {
      const r = await owner.client.post(`/v1/businesses/${id}/ai/knowledge`, {
        title: e.title,
        content: e.content,
      });
      check(r.status === 201, `knowledge create failed ${r.status} ${JSON.stringify(r.body)}`);
      if (e.approve !== false)
        check(
          (await owner.client.post(`/v1/businesses/${id}/ai/knowledge/${r.body.id}/approve`))
            .status === 200,
          'approve failed',
        );
    }
    if (o.enable !== false)
      check(
        (await owner.client.put(`/v1/businesses/${id}/ai`, { enabled: true })).status === 200,
        'enable failed',
      );
    return { owner, id };
  }

  /** Run one tool through the real executor exactly as the gateway would (validation, permission engine, consent, audit). */
  tool(
    u: TestUser,
    agentId: string,
    name: string,
    args: Record<string, unknown>,
    o: { attached?: string[]; scopeId?: string | null; teen?: boolean } = {},
  ): Promise<ToolRun> {
    const agent = getAgent(agentId)!;
    return executeTool(
      {
        ctx: this.t.ctx,
        runtime: this.runtime,
        principal: { userId: u.id, ageBand: o.teen ? 'teen' : 'adult' },
        permissions: this.perms,
        agent,
        scope: agent.scope,
        scopeId: o.scopeId ?? null,
        conversationId: null,
        attached: new Set(o.attached ?? []),
        turn: newTurn(),
        req: undefined,
      },
      { id: uniq('call'), name, arguments: args },
    ) as Promise<ToolRun>;
  }

  /** Swap the external model for a controllable one for the duration of `fn` (the only thing ever faked). */
  async withProvider<T>(
    name: string,
    behaviour: (req: ChatRequest, n: number) => Partial<ChatResponse> | Error,
    fn: () => Promise<T>,
  ): Promise<T> {
    let calls = 0;
    const p: ModelProvider = {
      name,
      isDev: false,
      model: `${name}-eval`,
      supports: () => true,
      async chat(req: ChatRequest): Promise<ChatResponse> {
        calls++;
        const r = behaviour(req, calls);
        if (r instanceof Error) throw r;
        return {
          content: '',
          toolCalls: [],
          provider: name,
          model: `${name}-eval`,
          usage: { inputTokens: 10, outputTokens: 10 },
          finishReason: 'stop',
          ...r,
        } as ChatResponse;
      },
    };
    this.runtime.registry.register(p);
    const prev = this.runtime.router.chain('chat');
    this.runtime.router.setRoute('chat', [name]);
    this.runtime.router.setRoute('summarise', [name]);
    try {
      return await fn();
    } finally {
      this.runtime.router.setRoute('chat', undefined);
      this.runtime.router.setRoute('summarise', undefined);
      this.runtime.registry.unregister(name);
      void prev;
    }
  }
}

export async function newHarness(env: Record<string, string>, live: boolean): Promise<Harness> {
  return new Harness(await createTestApp(env), live);
}
export type { TestUser };
