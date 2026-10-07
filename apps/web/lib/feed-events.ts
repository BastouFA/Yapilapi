import { useEffect, useRef, type RefObject } from 'react';
import { FEED_EVENTS_MAX_BATCH, type FeedEvent, type FeedEventSurface } from '@yapilapi/shared';
import { api } from './api';

/**
 * What happens to posts on screen, for the recommender (POST /v1/feed/events). Events wait here
 * and go in batches: every few seconds, as soon as there are 50, and when the page is hidden or
 * closed (sent so they arrive even as the page goes away). A batch that fails is dropped: these
 * are hints, never worth an error or a retry loop.
 */
const FLUSH_MS = 5000;
/** The API refuses times over an hour; anything longer is a tab left open, not watching. */
const MAX_VALUE_MS = 3_600_000;

let queue: FeedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
let closingFlush = false;

function batches(events: FeedEvent[]): FeedEvent[][] {
  const out: FeedEvent[][] = [];
  for (let i = 0; i < events.length; i += FEED_EVENTS_MAX_BATCH) out.push(events.slice(i, i + FEED_EVENTS_MAX_BATCH));
  return out;
}

/** Send what's waiting now. `closing` sends it the way that survives the page going away. */
export function flushFeedEvents(closing = false) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const events = queue;
  queue = [];
  for (const batch of batches(events)) {
    try {
      if (closing) api.feed.eventsOnPageClose(batch);
      else void api.feed.events(batch).catch(() => {});
    } catch {
      // Never let a hint break the page.
    }
  }
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const close = () => flushFeedEvents(true);
  window.addEventListener('pagehide', close);
  // On the window, so it runs after the page's own listeners on the document have recorded their last events.
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') close();
  });
}

/** Note one event; it goes with the next batch. */
export function recordFeedEvent(e: FeedEvent) {
  if (typeof window === 'undefined') return;
  listen();
  const event: FeedEvent =
    e.valueMs === undefined ? e : { ...e, valueMs: Math.max(0, Math.min(MAX_VALUE_MS, Math.round(Number.isFinite(e.valueMs) ? e.valueMs : 0))) };
  queue.push(event);
  // Recorded while the page is hiding or closing (a listener that ran after ours): send it straight after.
  if (document.visibilityState === 'hidden') {
    if (!closingFlush) {
      closingFlush = true;
      queueMicrotask(() => {
        closingFlush = false;
        flushFeedEvents(true);
      });
    }
    return;
  }
  if (queue.length >= FEED_EVENTS_MAX_BATCH) flushFeedEvents();
  else if (!timer) timer = setTimeout(() => flushFeedEvents(), FLUSH_MS);
}

/** On screen: at least half of it (or, for a post taller than the screen, half the screen). */
const VISIBLE_RATIO = 0.5;
const onScreen = (e: IntersectionObserverEntry) =>
  e.isIntersecting && (e.intersectionRatio >= VISIBLE_RATIO || (!!e.rootBounds && e.intersectionRect.height >= e.rootBounds.height * VISIBLE_RATIO));
/** An impression is half of it on screen for this long without a break. */
const IMPRESSION_MS = 1000;

/**
 * Records an `impression` when at least half of the element has been on screen for a second
 * (once while it's mounted), then a `dwell` with how long it stayed that visible each time it
 * leaves the screen, the page is hidden, or it unmounts. Nothing is recorded while `enabled` is off.
 */
export function useImpression(ref: RefObject<Element | null>, postId: string, surface: FeedEventSurface, enabled = true) {
  const impressed = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    let visibleSince: number | null = null;
    let dwellMs = 0;
    let impressionTimer: ReturnType<typeof setTimeout> | null = null;
    let inView = false;

    const start = () => {
      if (visibleSince !== null || document.visibilityState === 'hidden') return;
      visibleSince = performance.now();
      if (!impressed.current && !impressionTimer)
        impressionTimer = setTimeout(() => {
          impressionTimer = null;
          impressed.current = true;
          recordFeedEvent({ postId, surface, kind: 'impression' });
        }, IMPRESSION_MS);
    };
    const stop = () => {
      if (impressionTimer) clearTimeout(impressionTimer);
      impressionTimer = null;
      if (visibleSince === null) return;
      dwellMs += performance.now() - visibleSince;
      visibleSince = null;
      if (impressed.current && dwellMs > 0) recordFeedEvent({ postId, surface, kind: 'dwell', valueMs: dwellMs });
      dwellMs = 0;
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          inView = onScreen(e);
          if (inView) start();
          else stop();
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(el);
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : inView && start());
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [ref, postId, surface, enabled]);
}
