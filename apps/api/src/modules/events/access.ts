import type { Queryable } from '@yapilapi/database';
import { forbidden, notFound } from '@yapilapi/shared';

/**
 * THE central event visibility + organiser rules (the events counterpart of lib/visibility.ts). Every query that returns
 * events to a viewer must include `eventVisibleSql`.
 *
 * `viewer` is a SQL expression (e.g. '$1::uuid') evaluating to the viewer's user id or NULL; `e` is the events alias.
 */

/** Host, co-host, community manager (manage_events) or business team member allowed to run events (owner/admin/editor). */
export function organiserSql(viewer: string, e = 'e'): string {
  const V = `(${viewer})`;
  return `(${V} IS NOT NULL AND (
    ${e}.host_id = ${V}
    OR EXISTS (SELECT 1 FROM event_organizers eo WHERE eo.event_id = ${e}.id AND eo.user_id = ${V})
    OR (${e}.community_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM community_members cm JOIN community_roles cr ON cr.community_id = cm.community_id AND cr.key = cm.role_key
       WHERE cm.community_id = ${e}.community_id AND cm.user_id = ${V} AND cm.status = 'active' AND 'manage_events' = ANY (cr.permissions)))
    OR (${e}.host_business_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM business_members bm WHERE bm.business_id = ${e}.host_business_id AND bm.user_id = ${V} AND bm.role IN ('owner','admin','editor')))
  ))`;
}

/** Managers may cancel/delete the event and manage co-hosts: the host, community managers and business owners/admins. */
export function managerSql(viewer: string, e = 'e'): string {
  const V = `(${viewer})`;
  return `(${V} IS NOT NULL AND (
    ${e}.host_id = ${V}
    OR (${e}.community_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM community_members cm JOIN community_roles cr ON cr.community_id = cm.community_id AND cr.key = cm.role_key
       WHERE cm.community_id = ${e}.community_id AND cm.user_id = ${V} AND cm.status = 'active' AND 'manage_events' = ANY (cr.permissions)))
    OR (${e}.host_business_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM business_members bm WHERE bm.business_id = ${e}.host_business_id AND bm.user_id = ${V} AND bm.role IN ('owner','admin')))
  ))`;
}

export function eventVisibleSql(viewer: string, e = 'e'): string {
  const V = `(${viewer})`;
  const follows = `EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${e}.host_id AND fw.status = 'active')`;
  const friends = `EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST(${V}, ${e}.host_id) AND fr.user_high = GREATEST(${V}, ${e}.host_id) AND fr.status = 'accepted')`;
  return `(
    ${e}.deleted_at IS NULL
    AND (${V} IS NULL OR ${e}.host_id IS NULL OR ${e}.host_id = ${V}
         OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${V} AND bl.blocked_id = ${e}.host_id) OR (bl.blocker_id = ${e}.host_id AND bl.blocked_id = ${V})))
    AND (${e}.host_id IS NULL OR EXISTS (SELECT 1 FROM users uh WHERE uh.id = ${e}.host_id AND uh.deleted_at IS NULL AND uh.status IN ('active','pending_deletion')))
    AND (
      ${organiserSql(viewer, e)}
      OR (${e}.status <> 'draft' AND (
        (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = ${e}.id AND ea.user_id = ${V} AND ea.status IN ('going','waitlist','attended')))
        OR CASE ${e}.visibility
          WHEN 'public' THEN true
          WHEN 'followers' THEN (${V} IS NOT NULL AND ${e}.host_id IS NOT NULL AND ${follows})
          WHEN 'friends' THEN (${V} IS NOT NULL AND ${e}.host_id IS NOT NULL AND ${friends})
          WHEN 'community' THEN (${V} IS NOT NULL AND EXISTS (
            SELECT 1 FROM communities cx JOIN community_members cmm ON cmm.community_id = cx.id
             WHERE cx.id = ${e}.community_id AND cx.deleted_at IS NULL AND cmm.user_id = ${V} AND cmm.status = 'active'))
          WHEN 'private' THEN false
          ELSE false
        END
        OR (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM event_invitations ei WHERE ei.event_id = ${e}.id AND ei.user_id = ${V}))
      ))
    )
  )`;
}

export interface EventRow {
  id: string;
  title: string;
  description: string;
  host_id: string | null;
  host_business_id: string | null;
  community_id: string | null;
  place_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
  timezone: string;
  location_text: string | null;
  latitude: number | null;
  longitude: number | null;
  online_url: string | null;
  capacity: number | null;
  visibility: 'public' | 'followers' | 'friends' | 'community' | 'private';
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  rules: string;
  cover_url: string | null;
  cover_media_id: string | null;
  going_count: number;
  interested_count: number;
  waitlist_enabled: boolean;
  published_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // viewer-relative
  is_organiser: boolean;
  is_manager: boolean;
  my_status: string | null;
  saved: boolean;
  invited: boolean;
}

export const viewerColumns = (viewer: string) => `
  ${organiserSql(viewer)} AS is_organiser,
  ${managerSql(viewer)} AS is_manager,
  (SELECT ea.status FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = (${viewer})) AS my_status,
  EXISTS (SELECT 1 FROM saves s WHERE s.user_id = (${viewer}) AND s.target_type = 'event' AND s.target_id = e.id) AS saved,
  EXISTS (SELECT 1 FROM event_invitations ei WHERE ei.event_id = e.id AND ei.user_id = (${viewer}) AND ei.status = 'pending') AS invited`;

const EVENT_COLS = `e.id, e.title, e.description, e.host_id, e.host_business_id, e.community_id, e.place_id, e.starts_at, e.ends_at, e.timezone,
  e.location_text, e.latitude, e.longitude, e.online_url, e.capacity, e.visibility, e.status, e.rules, e.cover_url, e.cover_media_id,
  e.going_count, e.interested_count, e.waitlist_enabled, e.published_at, e.cancelled_at, e.cancel_reason, e.completed_at, e.created_at, e.updated_at`;
export const eventSelect = (viewer: string) => `${EVENT_COLS}, ${viewerColumns(viewer)}`;

/** Load one event the viewer may see (404 otherwise: existence is never revealed). */
export async function loadEvent(
  db: Queryable,
  eventId: string,
  viewerId: string | null,
): Promise<EventRow> {
  const { rows } = await db.query<EventRow>(
    `SELECT ${eventSelect('$1::uuid')} FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1::uuid')}`,
    [viewerId, eventId],
  );
  if (!rows[0]) throw notFound('Event');
  return rows[0];
}

export async function loadOrganisedEvent(
  db: Queryable,
  eventId: string,
  userId: string,
): Promise<EventRow> {
  const e = await loadEvent(db, eventId, userId);
  if (!e.is_organiser) throw forbidden('Only the hosts of this event can do that');
  return e;
}

export async function loadManagedEvent(
  db: Queryable,
  eventId: string,
  userId: string,
): Promise<EventRow> {
  const e = await loadEvent(db, eventId, userId);
  if (!e.is_organiser) throw forbidden('Only the hosts of this event can do that');
  if (!e.is_manager) throw forbidden('Only the host can do that');
  return e;
}

/** Effective end of an event (open-ended events are assumed to run 3 hours). */
export const EVENT_END_SQL = `COALESCE(e.ends_at, e.starts_at + interval '3 hours')`;
