import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { languageName } from '../../../packages/shared/src/translation';
import type { VoiceTranscript as Transcript } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { useT } from './i18n';
import { TranslationBar, useTranslatable, useTranslationSettings } from './translation';
import { space } from './theme';
import { Icon, userText } from './ui';

/**
 * What was said in a voice message (docs/product/speech-engine.md), behind "Show text". In a
 * language the reader doesn't understand it's translated like a message ("Translated from French ·
 * See original"), and the translation can be heard: "Listen in English", a plain synthetic voice.
 * Shared by the phone app's chat and Yap.
 */
export function VoiceTranscript({ id, transcript, own, tint }: { id: string; transcript: Transcript; own: boolean; tint: string }) {
  const { t } = useT();
  const { voice } = useTranslationSettings();
  const [open, setOpen] = useState(false);
  if (!voice.transcripts) return null;
  return (
    <View style={{ gap: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
        style={{ minHeight: 32, justifyContent: 'center', alignSelf: 'flex-start' }}
      >
        <Text style={{ color: tint, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' }}>
          {open ? t('chat.transcript.hide') : t('chat.transcript.show')}
        </Text>
      </Pressable>
      {open ? <Words id={id} transcript={transcript} own={own || !voice.translation} tint={tint} /> : null}
    </View>
  );
}

function Words({ id, transcript, own, tint }: { id: string; transcript: Transcript; own: boolean; tint: string }) {
  const { voice } = useTranslationSettings();
  const state = useTranslatable({ kind: 'transcript', id, text: transcript.text, lang: transcript.lang, own });
  const shown = state.status === 'shown' ? state.translation : null;
  return (
    <View ref={state.ref} collapsable={false}>
      <Text style={[{ color: tint, fontSize: 15, lineHeight: 21 }, userText]} accessibilityLanguage={state.lang ?? transcript.lang ?? undefined}>
        {state.text}
      </Text>
      <TranslationBar state={state} tint={tint} linkTint={tint} />
      {shown && voice.listen ? <Listen id={id} target={shown.targetLanguage} tint={tint} /> : null}
    </View>
  );
}

/**
 * "Listen in English": the translation read out, made the first time anyone asks and then shared.
 * `kind` 'voice' is a Yap's, a voice reply's or an intro's transcript (lib/voice.tsx).
 */
export function Listen({ id, target, tint, kind = 'transcript' }: { id: string; target: string; tint: string; kind?: 'transcript' | 'voice' }) {
  const { t, locale } = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  // Play as soon as the clip is here (it was asked for by a tap).
  useEffect(() => {
    if (!url) return;
    void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    player.play();
  }, [url, player]);
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      void player.seekTo(0);
    }
  }, [status.didJustFinish, player]);
  const press = async () => {
    setError(null);
    if (status.playing) return player.pause();
    if (url) return player.play();
    setLoading(true);
    try {
      const api = await client();
      setUrl(mediaUrl((kind === 'voice' ? await api.voice.speech(id, target) : await api.messages.transcriptSpeech(id, target)).url));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <View style={{ gap: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: status.playing, busy: loading, disabled: loading }}
        disabled={loading}
        onPress={() => void press()}
        hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
        style={{ minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[1], alignSelf: 'flex-start' }}
      >
        <Icon name={status.playing ? 'pause-circle' : 'play-circle'} size={20} color={tint} />
        <Text style={{ color: tint, fontSize: 13, fontWeight: '700' }}>{t('chat.transcript.listen', { language: languageName(target, locale) })}</Text>
      </Pressable>
      {error ? <Text style={{ color: tint, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}
