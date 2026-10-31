import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp } from './helpers.ts';

/**
 * Migration 0097: addresses stored with the old Render web service (yapilapi-web.onrender.com) move
 * to yapilapi.com, in plain columns, JSON and text arrays; keys and other hosts stay as they are.
 */
const OLD = 'https://yapilapi-web.onrender.com/media/';
const NEW = 'https://yapilapi.com/media/';
const migrationSql = () => readFile(fileURLToPath(new URL('../../../packages/database/migrations/0097_media_host_move.sql', import.meta.url)), 'utf8');

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});
const db = () => t.ctx.db;

describe('moving stored media addresses off the old web host', () => {
  it('rewrites the old host everywhere it is stored and leaves the rest alone', async () => {
    const owner = await signUp(t.app);
    const friend = await signUp(t.app);
    const key = `2026/09/${crypto.randomUUID()}`;

    // A processed video: original, poster, HLS and sizes on the old host.
    const video = (
      await db().query(
        `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, poster_url, hls_url, variants)
         VALUES ($1, 'video', $2, 'video/mp4', 'ready', $3, $4, $5, $6) RETURNING id`,
        [
          owner.id,
          `${OLD}${key}.mp4`,
          `${key}.mp4`,
          `${OLD}${key}_poster.jpg`,
          `${OLD}${key}_hls/index.m3u8`,
          JSON.stringify({ mp4: `${OLD}${key}_web.mp4`, mp4_360: `${OLD}${key}_360.mp4`, width: 720 }),
        ],
      )
    ).rows[0].id as string;
    // Media elsewhere: another host, and one whose path only mentions the old host further along.
    const elsewhere = (
      await db().query(
        `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, variants)
         VALUES ($1, 'image', $2, 'image/jpeg', 'ready', $3, $4) RETURNING id`,
        [owner.id, `https://cdn.example.com/media/${key}.jpg`, `${key}.jpg`, JSON.stringify({ medium: `http://localhost:4000/media/${key}_m.webp` })],
      )
    ).rows[0].id as string;

    await db().query(`UPDATE profiles SET avatar_url = $2, cover_url = $3 WHERE user_id = $1`, [
      owner.id,
      `${OLD}${key}_avatar.webp`,
      `https://cdn.example.com/media/${key}_cover.webp`,
    ]);

    const conv = (await db().query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [owner.id])).rows[0].id as string;
    await db().query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, [conv, owner.id, friend.id]);
    const message = (
      await db().query(`INSERT INTO messages (conversation_id, sender_id, body, attachments) VALUES ($1, $2, 'look', $3) RETURNING id`, [
        conv,
        owner.id,
        JSON.stringify([
          { mediaId: video, kind: 'video', url: `${OLD}${key}.mp4`, posterUrl: `${OLD}${key}_poster.jpg` },
          { kind: 'link', url: 'https://example.org/page' },
        ]),
      ])
    ).rows[0].id as string;

    // A text array: order kept, other entries untouched.
    const devApp = (
      await db().query(`INSERT INTO developer_apps (name, owner_id, redirect_uris) VALUES ('[Dev data] host move', $1, $2) RETURNING id`, [
        owner.id,
        ['https://app.example/cb', `${OLD}${key}.png`, 'https://yapilapi-web.onrender.com/login'],
      ])
    ).rows[0].id as string;

    // Records of what happened are kept as written.
    const audit = (
      await db().query(`INSERT INTO audit_logs (action, metadata) VALUES ('media.host_move_test', $1) RETURNING id`, [
        JSON.stringify({ url: `${OLD}${key}.mp4` }),
      ])
    ).rows[0].id as string;

    const sql = await migrationSql();
    await db().query(sql);

    const m = (await db().query(`SELECT url, storage_key, poster_url, hls_url, variants FROM media WHERE id = $1`, [video])).rows[0];
    expect(m).toEqual({
      url: `${NEW}${key}.mp4`,
      storage_key: `${key}.mp4`,
      poster_url: `${NEW}${key}_poster.jpg`,
      hls_url: `${NEW}${key}_hls/index.m3u8`,
      variants: { mp4: `${NEW}${key}_web.mp4`, mp4_360: `${NEW}${key}_360.mp4`, width: 720 },
    });
    const other = (await db().query(`SELECT url, variants FROM media WHERE id = $1`, [elsewhere])).rows[0];
    expect(other).toEqual({ url: `https://cdn.example.com/media/${key}.jpg`, variants: { medium: `http://localhost:4000/media/${key}_m.webp` } });

    const p = (await db().query(`SELECT avatar_url, cover_url FROM profiles WHERE user_id = $1`, [owner.id])).rows[0];
    expect(p).toEqual({ avatar_url: `${NEW}${key}_avatar.webp`, cover_url: `https://cdn.example.com/media/${key}_cover.webp` });
    expect((await as(t.app, null).get(`/v1/users/${owner.username}`)).body.profile.avatarUrl).toBe(`${NEW}${key}_avatar.webp`);

    const msg = (await db().query(`SELECT body, attachments FROM messages WHERE id = $1`, [message])).rows[0];
    expect(msg).toEqual({
      body: 'look',
      attachments: [
        { mediaId: video, kind: 'video', url: `${NEW}${key}.mp4`, posterUrl: `${NEW}${key}_poster.jpg` },
        { kind: 'link', url: 'https://example.org/page' },
      ],
    });

    expect((await db().query(`SELECT redirect_uris FROM developer_apps WHERE id = $1`, [devApp])).rows[0].redirect_uris).toEqual([
      'https://app.example/cb',
      `${NEW}${key}.png`,
      'https://yapilapi-web.onrender.com/login',
    ]);
    expect((await db().query(`SELECT metadata FROM audit_logs WHERE id = $1`, [audit])).rows[0].metadata).toEqual({ url: `${OLD}${key}.mp4` });

    // Run again: nothing left to move, nothing changes.
    const before = (await db().query(`SELECT xmin::text AS v FROM media WHERE id = $1`, [video])).rows[0].v;
    await db().query(sql);
    expect((await db().query(`SELECT xmin::text AS v FROM media WHERE id = $1`, [video])).rows[0].v).toBe(before);
    expect((await db().query(`SELECT url FROM media WHERE id = $1`, [video])).rows[0].url).toBe(`${NEW}${key}.mp4`);
  });
});
