import type { Pool, PoolClient } from 'pg';
import { audit } from './services.ts';

/** The addresses in ADMIN_EMAILS (comma-separated), lower-cased. */
export function adminEmails(value: string): string[] {
  return value
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
}

/**
 * Makes the accounts listed in ADMIN_EMAILS admins, for hosts without a shell to run SQL in. Only
 * once the address is confirmed, so nobody can claim it by signing up with someone else's email
 * first. Runs when the API starts and when an email is confirmed. Returns how many were promoted.
 */
export async function promoteListedAdmins(db: Pool | PoolClient, emails: string[]): Promise<number> {
  if (!emails.length) return 0;
  const { rows } = await db.query<{ id: string }>(
    `UPDATE users SET role = 'admin'
     WHERE lower(email) = ANY($1::text[]) AND email_verified_at IS NOT NULL AND deleted_at IS NULL AND role <> 'admin'
     RETURNING id`,
    [emails],
  );
  for (const r of rows) await audit(db, { action: 'admin.granted_from_settings', entityType: 'user', entityId: r.id });
  return rows.length;
}
