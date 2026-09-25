import React, { useState } from 'react';
import { View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useAuth, useMe } from '../auth/AuthProvider';
import { useUpdateProfile, useProfile } from '../data/social';
import { uploadMedia } from '../media/upload';
import { errorMessage } from '../lib/errors';
import { usePrefs } from '../prefs';
import {
  AppText,
  Avatar,
  Button,
  ErrorView,
  LoadingView,
  Screen,
  SwitchRow,
  TextField,
} from '../ui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function EditProfile() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const api = useApi();
  const me = useMe();
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const { lowBandwidth } = usePrefs();
  const profile = useProfile(me.profile.username);
  const update = useUpdateProfile();
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [bio, setBio] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  if (profile.isPending)
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  if (profile.isError)
    return (
      <Screen>
        <ErrorView error={profile.error} onRetry={() => void profile.refetch()} />
      </Screen>
    );
  const p = profile.data;
  const teen = me.ageBand === 'teen';

  const save = () => {
    setError(null);
    setInfo(null);
    const name = (displayName ?? p.displayName).trim();
    if (!name) {
      setError(t('signup.profile.nameRequired'));
      return;
    }
    update.mutate(
      {
        displayName: name,
        bio: (bio ?? p.bio).trim(),
        locationText: (location ?? p.locationText ?? '').trim() || null,
        ...(isPrivate !== null && !teen ? { isPrivate } : {}),
      },
      {
        onSuccess: () => {
          setInfo(t('profile.saved'));
          router.back();
        },
        onError: (e) => setError(errorMessage(e, t)),
      },
    );
  };

  const changePhoto = async () => {
    setError(null);
    setInfo(null);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: lowBandwidth ? 0.6 : 0.8,
        exif: false,
      });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      setPhotoBusy(true);
      // Public purpose: an avatar is visible to everyone.
      const m = await uploadMedia(
        api,
        {
          uri: a.uri,
          name: a.fileName ?? 'avatar.jpg',
          mimeType: a.mimeType ?? 'image/jpeg',
          size: a.fileSize,
        },
        { lowBandwidth, purpose: 'public' },
      );
      // The server resizes the image before it can be used; wait for it (a few seconds at most).
      let media = m;
      for (let i = 0; i < 10 && media.status !== 'ready'; i++) {
        await sleep(1000);
        media = await api.media.get(m.id);
      }
      await api.media.setAvatar(media.id);
      await refresh();
      void qc.invalidateQueries({ queryKey: ['profile'] });
      setInfo(t('profile.photoUpdated'));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <Screen scroll>
      <View style={{ alignItems: 'center', gap: th.space[3], marginBottom: th.space[5] }}>
        <Avatar name={p.displayName} uri={p.avatarUrl} size={88} />
        <Button
          label={t('profile.changePhoto')}
          variant="secondary"
          compact
          loading={photoBusy}
          onPress={() => void changePhoto()}
        />
      </View>
      <TextField
        label={t('profile.displayName')}
        value={displayName ?? p.displayName}
        onChangeText={setDisplayName}
        maxLength={60}
        required
      />
      <TextField
        label={t('profile.bio')}
        hint={t('profile.bioHint')}
        value={bio ?? p.bio}
        onChangeText={setBio}
        maxLength={300}
        multiline
        multilineHeight={96}
      />
      <TextField
        label={t('profile.location')}
        value={location ?? p.locationText ?? ''}
        onChangeText={setLocation}
        maxLength={80}
      />
      <SwitchRow
        label={t('profile.privateAccount')}
        hint={teen ? t('privacy.teenLocked') : t('profile.privateAccountHint')}
        value={isPrivate ?? p.isPrivate}
        disabled={teen}
        onChange={setIsPrivate}
      />
      {error ? (
        <AppText
          variant="body"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: th.space[3] }}
        >
          {error}
        </AppText>
      ) : null}
      {info ? (
        <AppText
          variant="body"
          tone="success"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: th.space[3] }}
        >
          {info}
        </AppText>
      ) : null}
      <Button
        label={t('common.save')}
        block
        loading={update.isPending && !photoBusy}
        onPress={save}
      />
    </Screen>
  );
}
