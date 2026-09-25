import { AppError } from '@yapilapi/shared';
import { classifyText } from '@yapilapi/moderation';

/**
 * For public-facing descriptive text that has no moderation-status column (event/place/business descriptions, replies):
 * reject anything the classifier would not approve instead of publishing it. Uses the same classifier as `screenText`.
 */
export function assertTextAllowed(...texts: Array<string | null | undefined>): void {
  const joined = texts.filter(Boolean).join('\n');
  if (!joined.trim()) return;
  const r = classifyText(joined);
  if (r.status !== 'approved') {
    throw new AppError(
      'unprocessable',
      'This text may violate our community guidelines. Please revise it.',
      { categories: r.categories },
    );
  }
}
