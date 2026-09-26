import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { client } from '../lib/api';
import { tr } from '../lib/locale';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { Button, Field, Screen, useColors } from '../lib/ui';

const baseUrl = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:4000';

/** Upload a just-taken photo with the same multipart endpoint the web app uses. */
async function upload(uri: string): Promise<string> {
  const token = await SecureStore.getItemAsync('ypl_session');
  const form = new FormData();
  form.append('file', { uri, name: 'real.jpg', type: 'image/jpeg' } as unknown as Blob);
  const res = await fetch(`${baseUrl}/v1/media`, { method: 'POST', body: form, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? tr('m.real.uploadFailed'));
  return json.media.id;
}

/** Real: take a photo with the back camera, then the front one, and share both. */
export default function Real() {
  const c = useColors();
  const { t } = useT();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [shots, setShots] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  if (!permission) return <Screen>{null}</Screen>;
  if (!permission.granted)
    return (
      <Screen>
        <Text style={{ color: c.ink }}>{t('m.real.permission')}</Text>
        <Button label={t('m.real.allowCamera')} onPress={requestPermission} />
      </Screen>
    );

  async function share(uris: string[]) {
    setStatus(t('m.real.sharing'));
    try {
      const ids = [];
      for (const u of uris) ids.push(await upload(u));
      await (await client()).real.create({ mediaIds: ids, caption });
      setShots([]);
      setCaption('');
      setStatus(null);
      router.navigate('/');
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <CameraView ref={camera} style={{ flex: 1 }} facing={facing} />
      <View style={{ padding: space[4], gap: space[2] }}>
        {status ? <Text style={{ color: c.ink }}>{status}</Text> : null}
        <Field label={t('m.real.caption')} value={caption} onChangeText={setCaption} maxLength={300} />
        <Button
          label={shots.length === 0 ? t('m.real.captureFirst') : t('m.real.captureFront')}
          onPress={async () => {
            const photo = await camera.current?.takePictureAsync({ quality: 0.85, exif: false });
            if (!photo) return;
            const next = [...shots, photo.uri];
            if (next.length === 1) {
              setShots(next);
              setFacing(facing === 'back' ? 'front' : 'back');
            } else void share(next);
          }}
        />
        {shots.length === 1 ? <Button label={t('m.real.shareOne')} variant="secondary" onPress={() => share(shots)} /> : null}
      </View>
    </View>
  );
}
