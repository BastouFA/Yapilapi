import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { noticeText } from '../../../packages/shared/src/server-text';
import { client, errorMessage } from '../lib/api';
import { uploadFile } from '../lib/media';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { Button, Field, KeyboardAvoid, Screen, useColors } from '../lib/ui';

/** Upload a just-taken photo the way every other upload goes (with its failure messages). */
const upload = async (uri: string) => (await uploadFile(uri, 'real.jpg', 'image/jpeg')).id;

/**
 * Real: take a photo with the back camera, then the front one, and share both. Only Real keeps
 * to the camera: Together albums (app/together) take photos and videos from the library too.
 */
export default function Real() {
  const c = useColors();
  const { t } = useT();
  const [permission, requestPermission] = useCameraPermissions();
  // The camera is off while another screen is on top (after sharing, or a notification tapped).
  const focused = useIsFocused();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [shots, setShots] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  // While it uploads, neither button can share it a second time.
  const [sharing, setSharing] = useState(false);
  // How many more can be shared now (three in 24 hours); at none, say so before any photo is taken.
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!focused) return;
    client()
      .then((a) => a.real.feed())
      .then(
        (r) => setRemaining(r.remaining ?? null),
        () => {},
      );
  }, [focused]);

  if (!permission) return <Screen>{null}</Screen>;
  if (!permission.granted)
    return (
      <Screen>
        <Text style={{ color: c.ink }}>{t('m.real.permission')}</Text>
        <Button label={t('m.real.allowCamera')} onPress={requestPermission} />
      </Screen>
    );

  async function share(uris: string[]) {
    if (sharing) return;
    setSharing(true);
    setStatus(t('m.real.sharing'));
    try {
      const ids = [];
      for (const u of uris) ids.push(await upload(u));
      const r = await (await client()).real.create({ mediaIds: ids, caption });
      setShots([]);
      setCaption('');
      setStatus(null);
      // Held for review: say so before leaving.
      if (r.moderation) Alert.alert(noticeText(r.moderation, t) ?? r.moderation.message);
      router.navigate('/');
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setSharing(false);
    }
  }

  return (
    // The caption sits under the camera: the keyboard pushes it (and the buttons) up rather than covering them.
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <CameraView ref={camera} active={focused} style={{ flex: 1 }} facing={facing} />
      <View style={{ padding: space[4], gap: space[2] }}>
        {status ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.ink }}>
            {status}
          </Text>
        ) : null}
        {remaining === 0 ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, lineHeight: 20 }}>
            {t('real.noneLeft')}
          </Text>
        ) : null}
        <Field label={t('m.real.caption')} value={caption} onChangeText={setCaption} maxLength={300} />
        <Button
          label={shots.length === 0 ? t('m.real.captureFirst') : t('m.real.captureFront')}
          disabled={sharing || remaining === 0}
          onPress={async () => {
            // The camera can refuse (not ready yet, or taken by another app): say so instead of failing silently.
            const photo = await camera.current?.takePictureAsync({ quality: 0.85, exif: false }).catch(() => {
              setStatus(t('m.camera.photoFailed'));
              return null;
            });
            if (!photo) return;
            const next = [...shots, photo.uri];
            if (next.length === 1) {
              setShots(next);
              setFacing(facing === 'back' ? 'front' : 'back');
            } else await share(next);
          }}
        />
        {shots.length === 1 ? <Button label={t('m.real.shareOne')} variant="secondary" disabled={sharing} onPress={() => share(shots)} /> : null}
      </View>
    </KeyboardAvoid>
  );
}
