import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { NotificationItem } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { useRealtime, useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, EmptyState, Loading, Notice, useColors, userText } from '../lib/ui';

/** What each kind of notification says; {name} is the person. Kinds not listed show a general line. */
const TEXT: Record<string, MessageKey> = {
  follow: 'm.notif.follow',
  friend_request: 'm.notif.friendRequest',
  friend_accepted: 'm.notif.friendAccepted',
  post_reaction: 'm.notif.like',
  post_comment: 'm.notif.comment',
  post_repost: 'm.notif.repost',
  post_mention: 'm.notif.postMention',
  comment_mention: 'm.notif.commentMention',
  collab_invite: 'm.notif.collabInvite',
  collab_accepted: 'm.notif.collabAccepted',
  photo_tag: 'm.notif.photoTag',
};

/** Kinds about your own account or content, with no one else in them. */
const OWN_TEXT: Record<string, MessageKey> = {
  scheduled_post_failed: 'm.notif.scheduledFailed',
  recap_ready: 'm.notif.recapReady',
  recap_failed: 'm.notif.recapFailed',
};

type Answer = 'accepted' | 'declined';

/** Notifications, newest first. A co-author or board invite can be accepted or declined right here. */
export default function Notifications() {
  const c = useColors();
  const { t, tp, timeAgo } = useT();
  const { me } = useSession();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (next?: string) => {
    try {
      const api = await client();
      const page = await api.notifications.list(next);
      setItems((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
      setCursor(page.nextCursor);
      // Seen now: the unread dots stay for this visit.
      if (!next && page.unread) void api.notifications.markRead().catch(() => {});
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);
  useRealtime((e) => {
    if (e.type === 'notification.created') void load();
  });

  async function answer(n: NotificationItem, accept: boolean) {
    if (!n.entityId) return;
    setBusy(n.id);
    setError(null);
    try {
      const api = await client();
      if (n.type === 'board_invite') await (accept ? api.boards.join(n.entityId) : api.boards.leave(n.entityId));
      else await (accept ? api.posts.acceptCollab(n.entityId) : api.posts.declineCollab(n.entityId));
      setAnswers((a) => ({ ...a, [n.id]: accept ? 'accepted' : 'declined' }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (me === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  if (!items) return <Loading />;

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[2], paddingBottom: space[8] }}
      data={items}
      keyExtractor={(n) => n.id}
      ListHeaderComponent={error ? <Notice tone="danger">{error}</Notice> : null}
      ListEmptyComponent={<EmptyState title={t('m.notif.empty')} />}
      onEndReached={() => cursor && void load(cursor)}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
      renderItem={({ item: n }) => {
        const name = n.actor?.displayName ?? '';
        const key = TEXT[n.type];
        const board = typeof n.data.name === 'string' ? n.data.name : '';
        const own = OWN_TEXT[n.type];
        const text = own
          ? t(own, { title: typeof n.data.title === 'string' ? n.data.title : '' })
          : n.type === 'board_invite' && n.actor
            ? t('m.notif.boardInvite', { name, board })
            : n.type === 'board_item_added' && n.actor
              ? tp('m.notif.boardItemAdded', Math.max(1, Number(n.data.count) || 1), { name, board })
              : key && n.actor
                ? t(key, { name })
                : n.actor
                  ? t('m.notif.other', { name })
                  : t('m.notif.otherNoActor');
        const href =
          n.entityType === 'post' && n.entityId
            ? `/p/${n.entityId}`
            : n.entityType === 'board' && n.entityId
              ? `/board/${n.entityId}`
              : n.entityType === 'draft'
                ? '/drafts'
                : n.entityType === 'recap' && n.entityId
                  ? `/recaps?open=${n.entityId}`
                  : n.actor
                    ? `/u/${n.actor.username}`
                    : null;
        const answered = answers[n.id];
        const boardInvite = n.type === 'board_invite';
        const invite = (n.type === 'collab_invite' || boardInvite) && !!n.entityId;
        return (
          <View style={{ backgroundColor: c.surface, borderRadius: radius.md, padding: space[3], gap: space[2] }}>
            <Pressable
              accessibilityRole={href ? 'link' : undefined}
              disabled={!href}
              onPress={() => href && router.push(href)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
            >
              {n.actor ? <Avatar name={n.actor.displayName} url={n.actor.avatarUrl} size={40} /> : null}
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 20, fontWeight: n.readAt ? '400' : '600' }, userText]}>{text}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{timeAgo(n.createdAt)}</Text>
              </View>
              {!n.readAt ? (
                <View accessible accessibilityLabel={t('m.notif.unread')} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.yapi }} />
              ) : null}
            </Pressable>
            {invite ? (
              answered ? (
                <Text style={{ color: c.inkMuted, fontSize: 13 }} accessibilityLiveRegion="polite">
                  {answered === 'accepted' ? (boardInvite ? t('m.boards.joined') : t('m.collab.acceptedNote')) : t('m.collab.declinedNote')}
                </Text>
              ) : (
                <View style={{ flexDirection: 'row', gap: space[2] }}>
                  <Button label={t('m.collab.accept')} size="sm" disabled={busy === n.id} onPress={() => void answer(n, true)} />
                  <Button label={t('m.collab.decline')} size="sm" variant="secondary" disabled={busy === n.id} onPress={() => void answer(n, false)} />
                </View>
              )
            ) : null}
          </View>
        );
      }}
    />
  );
}
