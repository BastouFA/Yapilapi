import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminEmails, promoteListedAdmins } from '../src/lib/admin-bootstrap.ts';
import type { BuiltApp } from '../src/app.ts';
import { signUp, testApp } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const roleOf = async (id: string) => (await t.ctx.db.query(`SELECT role FROM users WHERE id = $1`, [id])).rows[0].role as string;

describe('ADMIN_EMAILS', () => {
  it('reads a comma-separated list, ignoring case, spaces and empty entries', () => {
    expect(adminEmails(' Ada@Example.com, ,bo@example.com,nope ')).toEqual(['ada@example.com', 'bo@example.com']);
    expect(adminEmails('')).toEqual([]);
  });

  it('makes a listed account admin only once its email is confirmed', async () => {
    const u = await signUp(t.app);
    await t.ctx.db.query(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [u.id]);
    expect(await promoteListedAdmins(t.ctx.db, [u.email.toUpperCase().toLowerCase()])).toBe(0);
    expect(await roleOf(u.id)).toBe('user');

    await t.ctx.db.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.id]);
    expect(await promoteListedAdmins(t.ctx.db, [u.email.toLowerCase()])).toBe(1);
    expect(await roleOf(u.id)).toBe('admin');
    // Already admin: nothing more to do.
    expect(await promoteListedAdmins(t.ctx.db, [u.email.toLowerCase()])).toBe(0);
    const logged = await t.ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.granted_from_settings' AND entity_id = $1`, [u.id]);
    expect(logged.rowCount).toBe(1);
  });

  it('leaves accounts that are not listed alone', async () => {
    const u = await signUp(t.app);
    expect(await promoteListedAdmins(t.ctx.db, ['someone-else@example.com'])).toBe(0);
    expect(await roleOf(u.id)).toBe('user');
  });
});
