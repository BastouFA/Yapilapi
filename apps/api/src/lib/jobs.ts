import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;
export type JobHandler = (payload: any) => Promise<void>;

const MAX_ATTEMPTS = 5;

export async function enqueue(db: Q, kind: string, payload: object, delaySeconds = 0): Promise<void> {
  await db.query(`INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, now() + make_interval(secs => $3))`, [kind, payload, delaySeconds]);
}

/**
 * Run due jobs. Each job is claimed with SKIP LOCKED so several workers can run
 * side by side; failures retry with backoff and give up after 5 attempts.
 */
export async function processJobs(db: Pool, handlers: Record<string, JobHandler>, batch = 5): Promise<number> {
  const { rows } = await db.query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1
     WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() AND kind = ANY($1) ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, kind, payload, attempts`,
    [Object.keys(handlers), batch],
  );
  for (const job of rows) {
    try {
      await handlers[job.kind]!(job.payload);
      await db.query(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`, [job.id]);
    } catch (e) {
      const failed = job.attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + make_interval(secs => $4), finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`,
        [job.id, failed ? 'failed' : 'queued', String((e as Error).message).slice(0, 500), 30 * 2 ** job.attempts],
      );
    }
  }
  return rows.length;
}
