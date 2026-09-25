'use client';

import { useMemo } from 'react';
import type {
  ChatComposerLabels,
  ConversationRowLabels,
  MessageBubbleLabels,
  MessageListLabels,
  CommentLabels,
  ComposerLabels,
  PostCardLabels,
  ProfileHeaderLabels,
  PollLabels,
  ComposerVisibility,
  ReactionType,
  VisibilityKind,
} from '@yapilapi/ui';
import { useI18n, type T } from '@/i18n';

const VIS: VisibilityKind[] = [
  'public',
  'followers',
  'friends',
  'circle',
  'selected',
  'private',
  'community',
];
const REACTIONS: ReactionType[] = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'];

export function localizeReason(reason: string, t: T): string {
  let m: RegExpMatchArray | null;
  if ((m = reason.match(/^@(\S+) is your friend$/))) return t('reason.friend', { username: m[1]! });
  if ((m = reason.match(/^You follow @(\S+)$/))) return t('reason.following', { username: m[1]! });
  if (reason === 'From a community you are in') return t('reason.community');
  if ((m = reason.match(/^Matches your interests: (.+)$/)))
    return t('reason.interests', { topics: m[1]! });
  if (reason === 'Popular right now') return t('reason.popular');
  if (reason === 'Near you') return t('reason.near');
  if (reason === 'You asked for less like this from this account') return t('reason.lessLikeThis');
  if (reason === 'Recent post from your network of interests' || reason === 'Recent')
    return t('reason.recent');
  if (/audience settings/i.test(reason)) return t('reason.audience');
  return reason;
}

export function pollLabels(t: T, locale: string): PollLabels {
  void locale;
  return {
    vote: t('poll.vote'),
    voting: t('poll.voting'),
    chooseOne: t('poll.chooseOne'),
    chooseMany: t('poll.chooseMany'),
    votesTotal: (n) => t('poll.votes', { count: n }),
    closesAt: (when) => t('poll.closesAt', { when }),
    closed: t('poll.closed'),
    yourVote: t('poll.yourVote'),
    pickAtLeastOne: t('poll.pickAtLeastOne'),
  };
}

export function usePostLabels(): PostCardLabels {
  const { t, locale } = useI18n();
  return useMemo<PostCardLabels>(
    () => ({
      like: t('post.like'),
      save: t('post.save'),
      comment: t('post.comments'),
      share: t('post.share'),
      shareOnlyPublic: t('post.shareOnlyPublic'),
      moreMenu: t('post.moreMenu'),
      reactionMenu: t('post.reactionMenu'),
      reactions: Object.fromEntries(
        REACTIONS.map((k) => [k, t(`reaction.${k}`)]),
      ) as PostCardLabels['reactions'],
      visibility: Object.fromEntries(
        VIS.map((k) => [k, t(`visibility.${k}`)]),
      ) as PostCardLabels['visibility'],
      edited: t('post.edited'),
      likesCount: (n) => t('post.likesCount', { count: n }),
      commentsCount: (n) => t('post.commentsCount', { count: n }),
      authorLink: (name) => t('post.authorLink', { name }),
      topics: t('post.topics'),
      moreLikeThis: t('feedback.moreLikeThis'),
      lessLikeThis: t('feedback.lessLikeThis'),
      notInterested: t('feedback.notInterested'),
      muteCreator: (username) => t('feedback.muteCreator', { username }),
      muteTopic: (topic) => t('feedback.muteTopic', { topic }),
      linkPreview: t('post.linkPreview'),
      loadMedia: t('post.loadMedia'),
      mediaHiddenLowBandwidth: t('post.mediaHiddenLowBandwidth'),
      poll: pollLabels(t, locale),
      reasons: {
        trigger: t('reasons.trigger'),
        title: t('reasons.title'),
        intro: t('reasons.intro'),
        loading: t('reasons.loading'),
        error: t('reasons.error'),
        retry: t('common.retry'),
        controlsTitle: t('reasons.controls'),
        moreLikeThis: t('feedback.moreLikeThis'),
        lessLikeThis: t('feedback.lessLikeThis'),
        notInterested: t('feedback.notInterested'),
        muteCreator: t('reasons.muteCreator'),
        done: t('common.done'),
        feedbackSent: t('reasons.feedbackSent'),
      },
    }),
    [t, locale],
  );
}

export function useCommentLabels(): CommentLabels {
  const { t } = useI18n();
  return useMemo<CommentLabels>(
    () => ({
      heading: t('comments.heading'),
      empty: t('comments.empty'),
      placeholder: t('comments.placeholder'),
      submit: t('comments.submit'),
      submitting: t('comments.submitting'),
      reply: t('comments.reply'),
      replyTo: (name) => t('comments.replyTo', { name }),
      cancel: t('common.cancel'),
      like: t('post.like'),
      likesCount: (n) => t('post.likesCount', { count: n }),
      delete: t('common.delete'),
      deleteAria: (name) => t('comments.deleteAria', { name }),
      showReplies: (n) => t('comments.showReplies', { count: n }),
      hideReplies: t('comments.hideReplies'),
      moreReplies: t('comments.moreReplies'),
      loadMore: t('common.loadMore'),
      loading: t('common.loading'),
      pending: t('comments.pending'),
      edited: t('post.edited'),
      commentLabel: t('comments.label'),
      tooLong: t('comments.tooLong'),
      repliesGroup: (name) => t('comments.repliesGroup', { name }),
    }),
    [t],
  );
}

export function useProfileLabels(): ProfileHeaderLabels {
  const { t } = useI18n();
  return useMemo<ProfileHeaderLabels>(
    () => ({
      privateAccount: t('profile.private'),
      joined: (date) => t('profile.joined', { date }),
      followers: (n) => t('profile.followers', { n }),
      following: (n) => t('profile.following', { n }),
      friends: (n) => t('profile.friends', { n }),
      modes: {
        creator: t('mode.creator'),
        professional: t('mode.professional'),
        business: t('mode.business'),
        personal: t('mode.personal'),
      },
      stats: t('profile.stats'),
      links: t('profile.links'),
      privateNotice: t('profile.privateNotice'),
      coverAlt: t('profile.coverAlt'),
    }),
    [t],
  );
}

export function useComposerLabels(): ComposerLabels {
  const { t } = useI18n();
  return useMemo<ComposerLabels>(() => {
    const vis = (v: ComposerVisibility) => ({
      label: t(`visibility.${v}`),
      description: t(`audience.${v}`),
    });
    return {
      bodyLabel: t('composer.body'),
      bodyPlaceholder: t('composer.bodyPlaceholder'),
      counter: (used, max) => t('composer.counter', { used, max }),
      audienceLegend: t('composer.audience'),
      audienceHelp: t('composer.audienceHelp'),
      visibility: {
        public: vis('public'),
        followers: vis('followers'),
        friends: vis('friends'),
        circle: vis('circle'),
        selected: vis('selected'),
        private: vis('private'),
      },
      teenNotice: t('composer.teenNotice'),
      teenPublicBlocked: t('composer.teenPublicBlocked'),
      circleLabel: t('composer.circle'),
      circleNone: t('composer.circleNone'),
      circleChoose: t('composer.circleChoose'),
      selectedLabel: t('composer.selected'),
      selectedHelp: t('composer.selectedHelp'),
      selectedAdd: t('common.add'),
      selectedNotFound: t('composer.selectedNotFound'),
      selectedRemove: (name) => t('composer.selectedRemove', { name }),
      selectedList: t('composer.selectedList'),
      selectedEmpty: t('composer.selectedEmpty'),
      topicsLegend: t('composer.topics'),
      topicsHelp: (max) => t('composer.topicsHelp', { max }),
      pollToggle: t('composer.pollToggle'),
      pollQuestion: t('composer.pollQuestion'),
      pollOption: (n) => t('composer.pollOption', { n }),
      pollAddOption: t('composer.pollAddOption'),
      pollRemoveOption: (n) => t('composer.pollRemoveOption', { n }),
      pollMultiple: t('composer.pollMultiple'),
      pollDuration: t('composer.pollDuration'),
      pollDurations: [
        { hours: null, label: t('composer.pollNoEnd') },
        { hours: 1, label: t('composer.pollHours', { count: 1 }) },
        { hours: 6, label: t('composer.pollHours', { count: 6 }) },
        { hours: 24, label: t('composer.pollDays', { count: 1 }) },
        { hours: 72, label: t('composer.pollDays', { count: 3 }) },
        { hours: 168, label: t('composer.pollDays', { count: 7 }) },
      ],
      linkLabel: t('composer.link'),
      linkHelp: t('composer.linkHelp'),
      locationToggle: t('composer.location'),
      locationHelp: t('composer.locationHelp'),
      locationTeenBlocked: t('composer.locationTeen'),
      locationDenied: t('composer.locationDenied'),
      locationReady: t('composer.locationReady'),
      submit: t('composer.submit'),
      submitting: t('composer.submitting'),
      optional: t('common.optional'),
      errors: {
        empty: t('composer.errEmpty'),
        pollQuestion: t('composer.errPollQuestion'),
        pollOptions: t('composer.errPollOptions'),
        circle: t('composer.errCircle'),
        audience: t('composer.errAudience'),
        link: t('composer.errLink'),
        tooLong: t('composer.errTooLong'),
        tooMuchMedia: t('composer.errTooMuchMedia', { max: 10 }),
      },
      media: {
        attach: t('composer.attachMedia'),
        uploading: t('composer.mediaUploading'),
        remove: (n) => t('composer.removeMedia', { n }),
        altTextLabel: t('composer.altTextLabel'),
        altTextPlaceholder: t('composer.altTextPlaceholder'),
        failed: t('composer.mediaFailed'),
        retry: t('composer.mediaRetry'),
      },
    };
  }, [t]);
}

export function useChatLabels(title: string): {
  bubble: MessageBubbleLabels;
  list: MessageListLabels;
  composer: ChatComposerLabels;
  row: ConversationRowLabels;
} {
  const { t } = useI18n();
  return useMemo(
    () => ({
      bubble: {
        you: t('inbox.you'),
        deleted: t('chat.deleted'),
        reply: t('chat.reply'),
        react: t('chat.react'),
        options: t('chat.options'),
        delete: t('chat.delete'),
        edited: t('chat.edited'),
        sending: t('chat.sending'),
        failed: t('chat.failed'),
        retry: t('chat.retry'),
        discard: t('chat.discard'),
        reactionCount: (reaction, n) => t('chat.reactionCount', { reaction, count: n }),
        reactions: {
          like: t('reaction.like'),
          love: t('reaction.love'),
          laugh: t('reaction.laugh'),
          wow: t('reaction.wow'),
          sad: t('reaction.sad'),
          insightful: t('reaction.insightful'),
        },
        replyingTo: (name) => t('chat.replyingTo', { name }),
        originalDeleted: t('chat.originalDeleted'),
        sentAt: (name, when) => t('chat.sentAt', { name, when }),
      },
      list: {
        log: t('chat.log', { title }),
        empty: t('chat.empty'),
        loadOlder: t('chat.loadOlder'),
        loadingOlder: t('chat.loadingOlder'),
        newMessages: t('chat.newMessages'),
        today: t('chat.today'),
        yesterday: t('chat.yesterday'),
      },
      composer: {
        label: t('chat.composerLabel'),
        placeholder: t('chat.composerPlaceholder'),
        send: t('chat.send'),
        hint: t('chat.hint'),
        replyingTo: (name) => t('chat.replyingTo', { name }),
        cancelReply: t('chat.cancelReply'),
        tooLong: t('chat.tooLong'),
      },
      row: {
        unread: (n) => t('inbox.unread', { count: n }),
        muted: t('inbox.muted'),
        pinned: t('inbox.pinned'),
        noMessages: t('inbox.noMessages'),
      },
    }),
    [t, title],
  );
}
