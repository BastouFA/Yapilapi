import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPool, migrate, withTransaction } from '../src/index.js';

const db = createPool(process.env.TEST_DATABASE_URL!, { max: 3 });
afterAll(() => db.end());

describe('schema (real PostgreSQL)', () => {
  it('applies all migrations and records them; re-running is a no-op', async () => {
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThanOrEqual(6);
  });

  it('refuses when an applied migration file was modified', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '001_identity_social.sql'), 'SELECT 1;');
    await expect(migrate(db, dir)).rejects.toThrow(/checksum mismatch/);
  });

  it('enforces the ledger balance constraint', async () => {
    const insert = (debit: number, credit: number) =>
      withTransaction(db, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO ledger_transactions (kind, ref_type, ref_id, currency) VALUES ('adjustment','test',gen_random_uuid(),'USD') RETURNING id`,
        );
        const id = rows[0].id;
        await tx.query(
          `INSERT INTO ledger_entries (transaction_id, account, direction, amount_cents) VALUES ($1,'a','debit',$2),($1,'b','credit',$3)`,
          [id, debit, credit],
        );
      });
    await expect(insert(100, 100)).resolves.toBeUndefined();
    await expect(insert(100, 90)).rejects.toThrow();
  });

  it('makes audit_logs and consents append-only', async () => {
    await db.query(`INSERT INTO audit_logs (action) VALUES ('test.append')`);
    await expect(db.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('seeds the required feature flags', async () => {
    const { rows } = await db.query('SELECT key FROM feature_flags ORDER BY key');
    expect(rows.map((r) => r.key)).toEqual([
      'AI_TRANSLATION',
      'COMMERCE',
      'LIVE',
      'MEMORY',
      'MINI_APPS',
      'NOW',
      'PLAY',
      'REAL',
      'REAL_TOGETHER',
    ]);
  });
});
