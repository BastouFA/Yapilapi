/**
 * Development seed data. Every seeded user has is_dev_data = true, an email at
 * dev.yapilapi.local and a bio that starts with "[Dev data]", so it can never be
 * mistaken for production content. Safe to run repeatedly.
 */
import { hashPassword } from '@yapilapi/auth';
import { FEATURE_FLAGS } from '@yapilapi/shared';
import { createPool, tx } from './index.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (process.env.APP_ENV === 'production') {
  console.error('Refusing to seed development data into production.');
  process.exit(1);
}

export const DEV_PASSWORD = 'dev-password-123';

const TOPICS = [
  'technology',
  'music',
  'food',
  'travel',
  'photography',
  'fitness',
  'gaming',
  'art',
  'design',
  'books',
  'film',
  'fashion',
  'science',
  'networking',
  'business',
  'football',
  'basketball',
  'cooking',
  'nature',
  'education',
];

const USERS = [
  { username: 'dev_amara', name: 'Amara Obi', mode: 'creator', interests: ['photography', 'travel', 'food'], bio: 'Street photographer. Lagos → Lisbon.' },
  {
    username: 'dev_tunde',
    name: 'Tunde Bello',
    mode: 'personal',
    interests: ['technology', 'networking', 'football'],
    bio: 'Network engineer who explains packets to his cat.',
  },
  { username: 'dev_lea', name: 'Léa Martin', mode: 'professional', interests: ['design', 'art', 'books'], bio: 'Product designer. Type nerd.' },
  {
    username: 'dev_kofi',
    name: 'Kofi Mensah',
    mode: 'business',
    interests: ['food', 'cooking', 'business'],
    bio: 'Runs Jollof Corner, a small kitchen with big pots.',
  },
  { username: 'dev_sara', name: 'Sara Haddad', mode: 'creator', interests: ['fitness', 'music', 'nature'], bio: 'Trail runner, weekend DJ.' },
  { username: 'dev_admin', name: 'Dev Admin', mode: 'personal', interests: ['technology'], bio: 'Local administrator account.', role: 'admin' },
] as const;

const POSTS: [string, string, string[]][] = [
  ['dev_amara', 'Golden hour on the Tagus. Shot on a 35mm prime, no edits.', ['photography', 'travel']],
  ['dev_tunde', 'Hot take: most "slow Wi-Fi" is DNS. Change your resolver before you buy a new router.', ['technology', 'networking']],
  ['dev_lea', 'Spent the morning kerning a logo by hand. Worth it.', ['design']],
  ['dev_kofi', 'Friday special: smoky party jollof with grilled plantain. Doors open at 6.', ['food', 'cooking']],
  ['dev_sara', '21 km on the ridge trail this morning. The fog finally lifted at the summit.', ['fitness', 'nature']],
  ['dev_amara', 'Looking for photographers to join a Sunday photo walk. All levels welcome.', ['photography']],
  ['dev_tunde', 'Anyone going to the local network meetup next week? I can give a talk on BGP basics.', ['networking']],
  ['dev_lea', 'Reading list for October: three books on typography and one novel for balance.', ['books', 'design']],
];

async function main() {
  const pool = createPool(url!);
  const pw = await hashPassword(DEV_PASSWORD);
  await tx(pool, async (c) => {
    for (const [key, f] of Object.entries(FEATURE_FLAGS))
      await c.query(`INSERT INTO feature_flags (key, enabled, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`, [key, f.default, f.description]);

    for (const slug of TOPICS)
      await c.query(`INSERT INTO topics (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING`, [slug, slug[0]!.toUpperCase() + slug.slice(1)]);

    const ids: Record<string, string> = {};
    for (const u of USERS) {
      const existing = await c.query<{ user_id: string }>(`SELECT user_id FROM profiles WHERE lower(username) = $1`, [u.username]);
      if (existing.rows[0]) {
        ids[u.username] = existing.rows[0].user_id;
        continue;
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, email_verified_at, password_hash, role, onboarded_at, is_dev_data)
         VALUES ($1, now(), $2, $3, now(), true) RETURNING id`,
        [`${u.username}@dev.yapilapi.local`, pw, 'role' in u ? u.role : 'user'],
      );
      const id = rows[0]!.id;
      ids[u.username] = id;
      await c.query(`INSERT INTO profiles (user_id, username, display_name, bio, mode) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        u.username,
        u.name,
        `[Dev data] ${u.bio}`,
        u.mode,
      ]);
      await c.query(`INSERT INTO user_interests (user_id, topic_id) SELECT $1, id FROM topics WHERE slug = ANY($2) ON CONFLICT DO NOTHING`, [id, u.interests]);
    }

    const follow = (a: string, b: string) => c.query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ids[a], ids[b]]);
    await follow('dev_tunde', 'dev_amara');
    await follow('dev_lea', 'dev_amara');
    await follow('dev_amara', 'dev_lea');
    await follow('dev_sara', 'dev_kofi');
    await follow('dev_kofi', 'dev_sara');
    const [a, b] = [ids.dev_amara!, ids.dev_lea!].sort();
    await c.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a, b]);

    const { rowCount } = await c.query(`SELECT 1 FROM posts p JOIN users u ON u.id = p.author_id WHERE u.is_dev_data LIMIT 1`);
    if (!rowCount) {
      let minutesAgo = POSTS.length * 37;
      for (const [author, body, topics] of POSTS) {
        await c.query(
          `INSERT INTO posts (author_id, kind, body, visibility, topics, created_at)
           VALUES ($1, 'text', $2, 'public', $3, now() - make_interval(mins => $4))`,
          [ids[author], body, topics, minutesAgo],
        );
        minutesAgo -= 37;
      }

      const community = await c.query<{ id: string }>(
        `INSERT INTO communities (slug, name, description, owner_id, member_count, topics, rules)
         VALUES ('lisbon-photo-walks', 'Lisbon Photo Walks', '[Dev data] Weekly walks for photographers of every level.', $1, 3, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id`,
        [ids.dev_amara, ['photography', 'travel'], ['Be kind.', 'Credit other photographers.', 'No gear flexing.']],
      );
      const communityId = community.rows[0]?.id;
      if (communityId) {
        await c.query(`INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'moderator')`, [
          communityId,
          ids.dev_amara,
          ids.dev_lea,
          ids.dev_tunde,
        ]);
        await c.query(`INSERT INTO posts (author_id, kind, body, visibility, community_id, topics) VALUES ($1, 'text', $2, 'public', $3, $4)`, [
          ids.dev_lea,
          'First walk recap: 14 people, 600 photos, one lost lens cap.',
          communityId,
          ['photography'],
        ]);
      }

      const biz = await c.query<{ id: string }>(
        `INSERT INTO businesses (owner_id, slug, name, description, category)
         VALUES ($1, 'jollof-corner', 'Jollof Corner', '[Dev data] West African kitchen and catering.', 'restaurant') RETURNING id`,
        [ids.dev_kofi],
      );
      const place = await c.query<{ id: string }>(
        `INSERT INTO places (name, category, description, address, city, country, lat, lng, business_id, created_by, hours)
         VALUES ('Jollof Corner', 'restaurant', '[Dev data] Seats 30. Groups welcome.', '12 Rua Exemplo', 'Lisbon', 'PT', 38.7223, -9.1393, $1, $2,
                 '{"mon":"closed","tue-sun":"12:00-22:00"}') RETURNING id`,
        [biz.rows[0]!.id, ids.dev_kofi],
      );
      const event = await c.query<{ id: string }>(
        `INSERT INTO events (host_id, community_id, title, description, starts_at, ends_at, timezone, location_text, capacity)
         VALUES ($1, $2, 'Sunday photo walk: Alfama', '[Dev data] Meet at the viewpoint, walk down to the river.',
                 date_trunc('day', now()) + interval '3 days 9 hours', date_trunc('day', now()) + interval '3 days 12 hours',
                 'Europe/Lisbon', 'Miradouro de Santa Luzia', 20) RETURNING id`,
        [ids.dev_amara, communityId ?? null],
      );
      await c.query(
        `INSERT INTO events (host_id, place_id, title, description, starts_at, timezone, capacity)
         VALUES ($1, $2, 'Jollof tasting night', '[Dev data] Five styles of jollof, one winner.', now() + interval '6 hours', 'Europe/Lisbon', 30)`,
        [ids.dev_kofi, place.rows[0]!.id],
      );
      await c.query(`INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1, $2, 'going'), ($1, $3, 'interested')`, [
        event.rows[0]!.id,
        ids.dev_lea,
        ids.dev_tunde,
      ]);
      await c.query(
        `INSERT INTO products (seller_id, business_id, kind, title, description, price_cents, currency, inventory)
         VALUES ($1, $2, 'product', 'Party jollof tray (serves 6)', '[Dev data] Smoky jollof, plantain and salad.', 4500, 'EUR', 20),
                ($1, $2, 'booking', 'Private dinner for 6', '[Dev data] Three courses, reserved table.', 18000, 'EUR', NULL)`,
        [ids.dev_kofi, biz.rows[0]!.id],
      );
    }
  });
  await pool.end();
  console.log(`Seeded development data. Log in as dev_amara@dev.yapilapi.local / ${DEV_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
