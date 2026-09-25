import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import type { Visibility } from '@yapilapi/api-client';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { usePrefs } from '../prefs';
import { useOutbox } from '../offline/OutboxProvider';
import { usePreferences } from '../data/settings';
import type { DraftMedia } from '../offline/outbox';
import { AppText, Button, Chip, ConfirmDialog, Icon, Screen, TextField } from '../ui';

const MAX_MEDIA = 4;
const MAX_CHARS = 10_000;
const AUDIENCES: Array<'public' | 'followers' | 'friends' | 'private'> = [
  'public',
  'followers',
  'friends',
  'private',
];

export function assetToDraft(a: ImagePicker.ImagePickerAsset, i: number): DraftMedia {
  const isVideo = a.type === 'video';
  const ext = isVideo ? 'mp4' : 'jpg';
  return {
    uri: a.uri,
    name: a.fileName ?? `upload-${Date.now()}-${i}.${ext}`,
    mimeType: a.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
    size: a.fileSize,
    width: a.width,
    height: a.height,
  };
}

export default function Compose() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const { communityId, communityName } = useLocalSearchParams<{
    communityId?: string;
    communityName?: string;
  }>();
  const { lowBandwidth } = usePrefs();
  const { enqueuePost } = useOutbox();
  const prefs = usePreferences();
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<(typeof AUDIENCES)[number] | null>(null);
  const [media, setMedia] = useState<DraftMedia[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const sent = useRef(false);

  const effective = audience ?? prefs.data?.defaultPostVisibility ?? 'public';
  const hasContent = body.trim().length > 0 || media.length > 0;
  const hasContentRef = useRef(hasContent);
  hasContentRef.current = hasContent;

  const pick = async () => {
    setError(null);
    if (media.length >= MAX_MEDIA) {
      setError(t('compose.mediaLimit', { max: MAX_MEDIA }));
      return;
    }
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_MEDIA - media.length,
        quality: lowBandwidth ? 0.6 : 0.85,
        exif: false,
      });
      if (res.canceled) return;
      setMedia((m) =>
        [...m, ...res.assets.map((a, i) => assetToDraft(a, m.length + i))].slice(0, MAX_MEDIA),
      );
    } catch {
      setError(t('compose.permissionDenied'));
    }
  };

  const post = async () => {
    const text = body.trim();
    if (!text && media.length === 0) {
      setError(t('compose.empty'));
      return;
    }
    if (text.length > MAX_CHARS) {
      setError(t('compose.tooLong', { max: MAX_CHARS }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const visibility: Visibility = communityId ? 'community' : effective;
      // Goes through the outbox: saved on the device first, sent now, retried with backoff if the network is bad.
      await enqueuePost({ body: text, visibility, ...(communityId ? { communityId } : {}), media });
      sent.current = true;
      setInfo(t('compose.queued'));
      router.back();
    } catch {
      setError(t('error.generic'));
      setBusy(false);
    }
  };

  const leave = () => {
    if (hasContent) setConfirmLeave(true);
    else router.back();
  };
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e) => {
      if (sent.current || !hasContentRef.current) return;
      e.preventDefault();
      setConfirmLeave(true);
    });
    return sub;
  }, [navigation]);

  return (
    <Screen scroll>
      {communityId ? (
        <AppText variant="label" tone="primary" style={{ marginBottom: th.space[2] }}>
          {t('compose.inCommunity', { name: communityName ?? '' })}
        </AppText>
      ) : null}
      <TextField
        label={t('compose.bodyLabel')}
        placeholder={t('compose.placeholder')}
        value={body}
        onChangeText={setBody}
        multiline
        multilineHeight={160}
        maxLength={MAX_CHARS}
        autoFocus
      />
      <AppText
        variant="caption"
        tone="subtle"
        style={{ marginTop: -th.space[2], marginBottom: th.space[3] }}
        accessibilityLiveRegion="polite"
      >
        {t('compose.charsLeft', { count: MAX_CHARS - body.length })}
      </AppText>

      {media.map((m, i) => (
        <View key={m.uri} style={{ marginBottom: th.space[3], gap: th.space[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space[3] }}>
            {m.mimeType.startsWith('image/') ? (
              <Image
                source={{ uri: m.uri }}
                style={{ width: 72, height: 72, borderRadius: th.radius.sm }}
                accessibilityLabel={m.altText ?? t('post.image')}
              />
            ) : (
              <View
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: th.radius.sm,
                  backgroundColor: th.colors.surfaceSunken,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="play" color={th.colors.textMuted} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              {m.mimeType.startsWith('image/') ? (
                <TextField
                  label={t('compose.altText')}
                  hint={t('compose.altHint')}
                  value={m.altText ?? ''}
                  onChangeText={(v) =>
                    setMedia((all) => all.map((x, j) => (j === i ? { ...x, altText: v } : x)))
                  }
                  maxLength={500}
                />
              ) : (
                <AppText variant="caption" tone="muted">
                  {m.name}
                </AppText>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('compose.removeMedia', { n: i + 1 })}
              onPress={() => setMedia((all) => all.filter((_, j) => j !== i))}
              style={{
                minWidth: th.targetMin,
                minHeight: th.targetMin,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="close" color={th.colors.textMuted} />
            </Pressable>
          </View>
        </View>
      ))}
      <Button
        label={t('compose.addPhoto')}
        icon="image"
        variant="secondary"
        onPress={() => void pick()}
        disabled={media.length >= MAX_MEDIA}
      />
      {lowBandwidth && media.length ? (
        <AppText variant="caption" tone="subtle" style={{ marginTop: th.space[2] }}>
          {t('compose.lowBandwidthNote')}
        </AppText>
      ) : null}

      {!communityId ? (
        <View style={{ marginTop: th.space[5] }}>
          <AppText variant="label" tone="muted" style={{ marginBottom: th.space[2] }} header>
            {t('compose.audience')}
          </AppText>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t('compose.audience')}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space[2] }}
          >
            {AUDIENCES.map((a) => (
              <Chip
                key={a}
                label={t(`compose.audience.${a}`)}
                selected={effective === a}
                onPress={() => setAudience(a)}
              />
            ))}
          </View>
        </View>
      ) : (
        <AppText variant="caption" tone="muted" style={{ marginTop: th.space[4] }}>
          {t('compose.communityNotice')}
        </AppText>
      )}

      {error ? (
        <AppText
          variant="body"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginTop: th.space[4] }}
        >
          {error}
        </AppText>
      ) : null}
      {info ? (
        <AppText
          variant="body"
          tone="success"
          accessibilityLiveRegion="polite"
          style={{ marginTop: th.space[4] }}
        >
          {info}
        </AppText>
      ) : null}
      <View style={{ flexDirection: 'row', gap: th.space[3], marginTop: th.space[6] }}>
        <Button label={t('common.cancel')} variant="secondary" onPress={leave} />
        <Button
          label={busy ? t('compose.posting') : t('compose.post')}
          style={{ flex: 1 }}
          loading={busy}
          onPress={() => void post()}
        />
      </View>
      <ConfirmDialog
        visible={confirmLeave}
        title={t('compose.discard')}
        body={t('compose.discardBody')}
        confirmLabel={t('common.delete')}
        destructive
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          sent.current = true;
          setConfirmLeave(false);
          router.back();
        }}
      />
    </Screen>
  );
}
