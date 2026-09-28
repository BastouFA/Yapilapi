import {
  CAPTION_ERROR_KEYS,
  isFailureCode,
  MEDIA_EDIT_ERROR_KEYS,
  MESSAGE_FAILURE_KEYS,
  RECAP_ERROR_KEYS,
  SCHEDULED_POST_FAILURE_KEYS,
  type CaptionErrorCode,
  type MediaEditErrorCode,
  type MessageFailureCode,
  type RecapErrorCode,
  type ScheduledPostFailureCode,
} from '@yapilapi/shared';
import { t } from '@yapilapi/shared/i18n';
import type { MessageKey } from '@yapilapi/shared';
import { AppError } from './errors.ts';

/**
 * Why a job didn't work, as a code the apps put into words (packages/shared/src/job-failures.ts).
 * The columns that used to hold an English sentence now hold the code; responses carry the code
 * and, for older apps, its English. What went wrong inside (ffmpeg, a provider) goes to the logs,
 * never to people.
 */

/**
 * A stored failure read back: the code, and its English. A row from before codes has an English
 * sentence: the code whose English it starts with (anything after, like ffmpeg's output, is
 * dropped), else `fallback`.
 */
export function storedFailure<C extends string>(
  keys: Record<C, MessageKey>,
  stored: string | null | undefined,
  fallback: C,
): { code: C; english: string } | null {
  if (!stored) return null;
  if (isFailureCode(keys, stored)) return { code: stored, english: t(keys[stored], 'en') };
  const code = (Object.keys(keys) as C[]).find((c) => stored.startsWith(t(keys[c], 'en'))) ?? fallback;
  return { code, english: t(keys[code], 'en') };
}

export const recapFailure = (stored: string | null | undefined) => storedFailure<RecapErrorCode>(RECAP_ERROR_KEYS, stored, 'failed');
export const mediaEditFailure = (stored: string | null | undefined) => storedFailure<MediaEditErrorCode>(MEDIA_EDIT_ERROR_KEYS, stored, 'render_failed');
export const captionFailure = (stored: string | null | undefined) => storedFailure<CaptionErrorCode>(CAPTION_ERROR_KEYS, stored, 'failed');

/** A message failure read back; one kept from before codes keeps its English, which was already a sentence for people. */
export function messageFailure(stored: string | null | undefined): { code?: MessageFailureCode; english: string } | null {
  if (!stored) return null;
  return isFailureCode(MESSAGE_FAILURE_KEYS, stored) ? { code: stored, english: t(MESSAGE_FAILURE_KEYS[stored], 'en') } : { english: stored };
}

/** Why sending a message was refused, from the error the send gave (its status and code). */
export function messageFailureCode(e: { status?: number; code?: string }): MessageFailureCode {
  switch (e.code) {
    case 'not_member':
      return 'left_chat';
    case 'not_found':
      return 'unavailable';
    case 'forbidden':
    case 'minor_protection':
    case 'family_controls':
    case 'messages_limited':
      return 'cannot_message';
    case 'account_inactive':
      return 'account_inactive';
    case 'account_restricted':
      return 'account_limited';
    case 'verification_required':
      return 'verify';
    case 'content_blocked':
    case 'media_blocked':
      return 'content_blocked';
    default:
      return e.status === 429 ? 'too_fast' : 'not_sent';
  }
}

/** The English of a message failure, for older apps. */
export const messageFailureEnglish = (code: MessageFailureCode) => t(MESSAGE_FAILURE_KEYS[code], 'en');

/**
 * Why a scheduled post couldn't go out, from the error publishing it gave. A refusal that names
 * its reason in `details.failure` (joining the community, a subscription plan) says so; the rest
 * go by their code.
 */
export function scheduledPostFailureCode(e: AppError): ScheduledPostFailureCode {
  const named = (e.details as { failure?: unknown } | undefined)?.failure;
  if (isFailureCode(SCHEDULED_POST_FAILURE_KEYS, named)) return named;
  switch (e.code) {
    case 'media_blocked':
      return 'media_blocked';
    case 'music_unavailable':
    case 'music_not_allowed':
      return 'music';
    case 'minor_protection':
    case 'tag_not_allowed':
    case 'collab_not_allowed':
      return 'people';
    case 'content_blocked':
      return 'content_blocked';
    case 'verification_required':
      return 'verify';
    case 'slow_down':
      return 'too_fast';
    default:
      return 'check_draft';
  }
}

export const scheduledPostFailureEnglish = (code: ScheduledPostFailureCode) => t(SCHEDULED_POST_FAILURE_KEYS[code], 'en');

/** Where a job writes what went wrong inside (the app's logger in the worker; nothing in tests). */
export interface JobLog {
  warn(obj: object, msg: string): void;
}
