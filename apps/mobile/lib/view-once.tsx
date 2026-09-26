import { File, Paths } from 'expo-file-system';
import * as ScreenCapture from 'expo-screen-capture';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Message } from '../../../packages/shared/src/types';
import { client, errorMessage, getToken, mediaUrl } from './api';
import { useT } from './i18n';
import { space } from './theme';
import { Icon, userText } from './ui';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/**
 * A view-once photo or video in a chat bubble. Recipients tap to open it full screen;
 * when they close it, it's gone for them. The sender sees who opened it and whether a
 * screenshot was detected.
 */
export function ViewOnceBubble({ message, mine, tint, onChange }: { message: Message; mine: boolean; tint: string; onChange: (m: Message) => void }) {
  const { t } = useT();
  const info = message.viewOnce!;
  const video = info.kind === 'video';
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ file: File; kind: string } | null>(null);

  async function view() {
    setOpening(true);
    setError(null);
    try {
      const api = await client();
      const link = await api.viewOnce.open(message.id);
      const token = await getToken();
      const ext = EXT[link.mime ?? ''] ?? (link.kind === 'video' ? 'mp4' : 'jpg');
      // Downloaded to the app's cache with the short-lived link, shown, then deleted when closed.
      const file = await File.downloadFileAsync(mediaUrl(link.url), new File(Paths.cache, `view-once-${message.id}.${ext}`), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        idempotent: true,
      });
      setOpen({ file, kind: link.kind });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 410) onChange({ ...message, viewOnce: { ...info, state: 'viewed' } });
      setError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  }

  async function close() {
    const f = open?.file;
    setOpen(null);
    try {
      f?.delete();
    } catch {
      // Already gone.
    }
    try {
      const r = await (await client()).viewOnce.viewed(message.id);
      onChange({ ...message, viewOnce: r.viewOnce });
    } catch {
      onChange({ ...message, viewOnce: { ...info, state: 'viewed' } });
    }
  }

  const label =
    info.state === 'viewed'
      ? t(video ? 'm.viewOnce.videoViewed' : 'm.viewOnce.photoViewed')
      : info.state === 'expired'
        ? t(video ? 'm.viewOnce.videoExpired' : 'm.viewOnce.photoExpired')
        : mine
          ? t(video ? 'm.viewOnce.videoSent' : 'm.viewOnce.photoSent')
          : t(video ? 'm.viewOnce.tapVideo' : 'm.viewOnce.tapPhoto');
  const opened = info.openedBy ?? [];
  const names = opened.map((o) => o.user.displayName).join(', ');
  const shots = opened
    .filter((o) => o.screenshot)
    .map((o) => o.user.displayName)
    .join(', ');
  const canOpen = !mine && info.state === 'ready';

  return (
    <View style={{ gap: 2, minWidth: 180 }}>
      <Pressable
        accessibilityRole={canOpen ? 'button' : 'text'}
        disabled={!canOpen || opening}
        onPress={() => void view()}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingVertical: space[1] }}
      >
        {opening ? (
          <ActivityIndicator color={tint} />
        ) : (
          <Icon name={info.state === 'ready' ? (video ? 'videocam-outline' : 'eye-outline') : 'checkmark-circle-outline'} size={20} color={tint} />
        )}
        <Text style={{ color: tint, fontSize: 15, fontWeight: '700' }}>{opening ? t('m.viewOnce.opening') : label}</Text>
      </Pressable>
      {mine ? (
        <Text style={[{ color: tint, fontSize: 12, opacity: 0.85 }, userText]}>
          {names ? t('m.viewOnce.openedBy', { names }) : info.state === 'ready' ? t('m.viewOnce.notOpened') : ''}
          {shots ? `\n${t('m.viewOnce.screenshotBy', { names: shots })}` : ''}
        </Text>
      ) : null}
      {error ? <Text style={{ color: tint, fontSize: 12, opacity: 0.85 }}>{error}</Text> : null}
      {open ? <Viewer message={message} uri={open.file.uri} kind={open.kind} onClose={() => void close()} /> : null}
    </View>
  );
}

/**
 * Full screen, with screenshots and screen recording blocked where the phone allows it.
 * If a screenshot is still detected, the sender is told.
 */
function Viewer({ message, uri, kind, onClose }: { message: Message; uri: string; kind: string; onClose: () => void }) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [shot, setShot] = useState(false);

  useEffect(() => {
    const key = `view-once-${message.id}`;
    void ScreenCapture.preventScreenCaptureAsync(key).catch(() => {});
    const sub = ScreenCapture.addScreenshotListener(() => {
      setShot(true);
      void client().then((api) => api.viewOnce.screenshot(message.id).catch(() => {}));
    });
    return () => {
      sub.remove();
      void ScreenCapture.allowScreenCaptureAsync(key).catch(() => {});
    };
  }, [message.id]);

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: insets.top + space[2],
            paddingHorizontal: space[4],
            paddingBottom: space[2],
          }}
        >
          <Text numberOfLines={1} style={[{ color: '#fff', fontWeight: '700', fontSize: 15, flexShrink: 1 }, userText]}>
            {message.sender.displayName}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={12} onPress={onClose}>
            <Icon name="close" size={28} color="#fff" />
          </Pressable>
        </View>
        {kind === 'video' ? (
          <ViewOnceVideo uri={uri} />
        ) : (
          <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" accessibilityLabel={t('m.post.photo')} />
        )}
        <Text style={{ color: '#fff', opacity: 0.8, fontSize: 13, textAlign: 'center', padding: space[4], paddingBottom: insets.bottom + space[3] }}>
          {shot ? t('m.viewOnce.screenshotTold', { name: message.sender.displayName }) : t('m.viewOnce.note', { name: message.sender.displayName })}
        </Text>
      </View>
    </Modal>
  );
}

function ViewOnceVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls allowsPictureInPicture={false} />;
}
