import { appPath } from '../lib/links';

/**
 * Links that open the app (yapilapi://…, or a web link handed to the app) go through here first,
 * so the web app's paths (boards/1, rooms/2, inbox/3, places/4, search?q=…) open the matching
 * screen: board/1, room/2, chat/3, place/4, the Wander tab. Memories, Together and Live have the
 * same paths as on the web (memories/1, together/2, live/3; yapilapi://memory/1 works too). Pages
 * for making and running things open their phone screens too: communities/new, events/new
 * (?community=…), events/5/edit, c/<slug>/settings and plus. Creators and money: studio, a
 * creator's plans (u/<name>?subscribe=1, plans/<name>), one thing from a shop
 * (u/<name>?shop=1&product=<id>), boosting a post (p/<id>?boost=1) and its insights
 * (p/<id>/insights, insights/<id>). An event's check-in (events/<id>/check-in), a reel's echoes
 * (reels/<id>/echoes), a Pass the Mic chain (chains/<id>), settings/your-data, settings/purchases
 * and the legal pages open their screens.
 * Anything unexpected opens as it came, and a path with no screen shows app/+not-found.tsx.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return appPath(path);
  } catch {
    return path;
  }
}
