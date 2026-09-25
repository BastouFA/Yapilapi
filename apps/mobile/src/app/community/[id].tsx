import React, { useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ApiError, type Community } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { usePrefs } from '../../prefs';
import { errorMessage } from '../../lib/errors';
import {
  useAnswerInvitation,
  useCommunity,
  useCommunityFeed,
  useJoinCommunity,
} from '../../data/social';
import { PostCard } from '../../features/PostCard';
import {
  AppText,
  Avatar,
  Button,
  ConfirmDialog,
  EmptyView,
  ErrorView,
  LoadingView,
  PagedList,
  Screen,
} from '../../ui';

function Header({ c, idOrSlug }: { c: Community; idOrSlug: string }) {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const join = useJoinCommunity(idOrSlug);
  const answer = useAnswerInvitation();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = c.viewer?.status;
  const member = st === 'active';
  const fail = (e: unknown) =>
    setError(
      e instanceof ApiError && e.status === 403
        ? t('communities.actionFailed')
        : errorMessage(e, t),
    );

  let action: React.ReactNode = null;
  if (member)
    action = (
      <Button
        label={t('communities.leave')}
        variant="secondary"
        onPress={() => setConfirmLeave(true)}
      />
    );
  else if (st === 'pending')
    action = (
      <Button
        label={t('communities.requested')}
        variant="secondary"
        loading={join.isPending}
        onPress={() => join.mutate(c, { onError: fail })}
        accessibilityHint={t('communities.leave')}
      />
    );
  else if (st === 'invited')
    action = (
      <View style={{ flexDirection: 'row', gap: th.space[2] }}>
        <Button
          label={t('communities.acceptInvite')}
          loading={answer.isPending}
          onPress={() => answer.mutate({ id: c.id, accept: true }, { onError: fail })}
        />
        <Button
          label={t('communities.declineInvite')}
          variant="secondary"
          onPress={() => answer.mutate({ id: c.id, accept: false }, { onError: fail })}
        />
      </View>
    );
  else if (st === 'banned') action = null;
  else if (c.isPaid)
    action = (
      <AppText variant="caption" tone="muted">
        {t('communities.paid')}
      </AppText>
    );
  else if (c.joinPolicy === 'invite')
    action = <Button label={t('communities.inviteOnly')} variant="secondary" disabled />;
  else
    action = (
      <Button
        label={c.joinPolicy === 'request' ? t('communities.requestJoin') : t('communities.join')}
        loading={join.isPending}
        onPress={() => join.mutate(c, { onError: fail })}
      />
    );

  return (
    <View
      style={{
        padding: th.space[4],
        gap: th.space[3],
        backgroundColor: th.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: th.colors.border,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space[3] }}>
        <Avatar name={c.name} size={64} />
        <View style={{ flex: 1 }}>
          <AppText variant="title" header>
            {c.name}
          </AppText>
          <AppText
            variant="caption"
            tone="subtle"
          >{`${t('common.members', { count: c.memberCount })} · ${t(`communities.visibility.${c.visibility}`)}`}</AppText>
        </View>
      </View>
      {c.description ? <AppText variant="body">{c.description}</AppText> : null}
      {c.topics.length ? (
        <AppText variant="caption" tone="subtle">
          {c.topics.map((x) => `#${x}`).join(' ')}
        </AppText>
      ) : null}
      {action}
      {member ? (
        <Button
          label={t('communities.writeIn')}
          icon="plus"
          variant="secondary"
          onPress={() =>
            router.push({
              pathname: '/compose',
              params: { communityId: c.id, communityName: c.name },
            })
          }
        />
      ) : null}
      {error ? (
        <AppText
          variant="caption"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error}
        </AppText>
      ) : null}
      {c.rules?.length ? (
        <View style={{ gap: th.space[1] }}>
          <AppText variant="heading" header>
            {t('communities.rules')}
          </AppText>
          {c.rules.map((r, i) => (
            <AppText
              key={`${i}-${r.title}`}
              variant="caption"
              tone="muted"
            >{`${i + 1}. ${r.title}${r.body ? `: ${r.body}` : ''}`}</AppText>
          ))}
        </View>
      ) : null}
      <ConfirmDialog
        visible={confirmLeave}
        title={t('communities.leaveTitle', { name: c.name })}
        body={t('communities.leaveBody')}
        confirmLabel={t('communities.leave')}
        destructive
        loading={join.isPending}
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => join.mutate(c, { onSettled: () => setConfirmLeave(false), onError: fail })}
      />
    </View>
  );
}

export default function CommunityDetail() {
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { lowBandwidth } = usePrefs();
  const community = useCommunity(id);
  const full = community.data?.access === 'full';
  const feed = useCommunityFeed(community.data?.id, full);
  if (community.isPending)
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  if (community.isError)
    return (
      <Screen>
        <ErrorView
          error={community.error}
          onRetry={() => void community.refetch()}
          message={
            community.error instanceof ApiError && community.error.status === 404
              ? t('communities.notFound')
              : undefined
          }
        />
      </Screen>
    );
  const c = community.data;
  return (
    <>
      <Stack.Screen options={{ title: c.name }} />
      <PagedList
        query={
          full ? feed : { ...feed, items: [], isPending: false, isError: false, hasNextPage: false }
        }
        manualPaging={lowBandwidth}
        onRefresh={async () => {
          await Promise.all([community.refetch(), feed.refetch()]);
        }}
        header={<Header c={c} idOrSlug={id} />}
        renderItem={({ item }) => <PostCard post={item} />}
        empty={
          <EmptyView message={full ? t('communities.noPosts') : t('communities.summaryOnly')} />
        }
      />
    </>
  );
}
