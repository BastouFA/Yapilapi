import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { MAX_ATTEMPTS, processJobs, reclaimStuckJobs } from '../src/lib/jobs.ts';
import { testApp } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

const job = async (attempts: number, startedMinutesAgo: number) =>
  (
    await t.ctx.db.query(
      `INSERT INTO jobs (kind, payload, status, attempts, run_at) VALUES ('test.reclaim', '{}', 'running', $1, now() - make_interval(mins => $2)) RETURNING id`,
      [attempts, startedMinutesAgo],
    )
  ).rows[0].id as string;
const state = async (id: string) => (await t.ctx.db.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [id])).rows[0];

describe('jobs stopped mid-run', () => {
  it('go again after a while (a deploy restarted the server), and fail once out of attempts', async () => {
    const stuck = await job(1, 45);
    const recent = await job(1, 2);
    const spent = await job(MAX_ATTEMPTS, 45);
    expect(await reclaimStuckJobs(t.ctx.db, 20)).toBeGreaterThanOrEqual(2);
    expect(await state(stuck)).toMatchObject({ status: 'queued', last_error: expect.stringMatching(/restarted/) });
    expect((await state(recent)).status).toBe('running');
    expect((await state(spent)).status).toBe('failed');
    // Queued again, it runs like any other job.
    let ran = 0;
    await processJobs(t.ctx.db, { 'test.reclaim': async () => void ran++ }, 5, { ids: [stuck] });
    expect(ran).toBe(1);
    expect((await state(stuck)).status).toBe('done');
    await t.ctx.db.query(`DELETE FROM jobs WHERE id = ANY($1)`, [[stuck, recent, spent]]);
  });
});
