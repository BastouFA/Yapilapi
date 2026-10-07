import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { AppState, type ViewToken } from 'react-native';
import { FEED_EVENTS_MAX_BATCH, type FeedEventSurface, type FeedMode } from '../../../packages/shared/src/constants';
import type { FeedEvent } from '../../../packages/shared/src/types';
import { client, getToken } from './api';

/**
 * What happened to posts on screen, for the recommender (POST /v1/feed/events): seen, for how
 * long, watched, finished, skipped, shared, the author's profile opened. Events wait in memory
 * and go in batches: every few seconds, as soon as a full batch is ready, and when the app goes
 * to the background. A batch that can't be sent is dropped: these are hints, never worth an
 * error on screen or a retry loop.
 */

const FLUSH_MS = 5000;
// Offline for a long while: the oldest events go first, so the queue stays small.
const MAX_QUEUED = FEED_EVENTS_MAX_BATCH * 10;
// The API refuses times over an hour.
const MAX_VALUE_MS = 3_600_000;

let queue: FeedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;

export function recordFeedEvent(e: FeedEvent) {
  watchAppState();
  const valueMs = e.valueMs === undefined || !Number.isFinite(e.valueMs) ? undefined : Math.max(0, Math.min(MAX_VALUE_MS, Math.round(e.valueMs)));
  queue.push(valueMs === undefined ? { postId: e.postId, surface: e.surface, kind: e.kind } : { ...e, valueMs });
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
  if (queue.length >= FEED_EVENTS_MAX_BATCH) void flushFeedEvents();
  else if (!timer) timer = setTimeout(() => void flushFeedEvents(), FLUSH_MS);
}

/** Sends what's waiting, in batches of up to FEED_EVENTS_MAX_BATCH. */
export async function flushFeedEvents() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (sending || !queue.length) return;
  sending = true;
  const batch = queue;
  queue = [];
  try {
    // Signed out: nothing to tell.
    if (await getToken()) {
      const api = await client();
      for (let i = 0; i < batch.length; i += FEED_EVENTS_MAX_BATCH) await api.feed.events(batch.slice(i, i + FEED_EVENTS_MAX_BATCH));
    }
  } catch {
    // Offline or refused: this batch is dropped.
  } finally {
    sending = false;
    // Events recorded while this batch was on its way.
    if (queue.length >= FEED_EVENTS_MAX_BATCH) void flushFeedEvents();
    else if (queue.length && !timer) timer = setTimeout(() => void flushFeedEvents(), FLUSH_MS);
  }
}

// Leaving the app (background, or the app switcher): screens close what they're timing, then the queue goes.
let watching = false;
let appAway = false;
const awayListeners = new Set<(away: boolean) => void>();
function watchAppState() {
  if (watching) return;
  watching = true;
  AppState.addEventListener('change', (s) => {
    const away = s === 'background' || s === 'inactive';
    if ((!away && s !== 'active') || away === appAway) return;
    appAway = away;
    for (const l of awayListeners) {
      try {
        l(away);
      } catch {
        // One screen's timing never stops the others.
      }
    }
    if (away) void flushFeedEvents();
  });
}

/** Called with true when the app leaves the foreground and false when it's back. Returns the unsubscribe. */
export function onAppAway(listener: (away: boolean) => void) {
  watchAppState();
  awayListeners.add(listener);
  return () => {
    awayListeners.delete(listener);
  };
}

/** Pulse's feed modes as the recommender names them; Local has no surface of its own. */
export const feedSurface = (mode: FeedMode): FeedEventSurface =>
  mode === 'for_you' || mode === 'following' || mode === 'friends' || mode === 'communities' ? mode : 'other';

/** The list a post card is in, so its share and profile taps say where they happened. */
export const FeedSurfaceContext = createContext<FeedEventSurface>('other');
export const useFeedSurface = () => useContext(FeedSurfaceContext);

/** Half of a post on screen for a second counts as seen. */
const VIEWABILITY = { itemVisiblePercentThreshold: 50, minimumViewTime: 1000 };

/**
 * For a FlatList of posts whose keys are the post ids (or with `idOf` to find the post in an item): `impression` when a post has been half on
 * screen for a second, `dwell` with how long it stayed when it goes. Time on another screen or
 * with the app in the background doesn't count. Spread the result on the list; both props stay
 * the same objects, as React Native requires.
 */
export function useFeedViewability(surface: FeedEventSurface, idOf?: (item: unknown) => string | null | undefined) {
  const state = useRef({ surface, viewable: new Set<string>(), since: new Map<string, number>(), blurred: false, away: false }).current;

  const end = useCallback(
    (id: string) => {
      const at = state.since.get(id);
      if (at === undefined) return;
      state.since.delete(id);
      recordFeedEvent({ postId: id, surface: state.surface, kind: 'dwell', valueMs: Date.now() - at });
    },
    [state],
  );
  const pause = useCallback(() => {
    for (const id of [...state.since.keys()]) end(id);
  }, [state, end]);
  const resume = useCallback(() => {
    if (state.blurred || state.away) return;
    const now = Date.now();
    for (const id of state.viewable) if (!state.since.has(id)) state.since.set(id, now);
  }, [state]);

  const onViewableItemsChanged = useRef(({ changed }: { changed: ViewToken[] }) => {
    for (const v of changed) {
      // Lists keyed by something else (a community's mixed list) say which post an item is.
      const id = idOf ? idOf(v.item) : v.key;
      if (!id) continue;
      if (v.isViewable) {
        if (state.viewable.has(id)) continue;
        state.viewable.add(id);
        recordFeedEvent({ postId: id, surface: state.surface, kind: 'impression' });
        if (!state.blurred && !state.away) state.since.set(id, Date.now());
      } else {
        state.viewable.delete(id);
        end(id);
      }
    }
  }).current;

  // Another feed mode: what was on screen ends under the old one.
  useEffect(() => {
    if (state.surface === surface) return;
    pause();
    state.viewable.clear();
    state.surface = surface;
  }, [surface, state, pause]);

  useFocusEffect(
    useCallback(() => {
      state.blurred = false;
      resume();
      return () => {
        state.blurred = true;
        pause();
      };
    }, [state, pause, resume]),
  );
  useEffect(() => {
    const off = onAppAway((away) => {
      state.away = away;
      if (away) pause();
      else resume();
    });
    return () => {
      off();
      pause();
    };
  }, [state, pause, resume]);

  return { onViewableItemsChanged, viewabilityConfig: VIEWABILITY };
}
