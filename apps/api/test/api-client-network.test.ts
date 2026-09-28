import { describe, expect, it } from 'vitest';
import { ApiError, createClient } from '../../../packages/api-client/src/index.ts';

/** A fetch that answers each call with the next response in the list (or throws, like a dropped connection). */
function fakeFetch(answers: (Response | 'drop')[]) {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const next = answers.shift();
    if (!next || next === 'drop') throw new TypeError('Load failed');
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (status: number) => new Response('Internal Server Error', { status, headers: { 'content-type': 'text/plain' } });

describe('api client when the API is unreachable', () => {
  it('says YAPILAPI can’t be reached when a proxy answers with an error page instead of the API', async () => {
    const { fn } = fakeFetch([page(500)]);
    const api = createClient({ baseUrl: '/api', fetch: fn });
    const err = await api.conversations.startGame('c1', { kind: 'noughts', playerIds: [], clientId: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'unavailable', message: "YAPILAPI can't be reached right now. Try again in a moment." });
  });

  it('never repeats a change, but retries a read once', async () => {
    const change = fakeFetch(['drop', json(201, { message: {} })]);
    await expect(
      createClient({ baseUrl: '/api', fetch: change.fn }).conversations.startGame('c1', { kind: 'noughts', playerIds: [], clientId: 'x' }),
    ).rejects.toMatchObject({
      code: 'network',
    });
    expect(change.calls).toHaveLength(1);

    const read = fakeFetch([page(502), json(200, { items: [] })]);
    await expect(createClient({ baseUrl: '/api', fetch: read.fn }).conversations.games('c1')).resolves.toEqual({ items: [] });
    expect(read.calls).toEqual(['GET /api/v1/conversations/c1/games', 'GET /api/v1/conversations/c1/games']);
  });

  it('keeps the API’s own error messages', async () => {
    const { fn, calls } = fakeFetch([json(409, { error: { code: 'game_going', message: 'A game of Noughts is already going here.' } })]);
    await expect(createClient({ baseUrl: '/api', fetch: fn }).conversations.games('c1')).rejects.toMatchObject({
      status: 409,
      message: 'A game of Noughts is already going here.',
    });
    expect(calls).toHaveLength(1);
  });
});
