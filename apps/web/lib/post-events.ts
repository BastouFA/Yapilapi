/**
 * A post was deleted on this page (its card's menu, the Radio page): the radio and anything else
 * holding on to it lets go, so a deleted Yap never plays again from a queue fetched before.
 */
const POST_DELETED = 'yp:post-deleted';

export function announcePostDeleted(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(POST_DELETED, { detail: id }));
}

/** Call `fn` with each post deleted from now on; returns the way to stop. */
export function onPostDeleted(fn: (id: string) => void): () => void {
  const listener = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(POST_DELETED, listener);
  return () => window.removeEventListener(POST_DELETED, listener);
}
