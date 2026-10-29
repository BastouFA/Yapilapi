/**
 * A post was deleted in the app (its card's menu, the Radio screen): the radio and anything else
 * holding on to it lets go, so a deleted Yap never plays again from a queue fetched before.
 */
const deleted = new Set<(id: string) => void>();

export function announcePostDeleted(id: string): void {
  for (const l of deleted) {
    try {
      l(id);
    } catch {
      // One listener never stops the others.
    }
  }
}

/** Call `fn` with each post deleted from now on; returns the way to stop. */
export function onPostDeleted(fn: (id: string) => void): () => void {
  deleted.add(fn);
  return () => {
    deleted.delete(fn);
  };
}
