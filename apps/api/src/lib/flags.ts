import { createHash } from 'node:crypto';
import type { Db } from '@yapilapi/database';
import { AppError, type FeatureFlag } from '@yapilapi/shared';

interface Row {
  key: string;
  enabled: boolean;
  rollout_pct: number;
}

/**
 * Feature flags with global switch, percentage rollout (stable per user) and per-user overrides.
 * Flag state is cached briefly; `invalidate()` is called after admin changes.
 */
export class FeatureFlags {
  private cache: { at: number; rows: Map<string, Row> } | null = null;
  constructor(
    private readonly db: Db,
    private readonly ttlMs = 5_000,
  ) {}

  invalidate() {
    this.cache = null;
  }

  private async rows(): Promise<Map<string, Row>> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.rows;
    const { rows } = await this.db.query<Row>(
      'SELECT key, enabled, rollout_pct FROM feature_flags',
    );
    this.cache = { at: Date.now(), rows: new Map(rows.map((r) => [r.key, r])) };
    return this.cache.rows;
  }

  async isEnabled(flag: FeatureFlag, userId?: string): Promise<boolean> {
    const row = (await this.rows()).get(flag);
    if (!row) return false;
    if (userId) {
      const { rows } = await this.db.query<{ enabled: boolean }>(
        'SELECT enabled FROM feature_flag_overrides WHERE flag_key = $1 AND user_id = $2',
        [flag, userId],
      );
      if (rows[0]) return rows[0].enabled;
    }
    if (!row.enabled) return false;
    if (row.rollout_pct >= 100) return true;
    if (!userId || row.rollout_pct <= 0) return row.rollout_pct >= 100;
    const bucket = createHash('sha256').update(`${flag}:${userId}`).digest().readUInt16BE(0) % 100;
    return bucket < row.rollout_pct;
  }

  /** Throws 404 (feature_disabled) so disabled features look absent rather than forbidden. */
  async require(flag: FeatureFlag, userId?: string): Promise<void> {
    if (!(await this.isEnabled(flag, userId))) {
      throw new AppError('feature_disabled', `Feature ${flag} is not available`);
    }
  }

  async all(userId?: string): Promise<Record<string, boolean>> {
    const rows = await this.rows();
    const out: Record<string, boolean> = {};
    for (const key of rows.keys()) out[key] = await this.isEnabled(key as FeatureFlag, userId);
    return out;
  }
}
