import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { useApi, useAuth } from '../auth/AuthProvider';
import { useTopicList } from '../data/feed';
import { errorMessage } from '../lib/errors';
import { AppText, Avatar, Button, Chip, ErrorView, LoadingView, Screen } from '../ui';

type Followed = Record<string, 'active' | 'pending'>;

export default function Onboarding() {
  const th = useTheme();
  const t = useT();
  const api = useApi();
  const { refresh } = useAuth();
  const topics = useTopicList();
  const [step, setStep] = useState<'interests' | 'people'>('interests');
  const [picked, setPicked] = useState<string[]>([]);
  const [followed, setFollowed] = useState<Followed>({});
  const [error, setError] = useState<string | null>(null);

  const saveInterests = useMutation({
    mutationFn: async () => {
      if (picked.length) await api.profile.setInterests(picked);
    },
  });
  const people = useQuery({
    queryKey: ['onboardingPeople', picked.join(',')],
    queryFn: ({ signal }) => api.discover.suggestedFollows(picked, 12, { signal }),
    enabled: step === 'people',
  });
  const finish = useMutation({
    mutationFn: async () => {
      await api.profile.completeOnboarding();
      await refresh();
    },
  });

  const goPeople = () =>
    saveInterests.mutate(undefined, {
      onSuccess: () => {
        setError(null);
        setStep('people');
      },
      onError: (e) => setError(errorMessage(e, t)),
    });
  const follow = async (username: string) => {
    try {
      const r = await api.graph.follow(username);
      setFollowed((f) => ({ ...f, [username]: r.status }));
    } catch (e) {
      setError(errorMessage(e, t));
    }
  };
  const done = () => finish.mutate(undefined, { onError: (e) => setError(errorMessage(e, t)) });

  return (
    <Screen scroll>
      {step === 'interests' ? (
        <View>
          <AppText variant="title" header>
            {t('onboarding.interests')}
          </AppText>
          <AppText variant="body" tone="muted" style={{ marginVertical: th.space[3] }}>
            {t('onboarding.interestsBody')}
          </AppText>
          {topics.isPending ? (
            <LoadingView />
          ) : topics.isError ? (
            <ErrorView error={topics.error} onRetry={() => void topics.refetch()} />
          ) : (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: th.space[2],
                marginBottom: th.space[4],
              }}
            >
              {topics.data.items.map((tp) => (
                <Chip
                  key={tp.slug}
                  label={tp.name}
                  selected={picked.includes(tp.slug)}
                  onPress={() =>
                    setPicked((p) =>
                      p.includes(tp.slug) ? p.filter((x) => x !== tp.slug) : [...p, tp.slug],
                    )
                  }
                />
              ))}
            </View>
          )}
          <AppText
            variant="caption"
            tone="subtle"
            accessibilityLiveRegion="polite"
            style={{ marginBottom: th.space[3] }}
          >
            {t('onboarding.topicsPicked', { count: picked.length })}
          </AppText>
          {error ? (
            <AppText
              variant="body"
              tone="danger"
              accessibilityRole="alert"
              style={{ marginBottom: th.space[3] }}
            >
              {error}
            </AppText>
          ) : null}
          <Button
            label={t('common.next')}
            block
            loading={saveInterests.isPending}
            onPress={goPeople}
          />
          <Button
            label={t('common.skip')}
            variant="ghost"
            onPress={() => setStep('people')}
            style={{ marginTop: th.space[2] }}
          />
        </View>
      ) : (
        <View>
          <AppText variant="title" header>
            {t('onboarding.people')}
          </AppText>
          <AppText variant="body" tone="muted" style={{ marginVertical: th.space[3] }}>
            {t('onboarding.peopleBody')}
          </AppText>
          {people.isPending ? (
            <LoadingView />
          ) : people.isError ? (
            <ErrorView error={people.error} onRetry={() => void people.refetch()} />
          ) : people.data.items.length === 0 ? (
            <AppText variant="body" tone="muted" style={{ marginBottom: th.space[4] }}>
              {t('onboarding.noPeople')}
            </AppText>
          ) : (
            people.data.items.map((p) => {
              const st = followed[p.user.username];
              return (
                <View
                  key={p.user.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: th.space[3],
                    minHeight: th.targetMin + 12,
                  }}
                >
                  <Avatar name={p.user.displayName} uri={p.user.avatarUrl} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {p.user.displayName}
                    </AppText>
                    <AppText
                      variant="caption"
                      tone="subtle"
                      numberOfLines={1}
                    >{`@${p.user.username}`}</AppText>
                  </View>
                  <Button
                    compact
                    variant={st ? 'secondary' : 'primary'}
                    disabled={Boolean(st)}
                    label={
                      st === 'pending'
                        ? t('onboarding.requested')
                        : st
                          ? t('onboarding.followed')
                          : t('onboarding.follow')
                    }
                    accessibilityLabel={`${st === 'pending' ? t('onboarding.requested') : st ? t('onboarding.followed') : t('onboarding.follow')} @${p.user.username}`}
                    onPress={() => void follow(p.user.username)}
                  />
                </View>
              );
            })
          )}
          {error ? (
            <AppText
              variant="body"
              tone="danger"
              accessibilityRole="alert"
              style={{ marginBottom: th.space[3] }}
            >
              {error}
            </AppText>
          ) : null}
          <Button
            label={t('onboarding.finish')}
            block
            loading={finish.isPending}
            onPress={done}
            style={{ marginTop: th.space[4] }}
          />
        </View>
      )}
    </Screen>
  );
}
