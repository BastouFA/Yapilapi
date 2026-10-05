import type { MessageKey } from './i18n-core.ts';

/**
 * Telling a developer how their Mini App's review went. The API notifies the developer app's
 * owner when an admin approves or turns down a Mini App (`mini_app_approved`, `mini_app_rejected`),
 * with the Mini App's name in `data.title` and, when the admin gave one, the reason in
 * `data.reason`. The web app and the phone share this (no zod: the phone imports this file directly).
 */

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** What the notification says, as a whole sentence in the reader's language, or null for other kinds. */
export function miniAppNoticeText(n: { type: string; data: Record<string, unknown> }, t: Tr): string | null {
  const title = String(n.data.title ?? '');
  if (n.type === 'mini_app_approved') return t('miniApps.notif.approved', { title });
  if (n.type !== 'mini_app_rejected') return null;
  const reason = typeof n.data.reason === 'string' ? n.data.reason.trim() : '';
  return reason ? t('miniApps.notif.rejectedWhy', { title, reason }) : t('miniApps.notif.rejected', { title });
}
