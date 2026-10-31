-- Photos, videos and sounds uploaded before the website moved to Vercel were stored with the old
-- Render web service's address (https://yapilapi-web.onrender.com/media/<key>; the address is built
-- from PUBLIC_API_URL when a file is stored and kept as written). That service only stayed up so those
-- links keep working. This moves every stored address to https://yapilapi.com/media/<key>, which the
-- web app proxies to the API the same way. Keys and every other host stay as they are.
--
-- Addresses are copied into many places (media.url, variants, poster_url and hls_url, profile photos
-- and covers, story and drop covers, caption tracks, shared-reel videos, speech clips, message
-- attachments, Today segments, notification data, queued jobs, and so on), so rather than a list that
-- would miss the next one, every text, varchar, json, jsonb and text[] column of every table is checked.
-- A table is scanned once; only the columns, and rows, that hold the old address are updated. Run
-- again, it finds nothing and changes nothing; on a database without such rows it is a no-op.
--
-- Not rewritten: records of what happened, kept as written (audit_logs, security_events,
-- analytics_events, and payment providers' payloads in payment_webhook_events).

DO $$
DECLARE
  old_prefix constant text := 'https://yapilapi-web.onrender.com/media/';
  new_prefix constant text := 'https://yapilapi.com/media/';
  t record;
  col record;
  has_old boolean;
BEGIN
  FOR t IN
    SELECT c.oid, c.oid::regclass AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT IN ('schema_migrations', 'audit_logs', 'security_events', 'analytics_events', 'payment_webhook_events')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s r WHERE strpos(r::text, $1) > 0)', t.name) INTO has_old USING old_prefix;
    CONTINUE WHEN NOT has_old;
    FOR col IN
      SELECT a.attname AS name, a.atttypid AS type, format_type(a.atttypid, a.atttypmod) AS type_name
      FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
        AND a.atttypid IN ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype, 'varchar[]'::regtype)
    LOOP
      IF col.type IN ('text[]'::regtype, 'varchar[]'::regtype) THEN
        EXECUTE format(
          'UPDATE %s SET %I = ARRAY(SELECT replace(x, $1, $2) FROM unnest(%I) WITH ORDINALITY AS u(x, i) ORDER BY i)::%s WHERE strpos(%I::text, $1) > 0',
          t.name, col.name, col.name, col.type_name, col.name
        ) USING old_prefix, new_prefix;
      ELSE
        -- json and jsonb are rewritten as text: the prefix holds no character JSON escapes, and the
        -- replacement adds none, so the result is the same document with the new address.
        EXECUTE format(
          'UPDATE %s SET %I = replace(%I::text, $1, $2)::%s WHERE strpos(%I::text, $1) > 0',
          t.name, col.name, col.name, col.type_name, col.name
        ) USING old_prefix, new_prefix;
      END IF;
    END LOOP;
  END LOOP;
END $$;
