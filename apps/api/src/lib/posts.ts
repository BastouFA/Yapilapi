import type { Pool, PoolClient } from 'pg';
import type { MediaItem, Post, RemixRef } from '@yapilapi/shared';
import { plusCol, publicUserFrom } from './users.ts';
import { seesSensitiveMedia } from './interactions.ts';
import { allowDownloadSql, postUnlockedSql, postVisibleSql } from './visibility.ts';
import { attachCollabsAndTags } from './collabs.ts';
import { mediaSizesSql, withSmallVariants } from './data-saver.ts';
import { commentAllowedSql } from './comments.ts';
import { langOf } from './translation.ts';
import { soundVisibleSql } from './sounds.ts';
import { trackMusic, viewerCountries, type StoredPart, type TrackRow } from './music/view.ts';
import { quotedQuestions } from './ask.ts';
import { mixCards } from './mixes.ts';
import type { EchoRef, PostMusic, PostReasonCode, PostReasonParams, ReelHighlight } from '@yapilapi/shared';
import { postReasonText, type ReasonTranslator } from '@yapilapi/shared';
import { t, tp } from '@yapilapi/shared/i18n';
import { echoAllowedSql, echoPermissionSql } from './echoes.ts';

type Q = Pool | PoolClient;

/** Why a post is in someone's feed: a code and the names it mentions (the apps put it into words). */
export interface FeedReason {
  code: PostReasonCode;
  params?: PostReasonParams;
}

/** English, for the `reason` and `reasons` older apps show as they are. */
export const ENGLISH_REASONS: ReasonTranslator = { t: (key, vars) => t(key, 'en', vars), tp: (key, n, vars) => tp(key, n, 'en', vars) };

/** A post's reason fields: the code and its names, and the same in English for older apps. */
function reasonOf(reasons: Map<string, FeedReason> | undefined, id: string): Pick<Post, 'reason' | 'reasonCode' | 'reasonParams'> {
  const r = reasons?.get(id);
  if (!r) return {};
  const params = r.params ?? {};
  return { reason: postReasonText({ reasonCode: r.code, reasonParams: params }, ENGLISH_REASONS) ?? undefined, reasonCode: r.code, reasonParams: params };
}

/**
 * Load full Post DTOs for ids (already authorized by the caller), preserving order.
 * Subscriber-only posts the viewer can't open come back locked: no text, media,
 * poll, link, topics or attachments, only a blurred preview (see Post.locked).
 */
export async function hydratePosts(db: Q, ids: string[], viewer: string | null, reasons?: Map<string, FeedReason>): Promise<Post[]> {
  if (!ids.length) return [];
  // Media the automated check marked sensitive is never sent to people under 18 (or whose age we don't know); blocked media to nobody.
  const adult = await seesSensitiveMedia(db, viewer);
  const { rows } = await db.query(
    `SELECT p.id, p.kind, p.format, p.body, p.lang, p.visibility, p.link_url, p.topics, p.like_count, p.comment_count, p.view_count, p.created_at, p.edited_at, p.status, p.scheduled_at, p.ai_provenance, p.metadata->'real' AS real,
            pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')},
            c.id AS c_id, c.slug AS c_slug, c.name AS c_name,
            e.id AS e_id, e.title AS e_title, e.starts_at AS e_starts_at,
            pd.id AS pd_id, pd.title AS pd_title, pd.price_cents AS pd_price, pd.currency AS pd_currency,
            EXISTS (SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.user_id = $2) AS liked,
            EXISTS (SELECT 1 FROM saves s WHERE s.post_id = p.id AND s.user_id = $2) AS saved,
            EXISTS (SELECT 1 FROM post_reposts rp WHERE rp.post_id = p.id AND rp.user_id = $2) AS reposted, p.repost_count,
            (SELECT coalesce(json_agg(json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height, 'variants', m.variants, 'sizes', ${mediaSizesSql()}, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash, 'sensitive', m.moderation = 'sensitive',
                                                   'customCover', m.kind = 'video' AND m.default_poster IS NOT NULL, 'coverMs', m.cover_ms,
                                                   'captions', (SELECT coalesce(json_agg(json_build_object('lang', ct.lang, 'label', ct.label, 'url', ct.url) ORDER BY ct.lang), '[]')
                                                                FROM caption_tracks ct WHERE ct.media_id = m.id AND ct.status = 'ready')) ORDER BY pm.position), '[]')
               FROM post_media pm JOIN media m ON m.id = pm.media_id
               WHERE pm.post_id = p.id AND m.moderation <> 'blocked' AND (m.moderation <> 'sensitive' OR $3)) AS media,
            (SELECT json_agg(json_build_object('id', o.id, 'label', o.label, 'votes', (SELECT count(*) FROM poll_votes v WHERE v.option_id = o.id)) ORDER BY o.position)
               FROM poll_options o WHERE o.post_id = p.id) AS poll_options,
            (SELECT option_id FROM poll_votes v WHERE v.post_id = p.id AND v.user_id = $2) AS my_vote,
            (SELECT array_agg(DISTINCT w.country ORDER BY w.country) FROM post_withholdings w WHERE w.post_id = p.id AND p.author_id = $2) AS withheld_in,
            p.allow_remix, p.remix_mode, p.remix_of_post_id, p.highlights, p.question_id, p.mix_id,
            CASE WHEN p.format = 'reel' THEN (SELECT rr.position_ms FROM reel_resume rr WHERE rr.user_id = $2 AND rr.post_id = p.id) END AS resume_ms,
            -- Which circle a post went to is for its author only; members never see a circle's name.
            (p.visibility = 'circle' AND p.author_id IS NOT DISTINCT FROM $2) AS own_circle_post,
            CASE WHEN p.visibility = 'circle' AND p.author_id IS NOT DISTINCT FROM $2
                 THEN (SELECT json_build_object('id', ci.id, 'name', ci.name) FROM circles ci WHERE ci.id = p.circle_id) END AS own_circle,
            CASE WHEN p.format = 'reel' THEN (SELECT count(*) FROM posts rx WHERE rx.remix_of_post_id = p.id AND rx.deleted_at IS NULL AND rx.status = 'published')::int END AS remix_count,
            -- Echoes: how many are up, whether the viewer may echo it, the author's own setting, and (on an echo) what it answers.
            CASE WHEN p.format = 'reel' AND NOT p.is_echo THEN (SELECT count(*) FROM posts ex WHERE ex.echo_of_post_id = p.id AND ex.is_echo AND ex.deleted_at IS NULL
                                                                   AND ex.status = 'published' AND ex.moderation_status = 'normal')::int END AS echo_count,
            CASE WHEN p.format = 'reel' THEN coalesce(${echoAllowedSql('$2', 'pr')}, false) END AS can_echo,
            CASE WHEN p.format = 'reel' AND p.author_id IS NOT DISTINCT FROM $2 THEN ${echoPermissionSql('p', 'pr', 'au')} END AS allow_echoes,
            p.is_echo, p.echo_of_post_id, (SELECT json_build_object('layout', ec.layout, 'theirAudio', ec.their_audio) FROM echoes ec WHERE ec.post_id = p.id) AS echo_info,
            s.id AS s_id, s.title AS s_title, s.source_post_id AS s_source, coalesce(s.duration_ms, sm.duration_ms) AS s_duration,
            coalesce(sm.variants->>'mp4', sm.url) AS s_audio, so.display_name AS s_artist, sm.poster_url AS s_cover,
            -- Music on a photo or text post: its part, and the sound (while the viewer can see it) or the catalogue song.
            p.music AS music_part, p.music_track_id,
            CASE WHEN p.music IS NOT NULL AND p.sound_id IS NOT NULL AND p.format <> 'reel' THEN ${soundVisibleSql('$2')} END AS s_visible,
            mt.provider AS mt_provider, mt.title AS mt_title, mt.artist AS mt_artist, mt.cover_url AS mt_cover, mt.preview_url AS mt_preview,
            mt.licence AS mt_licence, mt.status AS mt_status,
            CASE WHEN p.format = 'reel' THEN (p.author_id IS NOT DISTINCT FROM $2 OR ${allowDownloadSql('pr', 'au')}) END AS downloadable,
            coalesce(${postUnlockedSql('$2')}, false) AS unlocked,
            p.comment_policy, coalesce(${postUnlockedSql('$2')} AND ${commentAllowedSql('$2')}, false) AS can_comment,
            (SELECT count(*)::int FROM post_media pm WHERE pm.post_id = p.id) AS media_count,
            (SELECT m.blurhash FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id ORDER BY pm.position LIMIT 1) AS cover_placeholder,
            (SELECT json_build_object('campaignId', ac.id, 'status', ac.status, 'impressions', ac.impressions, 'clicks', ac.clicks,
                                      'spentCents', ceil(ac.spent_millicents / 1000.0)::int, 'budgetCents', floor(ac.budget_millicents / 1000.0)::int,
                                      'currency', ac.currency, 'endsAt', ac.ends_at)
               FROM ad_campaigns ac WHERE ac.post_id = p.id AND ac.advertiser_id = $2 AND p.author_id = $2
               ORDER BY ac.created_at DESC LIMIT 1) AS boost
     FROM posts p
     JOIN profiles pr ON pr.user_id = p.author_id
     JOIN users au ON au.id = p.author_id
     LEFT JOIN sounds s ON s.id = p.sound_id
     LEFT JOIN media sm ON sm.id = s.media_id
     LEFT JOIN profiles so ON so.user_id = s.owner_id
     LEFT JOIN music_tracks mt ON mt.id = p.music_track_id
     LEFT JOIN communities c ON c.id = p.community_id
     LEFT JOIN events e ON e.id = p.event_id AND e.deleted_at IS NULL
     LEFT JOIN products pd ON pd.id = p.product_id AND pd.deleted_at IS NULL
     WHERE p.id = ANY($1)`,
    [ids, viewer, adult],
  );
  const originals = await remixOriginals(
    db,
    rows
      .filter((r) => r.unlocked)
      .flatMap((r) => [r.remix_of_post_id as string | null, r.is_echo ? (r.echo_of_post_id as string | null) : null])
      .filter((x): x is string => !!x),
    viewer,
  );
  // Catalogue songs are checked for where the viewer is (and whether they're still offered).
  const countries = rows.some((r) => r.music_track_id && r.unlocked) ? await viewerCountries(db, viewer) : [];
  const byId = new Map<string, Post>(
    rows.map((r) => [r.id as string, r.unlocked ? { ...toPost(r, originals, reasons), ...musicOf(r, countries) } : lockedPost(r, reasons)]),
  );
  const posts = ids.map((id) => byId.get(id)).filter((p): p is Post => !!p);
  // Answers shared from a question box quote their question, while the viewer may see it (never with a hidden asker's name).
  const asking = rows.filter((r) => r.question_id && r.unlocked);
  if (asking.length) {
    const quoted = await quotedQuestions(
      db,
      asking.map((r) => r.question_id as string),
      viewer,
    );
    for (const r of asking) byId.get(r.id)!.question = quoted.get(r.question_id) ?? null;
  }
  // A mix shared as a post: its card while the viewer may see the mix.
  const mixing = rows.filter((r) => r.mix_id && r.unlocked);
  if (mixing.length) {
    const cards = await mixCards(
      db,
      mixing.map((r) => r.mix_id as string),
      viewer,
    );
    for (const r of mixing) byId.get(r.id)!.mix = cards.get(r.mix_id) ?? null;
  }
  // Co-authors ("Ada and Bola") and people tagged in photos (none on locked posts, which carry no media).
  await attachCollabsAndTags(db, [...new Set(posts)], viewer);
  return posts;
}

function toPost(r: Record<string, any>, originals: Map<string, NonNullable<RemixRef['post']>>, reasons?: Map<string, FeedReason>): Post {
  return {
    id: r.id,
    kind: r.kind,
    body: r.body,
    lang: r.lang ?? langOf(r.body),
    visibility: r.visibility,
    author: publicUserFrom(r, 'a_'),
    media: (r.media as (MediaItem & { sensitive: boolean })[]).map(({ sensitive, customCover, coverMs, ...m }) =>
      withSmallVariants({
        ...m,
        ...(sensitive ? { sensitive: true } : {}),
        ...(customCover ? { customCover: true, ...(coverMs != null ? { coverMs } : {}) } : {}),
      }),
    ),
    linkUrl: typeof r.link_url === 'string' && /^https?:\/\//i.test(r.link_url) ? r.link_url : null,
    poll: r.poll_options ? { options: r.poll_options, myVote: r.my_vote } : null,
    topics: r.topics,
    community: r.c_id ? { id: r.c_id, slug: r.c_slug, name: r.c_name } : null,
    event: r.e_id ? { id: r.e_id, title: r.e_title, startsAt: r.e_starts_at.toISOString() } : null,
    product: r.pd_id ? { id: r.pd_id, title: r.pd_title, priceCents: r.pd_price, currency: r.pd_currency } : null,
    counts: {
      likes: r.like_count,
      comments: r.comment_count,
      reposts: r.repost_count ?? 0,
      views: r.view_count ?? 0,
      ...(r.remix_count === null ? {} : { remixes: r.remix_count }),
      ...(r.echo_count === null || r.echo_count === undefined ? {} : { echoes: r.echo_count }),
    },
    commentPolicy: r.comment_policy,
    viewer: {
      liked: r.liked,
      saved: r.saved,
      reposted: r.reposted,
      canComment: r.can_comment,
      ...(r.resume_ms === null || r.resume_ms === undefined ? {} : { resumeMs: r.resume_ms }),
      ...(r.can_echo === null || r.can_echo === undefined ? {} : { canEcho: !!r.can_echo }),
    },
    aiAssisted: !!r.ai_provenance?.assisted,
    real: r.real ?? null,
    createdAt: r.created_at.toISOString(),
    ...draftFields(r),
    format: r.format ?? 'post',
    ...(r.format === 'reel'
      ? {
          allowRemix: r.allow_remix,
          remixOf: r.remix_mode ? { mode: r.remix_mode, post: (r.remix_of_post_id && originals.get(r.remix_of_post_id)) || null } : null,
          sound: r.s_id ? { id: r.s_id, title: r.s_title, durationMs: r.s_duration ?? null, audioUrl: r.s_audio ?? null, original: r.s_source === r.id } : null,
          ...(Array.isArray(r.highlights) && r.highlights.length ? { highlights: r.highlights as ReelHighlight[] } : {}),
          ...(r.is_echo ? { echoOf: echoRefOf(r, originals) } : {}),
          ...(r.allow_echoes ? { allowEchoes: r.allow_echoes } : {}),
        }
      : {}),
    ...reasonOf(reasons, r.id),
    ...(r.withheld_in ? { withheldIn: r.withheld_in.map((c: string) => c.trim()) } : {}),
    ...(r.downloadable === null ? {} : { downloadable: !!r.downloadable }),
    ...(r.boost ? { boost: r.boost } : {}),
    ...(r.own_circle_post ? { circle: r.own_circle ?? null } : {}),
  } satisfies Post;
}

/**
 * What an echo answers. Viewers other than its author only get the echo while they can see the
 * original (echoShownSql), so `post: null` reaches the echo's author alone: the original was
 * deleted or is no longer shared with them, and the echo is hidden from everyone else.
 */
function echoRefOf(r: Record<string, any>, originals: Map<string, NonNullable<RemixRef['post']>>): EchoRef {
  const o = r.echo_of_post_id ? originals.get(r.echo_of_post_id) : undefined;
  return {
    post: o ? { id: o.id, author: o.author } : null,
    layout: r.echo_info?.layout ?? 'side',
    theirAudio: r.echo_info?.theirAudio ?? 'mixed',
  };
}

/** A post's music for this viewer: left out when there is none, or when it is a sound the viewer can't see. */
function musicOf(r: Record<string, any>, countries: string[]): { music?: PostMusic } {
  const part = r.music_part as StoredPart | null;
  if (!part) return {};
  if (r.music_track_id && r.mt_provider) {
    const row: TrackRow = {
      id: r.music_track_id,
      provider: r.mt_provider,
      title: r.mt_title,
      artist: r.mt_artist,
      cover_url: r.mt_cover,
      preview_url: r.mt_preview,
      licence: r.mt_licence,
      status: r.mt_status,
    };
    return { music: trackMusic(row, part, { countries, commercial: r.a_mode === 'business' }) };
  }
  if (r.s_id && r.format !== 'reel' && r.s_visible)
    return {
      music: {
        source: 'library',
        id: r.s_id,
        title: r.s_title,
        artist: r.s_artist,
        coverUrl: r.s_cover ?? null,
        audioUrl: r.s_audio ?? null,
        startMs: part.startMs,
        durationMs: part.durationMs,
        style: 'compact',
        licenceName: null,
        licenceUrl: null,
        attribution: null,
      },
    };
  return {};
}

/** "Edited" on published posts; the state and time of the author's own drafts and scheduled posts (only they are ever given those). */
function draftFields(r: Record<string, any>): Pick<Post, 'editedAt' | 'status' | 'scheduledAt'> {
  return {
    ...(r.edited_at ? { editedAt: r.edited_at.toISOString() } : {}),
    ...(r.status !== 'published' ? { status: r.status, scheduledAt: r.scheduled_at?.toISOString() ?? null } : {}),
  };
}

/** What someone who isn't subscribed sees of a subscriber-only post: who posted it and when, never what it says or shows. */
function lockedPost(r: Record<string, any>, reasons?: Map<string, FeedReason>): Post {
  return {
    id: r.id,
    kind: r.kind,
    body: '',
    visibility: r.visibility,
    author: publicUserFrom(r, 'a_'),
    media: [],
    linkUrl: null,
    poll: null,
    topics: [],
    community: r.c_id ? { id: r.c_id, slug: r.c_slug, name: r.c_name } : null,
    event: null,
    product: null,
    counts: { likes: r.like_count, comments: r.comment_count, reposts: r.repost_count ?? 0, views: r.view_count ?? 0 },
    viewer: { liked: r.liked, saved: r.saved, reposted: r.reposted },
    aiAssisted: false,
    real: null,
    createdAt: r.created_at.toISOString(),
    ...draftFields(r),
    format: r.format ?? 'post',
    ...reasonOf(reasons, r.id),
    locked: { placeholder: r.cover_placeholder ?? null, mediaCount: r.media_count ?? 0 },
  };
}

/** The reels that remixes and duets credit: author, text and first video, only where the viewer can still see them. */
async function remixOriginals(db: Q, ids: string[], viewer: string | null): Promise<Map<string, NonNullable<RemixRef['post']>>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.body, ap.user_id AS a_id, ap.username AS a_username, ap.display_name AS a_display_name, ap.avatar_url AS a_avatar_url, ap.mode AS a_mode,
            ${plusCol('a_', 'ap')},
            (SELECT json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height,
                                      'variants', m.variants, 'sizes', ${mediaSizesSql()}, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash)
               FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation NOT IN ('blocked', 'sensitive') ORDER BY pm.position LIMIT 1) AS media
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.id = ANY($1) AND ${postVisibleSql('$2')}`,
    [[...new Set(ids)], viewer],
  );
  return new Map(
    rows.map((r) => [
      r.id as string,
      { id: r.id, body: r.body, author: publicUserFrom(r, 'a_'), media: r.media ? withSmallVariants(r.media as MediaItem) : null },
    ]),
  );
}
