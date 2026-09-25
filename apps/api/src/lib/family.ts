import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;

export interface TeenControls {
  messagesFrom: 'friends' | 'nobody';
  dailyLimitMinutes: number | null;
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string;
}

/** Controls for a supervised teen (an active family link), or null when nobody supervises this account. */
export async function activeControls(db: Q, userId: string): Promise<(TeenControls & { guardianIds: string[]; quietNow: boolean }) | null> {
  const { rows } = await db.query(
    `SELECT tc.messages_from, tc.daily_limit_minutes, to_char(tc.quiet_start, 'HH24:MI') AS quiet_start, to_char(tc.quiet_end, 'HH24:MI') AS quiet_end, tc.timezone,
            (SELECT array_agg(guardian_id) FROM family_links WHERE teen_id = $1 AND status = 'active') AS guardian_ids,
            CASE
              WHEN tc.quiet_start IS NULL OR tc.quiet_end IS NULL THEN false
              WHEN tc.quiet_start <= tc.quiet_end THEN (now() AT TIME ZONE tc.timezone)::time >= tc.quiet_start AND (now() AT TIME ZONE tc.timezone)::time < tc.quiet_end
              ELSE (now() AT TIME ZONE tc.timezone)::time >= tc.quiet_start OR (now() AT TIME ZONE tc.timezone)::time < tc.quiet_end
            END AS quiet_now
     FROM teen_controls tc WHERE tc.teen_id = $1 AND EXISTS (SELECT 1 FROM family_links WHERE teen_id = $1 AND status = 'active')`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    messagesFrom: r.messages_from,
    dailyLimitMinutes: r.daily_limit_minutes,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    timezone: r.timezone,
    guardianIds: r.guardian_ids ?? [],
    quietNow: r.quiet_now,
  };
}
