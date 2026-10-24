import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { MusicTrack } from '../../../../packages/shared/src/music';
import type { SquadCard } from '../../../../packages/shared/src/squads';
import {
  STASH_AUDIENCES,
  STASH_AUDIENCE_KEYS,
  STASH_DURATIONS,
  STASH_DURATION_KEYS,
  STASH_GIFT_MAX,
  STASH_HINT_MAX,
  STASH_KINDS,
  STASH_KIND_KEYS,
  STASH_MAX_ACCURACY,
  STASH_TEXT_MAX,
  STASH_TITLE_MAX,
  type StashAudience,
  type StashDuration,
  type StashKind,
} from '../../../../packages/shared/src/stash';
import type { PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { CLIP_MAX_SECONDS, pickOne, uploadPicked } from '../../lib/media';
import { MusicPicker } from '../../lib/music';
import { STASH_KIND_ICONS, readPrecise, useWhereProblem, type Position } from '../../lib/stash';
import { radius, space } from '../../lib/theme';
import { Button, EmptyState, Field, Icon, KeyboardAvoid, Notice, Segmented, SwitchRow, useColors } from '../../lib/ui';
import { uploadVoice, VoiceRecorder } from '../../lib/voice';

/**
 * Hide a stash (docs/product/stash.md): what goes in (a note, photo, short video, song, voice note
 * or gift), a title and hint, who can open it, how long, and whether only the first finder gets
 * it. It's hidden exactly where the phone is when "Hide it here" is tapped (read then, accurate to
 * STASH_MAX_ACCURACY metres or better); others only ever see the area around it.
 */
export default function HideStashScreen() {
  const c = useColors();
  const { t } = useT();
  const on = useFlag('STASH') !== false;
  const where = useWhereProblem();
  const [kind, setKind] = useState<StashKind>('text');
  const [body, setBody] = useState('');
  const [giftCode, setGiftCode] = useState('');
  const [title, setTitle] = useState('');
  const [hint, setHint] = useState('');
  const [audience, setAudience] = useState<StashAudience>('everyone');
  const [recipient, setRecipient] = useState<string | null>(null);
  const [squadId, setSquadId] = useState<string | null>(null);
  const [duration, setDuration] = useState<StashDuration>('7d');
  const [firstOnly, setFirstOnly] = useState(false);
  const [media, setMedia] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [voice, setVoice] = useState<string | null>(null);
  const [song, setSong] = useState<MusicTrack | null>(null);
  const [picking, setPicking] = useState(false);
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [squads, setSquads] = useState<SquadCard[]>([]);
  const [pos, setPos] = useState<Position | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (audience === 'person' && !people.length)
      void client()
        .then((api) => api.squads.candidates())
        .then(
          (r) => setPeople(r.items),
          () => {},
        );
    if (audience === 'squad' && !squads.length)
      void client()
        .then((api) => api.squads.list())
        .then(
          (r) => setSquads(r.items.filter((s) => s.role)),
          () => {},
        );
  }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!on) return <EmptyState title={t('stash.title')} icon="gift-outline" />;

  async function pick() {
    setProblem(null);
    const picked = await pickOne(kind === 'photo' ? ['images'] : ['videos'], CLIP_MAX_SECONDS);
    if (picked === 'denied') return setProblem(t('m.market.nearby.denied'));
    if (!picked) return;
    setUploading(true);
    try {
      const m = await uploadPicked(picked);
      await (await client()).media.waitUntilProcessed(m.id);
      setMedia(m.id);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      const p = await readPrecise().catch((e) => {
        setProblem(where(e));
        return null;
      });
      if (!p) return;
      setPos(p);
      if (p.accuracy > STASH_MAX_ACCURACY) return setProblem(t('stash.form.inaccurate'));
      const voiceId = kind === 'voice' && voice ? (await uploadVoice(voice, 'yap')).id : undefined;
      const api = await client();
      const { stash } = await api.stash.hide({
        kind,
        title: title.trim() || undefined,
        hint: hint.trim() || undefined,
        body: body.trim() || undefined,
        giftCode: kind === 'gift' ? giftCode.trim() || undefined : undefined,
        mediaId: kind === 'photo' || kind === 'video' ? (media ?? undefined) : undefined,
        voiceId,
        music: kind === 'song' && song ? (song.source === 'library' ? { soundId: song.id } : { trackId: song.id }) : undefined,
        audience,
        recipientId: audience === 'person' ? (recipient ?? undefined) : undefined,
        squadId: audience === 'squad' ? (squadId ?? undefined) : undefined,
        duration,
        firstOnly,
        position: p,
      });
      router.replace(`/stash/${stash.id}`);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    (kind === 'text' && !!body.trim()) ||
    (kind === 'gift' && !!giftCode.trim()) ||
    ((kind === 'photo' || kind === 'video') && !!media) ||
    (kind === 'voice' && !!voice) ||
    (kind === 'song' && !!song);

  const choice = (label: string, selected: boolean, onPress: () => void, key: string) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: 44,
        paddingHorizontal: space[3],
        justifyContent: 'center',
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: selected ? c.yapi : c.line,
        backgroundColor: selected ? c.yapiSoft : c.surface,
      }}
    >
      <Text style={{ color: c.ink, fontWeight: selected ? '700' : '500' }}>{label}</Text>
    </Pressable>
  );

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 22 }}>{t('stash.hint')}</Text>
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700' }}>
            {t('stash.form.what')}
          </Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {STASH_KINDS.map((k) => (
              <Pressable
                key={k}
                accessibilityRole="radio"
                accessibilityState={{ selected: kind === k }}
                accessibilityLabel={t(STASH_KIND_KEYS[k])}
                onPress={() => {
                  setKind(k);
                  setMedia(null);
                  setProblem(null);
                }}
                style={{
                  width: 96,
                  minHeight: 64,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: kind === k ? c.yapi : c.line,
                  backgroundColor: kind === k ? c.yapiSoft : c.surface,
                }}
              >
                <Icon name={STASH_KIND_ICONS[k]} size={22} color={kind === k ? c.yapi : c.ink} />
                <Text style={{ color: c.ink, fontSize: 13, fontWeight: kind === k ? '700' : '500' }}>{t(STASH_KIND_KEYS[k])}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {kind === 'gift' ? (
          <Field label={t('stash.form.gift')} value={giftCode} maxLength={STASH_GIFT_MAX} onChangeText={setGiftCode} autoCapitalize="characters" />
        ) : null}
        {kind === 'photo' || kind === 'video' ? (
          <Button
            label={uploading ? t('settings.uploading') : media ? t('m.common.done') : kind === 'photo' ? t('stash.form.photo') : t('stash.form.video')}
            icon={kind === 'photo' ? 'image-outline' : 'videocam-outline'}
            variant="secondary"
            disabled={uploading}
            onPress={() => pick()}
          />
        ) : null}
        {kind === 'voice' ? <VoiceRecorder maxMs={60_000} purpose="yap" onDone={(uri) => setVoice(uri)} onCancel={() => setVoice(null)} busy={busy} /> : null}
        {kind === 'song' ? (
          <>
            <Button
              label={song ? `${song.title} · ${song.artist}` : t('stash.form.song')}
              icon="musical-notes-outline"
              variant="secondary"
              onPress={() => setPicking(true)}
            />
            <MusicPicker
              visible={picking}
              onClose={() => setPicking(false)}
              onPick={(tr) => {
                setSong(tr);
                setPicking(false);
              }}
            />
          </>
        ) : null}
        <Field label={kind === 'text' ? t('stash.form.body') : t('stash.form.line')} value={body} maxLength={STASH_TEXT_MAX} onChangeText={setBody} multiline />
        <Field label={t('stash.form.title')} value={title} maxLength={STASH_TITLE_MAX} onChangeText={setTitle} />
        <Field label={t('stash.form.hint')} placeholder={t('stash.form.hintPlaceholder')} value={hint} maxLength={STASH_HINT_MAX} onChangeText={setHint} />

        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700' }}>
            {t('stash.form.who')}
          </Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {STASH_AUDIENCES.map((a) => choice(t(STASH_AUDIENCE_KEYS[a]), audience === a, () => setAudience(a), a))}
          </View>
          {audience === 'person' ? (
            <View accessibilityRole="radiogroup" accessibilityLabel={t('stash.form.person')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {people.map((p) => choice(p.displayName, recipient === p.id, () => setRecipient(p.id), p.id))}
            </View>
          ) : null}
          {audience === 'squad' ? (
            <View accessibilityRole="radiogroup" accessibilityLabel={t('stash.form.squad')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {squads.map((s) => choice(s.name, squadId === s.id, () => setSquadId(s.id), s.id))}
            </View>
          ) : null}
        </View>
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700' }}>
            {t('stash.form.howLong')}
          </Text>
          <Segmented
            options={STASH_DURATIONS.map((d) => ({ id: d, label: t(STASH_DURATION_KEYS[d]) }))}
            value={duration}
            onChange={setDuration}
            label={t('stash.form.howLong')}
          />
        </View>
        <SwitchRow label={t('stash.form.firstOnly')} value={firstOnly} onValueChange={setFirstOnly} />

        <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('stash.form.here')}</Text>
        {pos ? <Text style={{ color: c.inkMuted }}>{t('stash.form.accuracy', { n: pos.accuracy })}</Text> : null}
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        <Button
          label={busy ? t('location.locating') : t('stash.form.submit')}
          icon="locate-outline"
          disabled={!ready || busy || uploading}
          onPress={() => submit()}
        />
      </ScrollView>
    </KeyboardAvoid>
  );
}
