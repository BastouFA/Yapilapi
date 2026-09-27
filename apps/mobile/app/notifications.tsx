import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { NotificationItem, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { SectionHeader } from '../lib/chips';
import { useT, type Translator } from '../lib/i18n';
import { notificationHref } from '../lib/links';
import { useRealtime, useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, EmptyState, ErrorState, Notice, SkeletonList, useColors, userText } from '../lib/ui';

/** What each kind of notification says; {name} is the person (or the people, for grouped ones). */
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
  room_live: 'm.notif.roomLive',
  reel_duet: 'm.notif.reelDuet',
  reel_remix: 'm.notif.reelRemix',
  story_mention: 'm.notif.storyMention',
  story_reshare: 'm.notif.storyReshare',
  join_request: 'm.notif.joinRequest',
  join_approved: 'm.notif.joinApproved',
  event_rsvp: 'm.notif.eventRsvp',
  event_cancelled: 'm.notif.eventCancelled',
  event_updated: 'm.notif.eventUpdated',
  order_paid: 'm.notif.orderPaid',
  tip_received: 'm.notif.tip',
  subscription_started: 'm.notif.subscribed',
  invite_joined: 'm.notif.inviteJoined',
  live_started: 'm.notif.liveStarted',
  booking_request: 'm.notif.bookingRequest',
  call_incoming: 'm.notif.called',
  together_invite: 'm.notif.togetherInvite',
  family_invite: 'm.notif.familyInvite',
  family_accepted: 'm.notif.familyAccepted',
  family_ended: 'm.notif.familyEnded',
  family_controls_changed: 'm.notif.familyChanged',
  yap_received: 'm.notif.yap',
  view_once_screenshot: 'm.notif.viewOnceScreenshot',
  chapter_invite: 'm.notif.chapterInvite',
  watch_invite: 'watch.invite',
};

/** Several people doing the same thing to the same post (or following you), in one row. */
const GROUP_TEXT: Record<string, MessageKey> = {
  follow: 'm.notif.group.follow',
  post_reaction: 'm.notif.group.like',
  post_comment: 'm.notif.group.comment',
  post_repost: 'm.notif.group.repost',
};

/** Kinds about your own account or content, said the same way whoever caused them. {title} is the thing's name. */
const OWN_TEXT: Record<string, MessageKey> = {
  scheduled_post_failed: 'm.notif.scheduledFailed',
  scheduled_message_failed: 'm.notif.scheduledMessageFailed',
  recap_ready: 'm.notif.recapReady',
  recap_failed: 'm.notif.recapFailed',
  chat_reminder: 'm.notif.chatReminder',
  story_countdown: 'm.notif.countdownEnded',
  booking_decided: 'm.notif.bookingDecided',
  enforcement: 'm.notif.enforcement',
  ad_approved: 'm.notif.adApproved',
  ad_rejected: 'm.notif.adRejected',
  mfa_enabled: 'm.notif.mfaOn',
  mfa_disabled: 'm.notif.mfaOff',
  mfa_recovery_code_used: 'm.notif.recoveryCodeUsed',
  passkey_added: 'm.notif.passkeyAdded',
  media_blocked: 'm.notif.mediaBlocked',
  media_restored: 'm.notif.mediaRestored',
  account_limited: 'm.notif.accountLimited',
  chapter_opened: 'm.notif.capsuleOpened',
  weekly_wrap: 'wrap.notif',
};

type Group = { key: string; items: NotificationItem[]; actors: PublicUser[] };
type Section = { title: string; data: Group[] };
type Answer = 'accepted' | 'declined';

function actorsOf(items: NotificationItem[]): PublicUser[] {
  return [...new Map(items.filter((n) => n.actor).map((n) => [n.actor!.id, n.actor!])).values()];
}

/** Newest first, in Today / This week / Earlier, with likes, comments, reposts and follows on the same thing collapsed. */
function arrange(items: NotificationItem[], t: Translator['t']): Section[] {
  const sections: Section[] = [];
  const now = Date.now();
  for (const n of items) {
    const age = now - new Date(n.createdAt).getTime();
    const title = age < 86_400_000 ? t('m.notif.today') : age < 7 * 86_400_000 ? t('m.notif.thisWeek') : t('m.notif.earlier');
    let section = sections.at(-1);
    if (!section || section.title !== title) sections.push((section = { title, data: [] }));
    const key = GROUP_TEXT[n.type] ? `${n.type}:${n.entityId ?? ''}` : n.id;
    const existing = section.data.find((g) => g.key === key);
    if (existing) existing.items.push(n);
    else section.data.push({ key, items: [n], actors: [] });
  }
  for (const s of sections) for (const g of s.data) g.actors = actorsOf(g.items);
  return sections;
}

/** "Ada", "Ada and Ben", "Ada, Ben and 3 others". */
function names(actors: PublicUser[], { t, tp }: Translator): string {
  const [a, b] = actors;
  if (!a) return '';
  if (!b) return a.displayName;
  if (actors.length === 2) return t('m.notif.names.two', { first: a.displayName, second: b.displayName });
  return tp('m.notif.names.many', actors.length - 2, { first: a.displayName, second: b.displayName });
}

function describe(g: Group, tr: Translator): string {
  const { t, tp } = tr;
  const n = g.items[0]!;
  const name = n.actor?.displayName ?? '';
  const title = typeof n.data.title === 'string' ? n.data.title : typeof n.data.name === 'string' ? n.data.name : '';
  if (g.actors.length > 1 && GROUP_TEXT[n.type]) return t(GROUP_TEXT[n.type]!, { names: names(g.actors, tr) });
  // Likes on a comment and replies to it arrive batched: the newest person, and how many in all.
  const others = Math.max(0, Number(n.data.count ?? 1) - 1);
  if (n.type === 'comment_like' && n.actor) return others ? tp('comments.notif.likeOthers', others, { name }) : t('comments.notif.like', { name });
  if (n.type === 'comment_reply' && n.actor) return others ? tp('comments.notif.replyOthers', others, { name }) : t('comments.notif.reply', { name });
  if (n.type === 'board_invite' && n.actor) return t('m.notif.boardInvite', { name, board: title });
  if (n.type === 'board_item_added' && n.actor) return tp('m.notif.boardItemAdded', Math.max(1, Number(n.data.count) || 1), { name, board: title });
  if (n.type === 'plus_referral_reward') return tp('m.notif.plusReward', Number(n.data.days ?? 30));
  if (n.type === 'account_review') return n.data.outcome === 'cleared' ? t('m.notif.reviewCleared') : t('m.notif.reviewLimited');
  // A question asked without a name has no actor: it never says who.
  if (n.type === 'question_received') return n.actor ? t('ask.notif.received', { name }) : t('ask.notif.receivedHidden');
  if (n.type === 'question_answered') return t('ask.notif.answered', { name });
  // A sign-in from a device we hadn't seen: which one, and roughly where when known.
  if (n.type === 'new_sign_in') {
    const device = String(n.data.device ?? '');
    return typeof n.data.place === 'string' && n.data.place ? t('m.notif.newSignInPlace', { device, place: n.data.place }) : t('m.notif.newSignIn', { device });
  }
  const own = OWN_TEXT[n.type];
  if (own) return t(own, { title });
  const key = TEXT[n.type];
  if (key && n.actor) return t(key, { name, title });
  return n.actor ? t('m.notif.other', { name }) : t('m.notif.otherNoActor');
}

/**
 * Notifications, newest first, in Today / This week / Earlier. Likes, comments, reposts and
 * follows on the same thing collapse into one row ("Ada and 3 others liked your post"). A new
 * follower can be followed back, and co-author and board invites answered, right here. Each row
 * opens what it is about.
 */
export default function Notifications() {
  const c = useColors();
  const tr = useT();
  const { t, timeAgo } = tr;
  const { me } = useSession();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [followed, setFollowed] = useState<Set<string>>(new Set());
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

  const sections = useMemo(() => (items ? arrange(items, t) : []), [items, t]);

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

  async function followBack(user: PublicUser) {
    setFollowed((f) => new Set(f).add(user.id));
    setError(null);
    try {
      await (await client()).users.follow(user.id);
    } catch (e) {
      setFollowed((f) => {
        const next = new Set(f);
        next.delete(user.id);
        return next;
      });
      setError(errorMessage(e));
    }
  }

  if (me === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  if (!items)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <SkeletonList />
      </View>
    );

  return (
    <SectionList
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], paddingBottom: space[8] }}
      sections={sections}
      keyExtractor={(g) => g.key}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={error ? <ErrorState message={error} onRetry={() => load()} /> : null}
      ListEmptyComponent={<EmptyState title={t('m.notif.caughtUp')} body={t('m.notif.caughtUpBody')} />}
      renderSectionHeader={({ section }) => (
        <View style={{ paddingTop: space[3], paddingBottom: space[2], backgroundColor: c.ground }}>
          <SectionHeader title={section.title} />
        </View>
      )}
      ItemSeparatorComponent={() => <View style={{ height: space[2] }} />}
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
      renderItem={({ item: g }) => {
        const n = g.items[0]!;
        const unread = g.items.some((x) => !x.readAt);
        const text = describe(g, tr);
        const href = notificationHref(n);
        const answered = answers[n.id];
        const boardInvite = n.type === 'board_invite';
        const invite = (n.type === 'collab_invite' || boardInvite) && !!n.entityId;
        const single = g.actors.length === 1 ? g.actors[0]! : null;
        const canFollowBack = n.type === 'follow' && !!single && !n.followsActor;
        const nowFollowing = !!single && followed.has(single.id);
        return (
          <View style={{ backgroundColor: c.surface, borderRadius: radius.md, padding: space[3], gap: space[2] }}>
            <Pressable
              accessibilityRole={href ? 'link' : undefined}
              accessibilityLabel={`${text}. ${timeAgo(n.createdAt)}${unread ? `. ${t('m.notif.unread')}` : ''}`}
              disabled={!href}
              onPress={() => href && router.push(href as never)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
            >
              <Faces actors={g.actors} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 20, fontWeight: unread ? '600' : '400' }, userText]}>{text}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{timeAgo(n.createdAt)}</Text>
              </View>
              {unread ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.yapi }} /> : null}
            </Pressable>
            {canFollowBack && single ? (
              <View style={{ flexDirection: 'row' }}>
                {nowFollowing ? (
                  <Text style={{ color: c.inkMuted, fontSize: 13 }} accessibilityLiveRegion="polite">
                    {t('m.notif.nowFollowing', { name: single.displayName })}
                  </Text>
                ) : (
                  <Button label={t('m.notif.followBack')} size="sm" onPress={() => followBack(single)} />
                )}
              </View>
            ) : null}
            {invite ? (
              answered ? (
                <Text style={{ color: c.inkMuted, fontSize: 13 }} accessibilityLiveRegion="polite">
                  {answered === 'accepted' ? (boardInvite ? t('m.boards.joined') : t('m.collab.acceptedNote')) : t('m.collab.declinedNote')}
                </Text>
              ) : (
                <View style={{ flexDirection: 'row', gap: space[2] }}>
                  <Button label={t('m.collab.accept')} size="sm" disabled={busy === n.id} onPress={() => answer(n, true)} />
                  <Button label={t('m.collab.decline')} size="sm" variant="secondary" disabled={busy === n.id} onPress={() => answer(n, false)} />
                </View>
              )
            ) : null}
          </View>
        );
      }}
    />
  );
}

/** One face, or up to three overlapping for a grouped row. */
function Faces({ actors }: { actors: PublicUser[] }) {
  const c = useColors();
  if (!actors.length) return null;
  if (actors.length === 1) return <Avatar name={actors[0]!.displayName} url={actors[0]!.avatarUrl} size={40} />;
  const shown = actors.slice(0, 3);
  return (
    <View style={{ width: 40 + (shown.length - 1) * 14, height: 40, flexDirection: 'row' }}>
      {shown.map((a, i) => (
        <View
          key={a.id}
          style={{
            position: 'absolute',
            start: i * 14,
            top: i % 2 ? 6 : 0,
            borderRadius: 20,
            borderWidth: 2,
            borderColor: c.surface,
            zIndex: shown.length - i,
          }}
        >
          <Avatar name={a.displayName} url={a.avatarUrl} size={30} />
        </View>
      ))}
    </View>
  );
}
