import { ApiError } from '../../../packages/api-client/src/index';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import type { Recap } from '../../../packages/shared/src/types';
import { errorMessage } from './api';
import type { Translate } from './locale';

/** Recap videos sit behind the Memory feature: when it's off, the API answers 404 `feature_disabled`. */
export const isRecapsOff = (e: unknown) => e instanceof ApiError && e.code === 'feature_disabled';

/** What to show for a failed recap request: a plain line when the feature is off, else the server's message. */
export const recapError = (e: unknown, t: Translate) => (isRecapsOff(e) ? t('m.recap.off') : errorMessage(e));

/** Still being made: poll it. */
export const isMaking = (r: Recap) => r.status === 'queued' || r.status === 'rendering';

export const RECAP_STATUS: Record<Recap['status'], MessageKey> = {
  queued: 'm.recap.status.queued',
  rendering: 'm.recap.status.rendering',
  ready: 'm.recap.status.ready',
  failed: 'm.recap.status.failed',
};

/** Width over height of a recap's video, from its size when known, else from the shape chosen. */
export const recapRatio = (r: Recap) => (r.video?.width && r.video.height ? r.video.width / r.video.height : r.aspect === '1:1' ? 1 : 9 / 16);
