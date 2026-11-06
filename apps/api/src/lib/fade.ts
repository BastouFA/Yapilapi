/** Past this many fade times a score is as good as gone, and it stops getting smaller. */
const GONE_AFTER = 50;

/**
 * How much of a score is left, in SQL: exp(−time since `since` / `seconds`). Postgres raises an error
 * when a number gets too small to hold, instead of reaching zero, so without the limit a score left
 * alone for long enough would fail every query that reads it.
 */
export const fadeSql = (since: string, at: string, seconds: number) =>
  `exp(-least(${GONE_AFTER}, greatest(0, extract(epoch FROM (${at} - ${since}))) / ${seconds}.0))`;
