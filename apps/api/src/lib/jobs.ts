import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;
/** `run.lastAttempt`: this is the job's last try, so a handler can record that its work failed for good. */
export type JobHandler = (payload: any, run: { lastAttempt: boolean }) => Promise<void>;

export const MAX_ATTEMPTS = 5;

/** Which jobs a run may take: these ids, and/or only those queued after the job `after`. */
export interface JobScope {
  ids?: string[];
  after?: string;
}

/** A job stopped mid-run this many times is given up on: it may be what keeps bringing the server down (out of memory). */
const MAX_STOPPED_RUNS = 3;

/**
 * Jobs whose server stopped while they ran (a deploy or a restart) stay "running" for ever: after
 * `minutes` they're queued again, or failed once they've been stopped mid-run a few times (a job
 * that crashes the server shouldn't crash it again and again). Returns how many it picked up.
 */
export async function reclaimStuckJobs(db: Q, minutes = 30): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END, run_at = now(),
            last_error = 'Stopped while running (the server restarted).', finished_at = CASE WHEN attempts >= $2 THEN now() END
     WHERE status = 'running' AND run_at < now() - make_interval(mins => $1)`,
    [minutes, Math.min(MAX_STOPPED_RUNS, MAX_ATTEMPTS)],
  );
  return rowCount ?? 0;
}

/** Queue a job and return its id. */
export async function enqueue(db: Q, kind: string, payload: object, delaySeconds = 0): Promise<string> {
  const { rows } = await db.query(`INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING id`, [
    kind,
    payload,
    delaySeconds,
  ]);
  return String(rows[0].id);
}

/** Queue a job to run at a given moment (compared with the database's clock, like every due job). */
export async function enqueueAt(db: Q, kind: string, payload: object, runAt: Date): Promise<string> {
  const { rows } = await db.query(`INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, $3) RETURNING id`, [kind, payload, runAt]);
  return String(rows[0].id);
}

/**
 * Run due jobs. Each job is claimed with SKIP LOCKED so several workers can run
 * side by side; failures retry with backoff and give up after 5 attempts.
 * `scope` limits the run to given jobs, or to jobs queued after a given one, so a
 * caller (a test) runs its own jobs even when older ones of the same kind are waiting.
 */
export async function processJobs(db: Pool, handlers: Record<string, JobHandler>, batch = 5, scope: JobScope = {}): Promise<number> {
  const { rows } = await db.query(
    // While a job runs, run_at is when it started (so a run that died with its server can be found).
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, run_at = now()
     WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() AND kind = ANY($1) AND ($3::bigint[] IS NULL OR id = ANY($3)) AND id > $4::bigint
                  ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, kind, payload, attempts`,
    [Object.keys(handlers), batch, scope.ids ?? null, scope.after ?? '0'],
  );
  for (const job of rows) {
    try {
      await handlers[job.kind]!(job.payload, { lastAttempt: job.attempts >= MAX_ATTEMPTS });
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
