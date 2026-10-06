import type { MessageKey } from './locales/en.ts';

/**
 * A topic's name in the reader's language: the catalog's topic.<slug> when there is one (the starter
 * topics), otherwise the name stored with the topic (topics people made up themselves).
 */
export function topicName(slug: string, stored: string, t: (key: MessageKey) => string): string {
  const key = `topic.${slug}`;
  const named = t(key as MessageKey);
  return named === key ? stored : named;
}
