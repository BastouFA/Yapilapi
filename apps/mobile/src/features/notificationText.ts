import type { AppNotification } from '../api';
import type { T } from '../i18n';
import { en } from '../i18n/messages/en';

/** Localised one-line description of a notification. Kinds the app has no copy for fall back to a generic line (never raw API text). */
export function notificationText(n: Pick<AppNotification, 'kind' | 'actor'>, t: T): string {
  const key = `notifications.kind.${n.kind}`;
  if (!(key in en) || key === 'notifications.kind.generic') return t('notifications.kind.generic');
  const action = t(key as 'notifications.kind.generic');
  // Kinds whose copy is a full sentence ("Your data export is ready.") come without an actor.
  return n.actor
    ? t('notifications.by', { name: n.actor.displayName || n.actor.username, action })
    : action;
}
