import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { patiently } from '../../../packages/api-client/src/index';
import { copyableMedia } from '../../../packages/shared/src/forwarding';
import type { Message } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import type { SheetAction } from './chat-extras';
import { useT } from './i18n';
import { uploadFile } from './media';
import { radius, space } from './theme';
import { Icon, useColors } from './ui';

/**
 * Copy and paste in a chat, the same in a normal chat and beside the video in Watch together.
 * Words and photos go through the phone's clipboard, so they also reach other apps. A voice message
 * or video can't, so the app keeps which message it was and pasting sends that message on.
 */

export type CopiedMedia = { messageId: string; kind: 'voice' | 'video'; durationMs: number | null; at: number };
/** How long something copied waits to be pasted. */
const COPIED_KEEP_MS = 30 * 60_000;
let copied: CopiedMedia | null = null;
const copiedListeners = new Set<(v: CopiedMedia | null) => void>();
function setCopied(v: CopiedMedia | null) {
  copied = v;
  copiedListeners.forEach((l) => l(v));
}
export const clearCopiedMedia = () => setCopied(null);
function useCopiedMedia(): CopiedMedia | null {
  const [v, setV] = useState(copied);
  useEffect(() => {
    copiedListeners.add(setV);
    setV(copied);
    return () => void copiedListeners.delete(setV);
  }, []);
  return v && Date.now() - v.at < COPIED_KEEP_MS ? v : null;
}

type T = ReturnType<typeof useT>['t'];

/** Clipboards take pictures as data, so the photo comes down first. */
async function copyPhoto(url: string, id: string) {
  const file = await File.downloadFileAsync(mediaUrl(url), new File(Paths.cache, `copy-${id}.img`), { idempotent: true });
  await Clipboard.setImageAsync(await file.base64());
}

/** The ways to copy a message, for its menu. Never a view-once one, which is meant to go. */
export function copyActions(m: Message, t: T, say: (text: string, failed?: boolean) => void): SheetAction[] {
  if (m.unsent || m.viewOnce) return [];
  const out: SheetAction[] = [];
  const words = (label: 'chat.copyText' | 'chat.copyWords', text: string) =>
    out.push({
      label: t(label),
      icon: 'copy-outline',
      onPress: () =>
        void Clipboard.setStringAsync(text).then(
          () => say(t('chat.copied')),
          () => say(t('common.copyFailed'), true),
        ),
    });
  if (m.body) words('chat.copyText', m.body);
  if (m.transcript?.text) words('chat.copyWords', m.transcript.text);
  const media = copyableMedia(m);
  if (media)
    out.push({
      label: t(media.kind === 'video' ? 'chat.copyVideo' : 'chat.copyVoice'),
      icon: 'copy-outline',
      onPress: () => {
        setCopied({ messageId: m.id, kind: media.kind, durationMs: media.durationMs, at: Date.now() });
        say(t(media.kind === 'video' ? 'chat.videoCopied' : 'chat.voiceCopied'));
      },
    });
  const photo = m.attachments?.find((a) => a.kind === 'image' && !a.removed && !a.sensitive);
  if (photo)
    out.push({
      label: t('chat.copyPhoto'),
      icon: 'copy-outline',
      onPress: () =>
        void copyPhoto(photo.url, m.id).then(
          () => say(t('chat.copied')),
          () => say(t('common.copyFailed'), true),
        ),
    });
  return out;
}

/** What's waiting to be pasted into this chat, and the ways to paste it. */
export function useChatPaste({
  conversationId,
  insertText,
  onSent,
  onError,
}: {
  conversationId: string;
  insertText: (text: string) => void;
  onSent: (sent: Message[]) => void;
  onError: (text: string) => void;
}) {
  const { t } = useT();
  const waiting = useCopiedMedia();
  const [pasting, setPasting] = useState(false);
  // A photo from the clipboard (as a data URI), waiting for a look and a tap: a paste can be the wrong thing.
  const [pasted, setPasted] = useState<string | null>(null);
  useEffect(() => setPasted(null), [conversationId]);

  /** Sends the copied voice message or video into this chat, the message itself. */
  async function pasteCopied() {
    if (!waiting || pasting) return;
    setPasting(true);
    try {
      const api = await client();
      const { messages: sent } = await patiently(() => api.messages.forward(waiting.messageId, [conversationId], `paste-${waiting.at}`));
      onSent(sent);
      clearCopiedMedia();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setPasting(false);
    }
  }

  async function sendPasted() {
    if (!pasted || pasting) return;
    setPasting(true);
    try {
      const name = `pasted-${Date.now()}.jpg`;
      const file = new File(Paths.cache, name);
      file.create({ overwrite: true });
      file.write(pasted.slice(pasted.indexOf(',') + 1), { encoding: 'base64' });
      const media = await uploadFile(file.uri, name, 'image/jpeg');
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { message } = await (await client()).conversations.send(conversationId, '', clientId, [{ mediaId: media.id }]);
      onSent([message]);
      setPasted(null);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setPasting(false);
    }
  }

  /** The Paste button: a message box's own Paste only takes words. */
  async function pasteFromClipboard() {
    try {
      const image = (await Clipboard.hasImageAsync()) ? await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.9 }) : null;
      if (image) return setPasted(image.data);
      const text = await Clipboard.getStringAsync();
      if (text) insertText(text);
      else if (waiting) await pasteCopied();
      else onError(t('chat.nothingToPaste'));
    } catch {
      onError(t('chat.pasteRefused'));
    }
  }

  return { waiting, pasting, pasted, pasteCopied, sendPasted, clearPasted: () => setPasted(null), pasteFromClipboard };
}

function Strip({ onPress, disabled, onCancel, children }: { onPress: () => void; disabled: boolean; onCancel: () => void; children: React.ReactNode }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], paddingHorizontal: space[2], paddingBottom: space[1] }}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          minHeight: 44,
          paddingHorizontal: space[3],
          borderRadius: 22,
          borderWidth: 1,
          borderColor: c.line,
          backgroundColor: c.surface,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {children}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.cancel')}
        onPress={onCancel}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="close" size={20} color={c.inkMuted} />
      </Pressable>
    </View>
  );
}

/** "Send what you pasted" and "Paste voice message" or "Paste video", just above the message box. */
export function PasteStrips({ paste }: { paste: ReturnType<typeof useChatPaste> }) {
  const c = useColors();
  const { t } = useT();
  const label = { color: c.ink, fontWeight: '600', fontSize: 14 } as const;
  return (
    <>
      {paste.pasted ? (
        <Strip disabled={paste.pasting} onPress={() => void paste.sendPasted()} onCancel={paste.clearPasted}>
          <Image source={{ uri: paste.pasted }} style={{ width: 32, height: 32, borderRadius: radius.sm }} accessibilityIgnoresInvertColors />
          <Text style={label}>{t('chat.sendPasted')}</Text>
        </Strip>
      ) : null}
      {paste.waiting ? (
        <Strip disabled={paste.pasting} onPress={() => void paste.pasteCopied()} onCancel={clearCopiedMedia}>
          <Icon name={paste.waiting.kind === 'video' ? 'play-outline' : 'mic-outline'} size={18} color={c.ink} />
          <Text style={label}>{t(paste.waiting.kind === 'video' ? 'chat.pasteVideo' : 'chat.pasteVoice')}</Text>
        </Strip>
      ) : null}
    </>
  );
}
