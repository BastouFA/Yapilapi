import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CaptionCue } from '../../../packages/api-client/src/index';
import type { CaptionTrackRef, MediaItem } from '../../../packages/shared/src/types';
import { baseLanguage, languageName } from '../../../packages/shared/src/translation';
import { client } from './api';
import { useT } from './i18n';
import { useTranslationSettings } from './translation';
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

/**
 * The track a video's subtitles come from, and the language they're translated into when it
 * has none in the app's language and automatic translation works ("French (translated)").
 */
export function useCaptionTrack(media: MediaItem | null | undefined): { track: CaptionTrackRef | null; translatedTo: string | null; label: string | null } {
  const { locale, lang, t } = useT();
  const { available } = useTranslationSettings();
  const track = media ? pickTrack(media.captions, locale) : null;
  const target = baseLanguage(lang);
  const translatedTo = track && available && baseLanguage(track.lang) !== target ? target : null;
  return { track, translatedTo, label: translatedTo ? t('translate.captionTrack', { language: languageName(translatedTo, locale) }) : null };
}

/** The cues of a video's subtitles when `enabled` (nothing loads otherwise); null until loaded or when it has none. */
export function useCaptionCues(media: MediaItem | null | undefined, enabled: boolean): CaptionCue[] | null {
  const { track, translatedTo } = useCaptionTrack(media);
  const key = media && track ? `${media.id}:${track.lang}${translatedTo ? `>${translatedTo}` : ''}` : null;
  const [cues, setCues] = useState<CaptionCue[] | null>(key ? (loaded.get(key) ?? null) : null);
  useEffect(() => {
    if (!enabled || !key || !media || !track) return setCues(null);
    const have = loaded.get(key);
    if (have) return setCues(have);
    let current = true;
    void client()
      .then(async (api) => {
        // Translated into the app's language (made once for everyone); the track as it is when that can't be done.
        if (translatedTo) {
          const r = await api.studio.translatedCaptionCues(media.id, track.lang, translatedTo).catch(() => null);
          if (r) return r;
        }
        return api.studio.captionCues(media.id, track.lang);
      })
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
