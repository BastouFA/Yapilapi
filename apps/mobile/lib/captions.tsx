import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CaptionCue } from '../../../packages/api-client/src/index';
import type { CaptionTrackRef, MediaItem } from '../../../packages/shared/src/types';
import { client } from './api';
import { useT } from './i18n';
import { userText } from './ui';

/**
 * Subtitles for videos. expo-video only shows subtitle tracks inside the stream, and ours are
 * separate WebVTT files, so the phone loads the cues of one track and draws the current line
 * over the video itself.
 */

// Cues already loaded, per video and language, for as long as the app runs.
const loaded = new Map<string, CaptionCue[]>();

/** The track to show: the app's language (exact, then the same language), else the first one. */
export function pickTrack(tracks: CaptionTrackRef[] | undefined, locale: string): CaptionTrackRef | null {
  if (!tracks?.length) return null;
  const base = locale.split('-')[0]!.toLowerCase();
  return tracks.find((x) => x.lang.toLowerCase() === locale.toLowerCase()) ?? tracks.find((x) => x.lang.split('-')[0]!.toLowerCase() === base) ?? tracks[0]!;
}

/** The cues of a video's subtitles when `enabled` (nothing loads otherwise); null until loaded or when it has none. */
export function useCaptionCues(media: MediaItem | null | undefined, enabled: boolean): CaptionCue[] | null {
  const { locale } = useT();
  const track = media ? pickTrack(media.captions, locale) : null;
  const key = media && track ? `${media.id}:${track.lang}` : null;
  const [cues, setCues] = useState<CaptionCue[] | null>(key ? (loaded.get(key) ?? null) : null);
  useEffect(() => {
    if (!enabled || !key || !media || !track) return setCues(null);
    const have = loaded.get(key);
    if (have) return setCues(have);
    let current = true;
    void client()
      .then((api) => api.studio.captionCues(media.id, track.lang))
      .then(
        (r) => {
          loaded.set(key, r.cues);
          if (current) setCues(r.cues);
        },
        () => current && setCues(null),
      );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return enabled ? cues : null;
}

/**
 * The subtitle line for the moment `seconds` of the video, centred near the bottom. Screen
 * readers skip it: they hear the video itself.
 */
export function CaptionOverlay({ cues, seconds, big, bottom }: { cues: CaptionCue[] | null; seconds: number; big?: boolean; bottom: number }) {
  if (!cues?.length) return null;
  const text = cues
    .filter((c) => seconds >= c.start && seconds <= c.end)
    .map((c) => c.text)
    .join('\n');
  if (!text) return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[s.wrap, { bottom }]}>
      <Text style={[s.line, big && s.big, userText]}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', start: 16, end: 16, alignItems: 'center' },
  line: {
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: 'rgba(5,6,11,0.72)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  big: { fontSize: 20, lineHeight: 28 },
});
