import type { MessageKey } from './i18n-core.ts';
import type { CaptionErrorCode, MediaEditErrorCode, MessageFailureCode, RecapErrorCode, ScheduledPostFailureCode } from './types.ts';

/**
 * Why something the app did for you later didn't work: a recap video, a trim or automatic
 * captions, a message scheduled for later, a story sent to several chats, a scheduled post. The
 * API sends a code (and keeps its English for older apps); the web and the phone put it into
 * words here, and the API writes that English from the same messages. The phone imports this
 * file directly, so no zod.
 */

export const RECAP_ERROR_KEYS: Record<RecapErrorCode, MessageKey> = {
  source_unavailable: 'recaps.error.sourceUnavailable',
  items_unavailable: 'recaps.error.itemsUnavailable',
  items_unreadable: 'recaps.error.itemsUnreadable',
  render_failed: 'recaps.error.renderFailed',
  failed: 'recaps.error.failed',
};

export const MEDIA_EDIT_ERROR_KEYS: Record<MediaEditErrorCode, MessageKey> = {
  source_missing: 'videoEditor.error.sourceMissing',
  render_failed: 'videoEditor.error.renderFailed',
  process_failed: 'videoEditor.error.processFailed',
};

export const CAPTION_ERROR_KEYS: Record<CaptionErrorCode, MessageKey> = {
  not_set_up: 'videoEditor.captions.error.notSetUp',
  no_sound: 'videoEditor.captions.error.noSound',
  no_speech: 'videoEditor.captions.error.noSpeech',
  too_long: 'videoEditor.captions.error.tooLong',
  failed: 'videoEditor.captions.error.failed',
};

export const MESSAGE_FAILURE_KEYS: Record<MessageFailureCode, MessageKey> = {
  left_chat: 'chat.failure.leftChat',
  unavailable: 'chat.failure.unavailable',
  cannot_message: 'chat.failure.cannotMessage',
  account_inactive: 'chat.failure.accountInactive',
  account_limited: 'chat.failure.accountLimited',
  verify: 'chat.failure.verify',
  content_blocked: 'chat.failure.contentBlocked',
  too_fast: 'chat.failure.tooFast',
  not_sent: 'chat.failure.notSent',
};

export const SCHEDULED_POST_FAILURE_KEYS: Record<ScheduledPostFailureCode, MessageKey> = {
  media_blocked: 'drafts.failure.mediaBlocked',
  community: 'drafts.failure.community',
  no_plan: 'drafts.failure.noPlan',
  music: 'drafts.failure.music',
  people: 'drafts.failure.people',
  content_blocked: 'drafts.failure.contentBlocked',
  verify: 'drafts.failure.verify',
  too_fast: 'drafts.failure.tooFast',
  check_draft: 'drafts.failure.checkDraft',
};

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Whether `value` is one of the codes in `keys` (the API stores codes in the columns that used to hold English). */
export function isFailureCode<C extends string>(keys: Record<C, MessageKey>, value: unknown): value is C {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(keys, value);
}

/** The code's sentence, else the English an older API sent, else null. */
function coded<C extends string>(keys: Record<C, MessageKey>, code: C | null | undefined, english: string | null | undefined, t: T): string | null {
  return isFailureCode(keys, code) ? t(keys[code]) : english || null;
}

/** Why a recap video couldn't be made. */
export const recapErrorText = (r: { errorCode?: RecapErrorCode | null; error?: string | null }, t: T) => coded(RECAP_ERROR_KEYS, r.errorCode, r.error, t);

/** Why a trim or clip couldn't be made. */
export const mediaEditErrorText = (e: { errorCode?: MediaEditErrorCode | null; error?: string | null }, t: T) =>
  coded(MEDIA_EDIT_ERROR_KEYS, e.errorCode, e.error, t);

/** Why automatic captions couldn't be made. */
export const captionErrorText = (c: { errorCode?: CaptionErrorCode | null; error?: string | null }, t: T) => coded(CAPTION_ERROR_KEYS, c.errorCode, c.error, t);

/** Why a message scheduled for later wasn't sent. */
export const scheduledFailureText = (s: { failureCode?: MessageFailureCode | null; failure?: string | null }, t: T) =>
  coded(MESSAGE_FAILURE_KEYS, s.failureCode, s.failure, t);

/** Why a story didn't reach one of the chats it was sent to (`failed[]` of POST /v1/moments/:id/send). */
export const storySendFailureText = (f: { code?: MessageFailureCode | null; message?: string | null }, t: T) =>
  coded(MESSAGE_FAILURE_KEYS, f.code, f.message, t);

/** The `scheduled_post_failed` notification as a whole: it's back in drafts, and why when we know. */
export function scheduledPostFailedText(n: { data: Record<string, unknown> }, t: T): string {
  const code = n.data.code as ScheduledPostFailureCode | undefined;
  const why = coded(SCHEDULED_POST_FAILURE_KEYS, code, typeof n.data.reason === 'string' ? n.data.reason : null, t);
  return why ? `${t('m.notif.scheduledFailed')} ${why}` : t('m.notif.scheduledFailed');
}
