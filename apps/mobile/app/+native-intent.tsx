import { appPath } from '../lib/links';

/**
 * Links that open the app (yapilapi://…, or a web link handed to the app) go through here first,
 * so the web app's paths (boards/1, rooms/2, inbox/3, search?q=…) open the matching screen:
 * board/1, room/2, chat/3, the Wander tab. Anything unexpected opens as it came.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return appPath(path);
  } catch {
    return path;
  }
}
