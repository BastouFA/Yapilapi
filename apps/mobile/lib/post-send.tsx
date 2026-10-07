import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { Conversation, Post } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { tr } from './locale';
import { useSession } from './session';
import { radius, space } from './theme';
import { Avatar, BottomSheet, Button, Field, Icon, Notice, useColors, userText } from './ui';

/**
 * "Send in a chat" for a post or a reel: pick one or more of your chats, add a note if you like,
 * and it goes there as a message with its link (api.posts.send). The server counts it as a share,
 * so nothing is recorded here. `open(post)` shows the picker and `{sheet}` goes somewhere in what
 * the component renders; `onSent` gets the line to show once it has gone.
 */
export function useSendPost(onSent: (note: string) => void) {
  const [post, setPost] = useState<Post | null>(null);
  const open = useCallback((p: Post) => setPost(p), []);
  const close = useCallback(() => setPost(null), []);
  const sheet = post ? (
    <SendSheet
      post={post}
      onClose={close}
      onSent={(note) => {
        close();
        onSent(note);
      }}
    />
  ) : null;
  return { open, sheet };
}

/** As many chats as one send takes (sendPostSchema). */
const MAX_CHATS = 20;

const chatName = (c: Conversation, meId: string | undefined) =>
  c.title ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(', ') ||
    tr('m.chat.justYou'));

function SendSheet({ post, onClose, onSent }: { post: Post; onClose: () => void; onSent: (note: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void client()
      .then((api) => api.conversations.list())
      .then(
        (r) => live && setChats(r.items.filter((ch) => ch.kind === 'direct' || ch.kind === 'group')),
        (e) => live && (setChats([]), setError(errorMessage(e))),
      );
    return () => {
      live = false;
    };
  }, []);

  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function send() {
    setError(null);
    try {
      const body = note.trim();
      const r = await (await client()).posts.send(post.id, { conversationIds: [...picked], ...(body ? { body } : {}) });
      // Nothing went (the chat is gone, they can't see the post): say why and stay open.
      if (!r.conversationIds.length && r.failed.length) {
        setError(r.failed[0]!.message);
        return;
      }
      onSent(t('post.send.sent'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <BottomSheet visible title={t('post.send.action')} subtitle={t('post.send.hint')} onClose={onClose} gap={space[2]}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {chats === null ? <ActivityIndicator accessibilityLabel={t('common.loading')} color={c.yapi} style={{ padding: space[4] }} /> : null}
      {chats && !chats.length && !error ? <Text style={{ color: c.inkMuted, lineHeight: 20, paddingVertical: space[2] }}>{t('post.send.empty')}</Text> : null}
      {chats?.map((chat) => {
        const name = chatName(chat, me?.id);
        const other = chat.kind === 'direct' ? chat.members.find((m) => m.id !== me?.id) : undefined;
        const on = picked.has(chat.id);
        const full = !on && picked.size >= MAX_CHATS;
        return (
          <Pressable
            key={chat.id}
            accessibilityRole="checkbox"
            accessibilityLabel={name}
            accessibilityState={{ checked: on, disabled: full }}
            disabled={full}
            onPress={() => toggle(chat.id)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[3],
              minHeight: 56,
              paddingHorizontal: space[2],
              borderRadius: radius.md,
              backgroundColor: pressed ? c.surfaceSunken : 'transparent',
              opacity: full ? 0.5 : 1,
            })}
          >
            <Avatar name={name} url={other?.avatarUrl} size={40} />
            <Text numberOfLines={1} style={[{ flex: 1, color: c.ink, fontSize: 15, fontWeight: '600' }, userText]}>
              {name}
            </Text>
            <Icon name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
          </Pressable>
        );
      })}
      {picked.size ? (
        <View style={{ gap: space[2], paddingTop: space[2] }}>
          <Field label={t('post.send.note')} hideLabel placeholder={t('post.send.note')} value={note} onChangeText={setNote} maxLength={1000} multiline />
          <Button label={t('m.stories.send')} icon="paper-plane-outline" onPress={send} />
        </View>
      ) : null}
    </BottomSheet>
  );
}
