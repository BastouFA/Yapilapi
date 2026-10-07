import { yapPath } from '../lib/links';

/** Links that open Yap (yap://chat/1, the web's /yap/1 and /inbox/1) go to the chat; see lib/links.ts. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return yapPath(path);
  } catch {
    return path;
  }
}
