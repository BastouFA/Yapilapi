import { NOTICE_KEYS, type ModerationNotice, type NoticeCode } from '@yapilapi/shared';
import { t } from '@yapilapi/shared/i18n';

/**
 * Notes after publishing something that waits for review. The apps put the code into words in
 * the reader's language (noticeText in packages/shared/src/server-text.ts); the English, from the
 * same message, stays for older apps.
 */

/** `{ noticeCode, notice }`, for responses that carry the note beside what was made (a question, a listing, a message). */
export function heldNotice(code: NoticeCode): { noticeCode: NoticeCode; notice: string } {
  return { noticeCode: code, notice: t(NOTICE_KEYS[code], 'en') };
}

/** `moderation` on a post, reel, answer or mix that isn't shown to everyone yet. */
export function moderationOf(status: string, code: NoticeCode): ModerationNotice {
  return { status, code, message: t(NOTICE_KEYS[code], 'en') };
}
