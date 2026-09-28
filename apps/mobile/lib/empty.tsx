// Empty states for the main tabs that point to the next useful thing to do: people to follow and
// what's trending when Pulse has nothing yet, friends to message when Yap has no chats.
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { TrendingTag } from '../../../packages/api-client/src/index';
import type { FeedMode } from '../../../packages/shared/src/constants';
import type { PeopleSuggestion, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Avatar, Button, Card, EmptyState, Notice, Skeleton, useColors, userText } from './ui';
import { suggestionReasonText } from '../../../packages/shared/src/server-text';

type Suggestion = PeopleSuggestion;

/** A person with a reason and one button, for the lists below. */
function PersonRow({ user, sub, action }: { user: PublicUser; sub?: string; action: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={sub ? `${user.displayName}, ${sub}` : user.displayName}
        onPress={() => router.push(`/u/${encodeURIComponent(user.username)}`)}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
      >
        <Avatar name={user.displayName} url={user.avatarUrl} size={40} />
        <View style={{ flex: 1 }}>
          <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {sub ?? `@${user.username}`}
          </Text>
        </View>
      </Pressable>
      {action}
    </View>
  );
}

function PeopleSkeleton() {
  return (
    <View style={{ gap: space[3] }}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
          <Skeleton width={40} height={40} radius={20} />
          <View style={{ flex: 1, gap: 6 }}>
            <Skeleton width="50%" height={12} />
            <Skeleton width="35%" height={10} />
          </View>
          <Skeleton width={76} height={36} radius={radius.full} />
        </View>
      ))}
    </View>
  );
}

/**
 * Pulse with nothing to show: why, then people to follow (each follow reloads the feed, so their
 * posts appear right away), trending tags, and ways to find friends or look around Wander.
 */
export function PulseEmpty({ mode, onFollowed, onShowForYou }: { mode: FeedMode; onFollowed: () => void; onShowForYou?: () => void }) {
  const c = useColors();
  const { t, tp } = useT();
  const [people, setPeople] = useState<Suggestion[] | null>(null);
  const [tags, setTags] = useState<TrendingTag[]>([]);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const api = await client();
      const [p, tr] = await Promise.all([api.me.suggestions({ limit: 6 }).catch(() => null), api.trending(8).catch(() => null)]);
      if (!live) return;
      setPeople(p?.items ?? []);
      setTags(tr?.items ?? []);
    })();
    return () => {
      live = false;
    };
  }, []);

  async function toggle(id: string) {
    const on = following.has(id);
    const next = new Set(following);
    if (on) next.delete(id);
    else next.add(id);
    setFollowing(next);
    setError(null);
    try {
      const api = await client();
      await (on ? api.users.unfollow(id) : api.users.follow(id));
      if (!on) onFollowed();
    } catch (e) {
      setFollowing(following);
      setError(errorMessage(e));
    }
  }

  const title = mode === 'following' ? t('m.empty.pulse.following') : mode === 'friends' ? t('m.empty.pulse.friends') : t('m.feed.empty.title');
  return (
    <View style={{ gap: space[3] }}>
      <EmptyState
        icon="sparkles-outline"
        title={title}
        body={t('starter.body')}
        action={{ label: t('friends.title'), icon: 'people-outline', onPress: () => router.push('/find-friends') }}
        secondary={
          onShowForYou
            ? { label: t('m.empty.pulse.forYou'), onPress: onShowForYou }
            : { label: t('m.empty.pulse.wander'), onPress: () => router.navigate('/discover') }
        }
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {people === null || people.length ? (
        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.empty.pulse.people')}
          </Text>
          {people === null ? (
            <PeopleSkeleton />
          ) : (
            people.map((p) => {
              const on = following.has(p.user.id);
              return (
                <PersonRow
                  key={p.user.id}
                  user={p.user}
                  sub={suggestionReasonText(p, { t, tp }) || undefined}
                  action={
                    <Button
                      size="sm"
                      variant={on ? 'secondary' : 'primary'}
                      label={on ? t('profile.unfollow') : t('profile.follow')}
                      onPress={() => toggle(p.user.id)}
                    />
                  }
                />
              );
            })
          )}
        </Card>
      ) : null}
      {tags.length ? (
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
            {t('onboarding.trending')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {tags.map((tg) => (
              <Pressable
                key={tg.tag}
                accessibilityRole="link"
                onPress={() => router.push(`/t/${encodeURIComponent(tg.tag)}`)}
                style={{ minHeight: 44, justifyContent: 'center' }}
              >
                <View
                  style={{
                    height: 34,
                    paddingHorizontal: space[3],
                    borderRadius: radius.full,
                    borderWidth: 1,
                    borderColor: c.lineStrong,
                    backgroundColor: c.surface,
                    justifyContent: 'center',
                  }}
                >
                  <Text style={[{ color: c.ink, fontWeight: '600' }, userText]}>#{tg.tag}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Yap with no chats yet: Start a chat, and people you know who you can message straight away
 * (friends and people you follow first).
 */
export function YapEmpty() {
  const c = useColors();
  const { t } = useT();
  const [people, setPeople] = useState<{ user: PublicUser; relation: 'friend' | 'following' | null }[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void client()
      .then((api) => api.people.suggest('', 6))
      .then(
        (r) => live && setPeople(r.items.filter((i) => i.canMessage)),
        () => live && setPeople([]),
      );
    return () => {
      live = false;
    };
  }, []);

  async function message(user: PublicUser) {
    setOpening(user.id);
    setError(null);
    try {
      const { conversation } = await (await client()).conversations.create([user.id]);
      router.push(`/chat/${conversation.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(null);
    }
  }

  return (
    <View style={{ gap: space[3] }}>
      <EmptyState
        icon="chatbubbles-outline"
        title={t('m.inbox.empty.title')}
        body={t('m.empty.yap.body')}
        action={{ label: t('m.empty.yap.start'), icon: 'create-outline', onPress: () => router.push({ pathname: '/new-group', params: { chat: '1' } }) }}
        secondary={people && !people.length ? { label: t('friends.title'), icon: 'people-outline', onPress: () => router.push('/find-friends') } : undefined}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {people === null || people.length ? (
        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.empty.yap.people')}
          </Text>
          {people === null ? (
            <PeopleSkeleton />
          ) : (
            people.map((p) => (
              <PersonRow
                key={p.user.id}
                user={p.user}
                sub={p.relation === 'friend' ? t('m.empty.yap.friend') : undefined}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="chatbubble-outline"
                    label={t('m.empty.yap.message')}
                    disabled={opening !== null}
                    onPress={() => message(p.user)}
                  />
                }
              />
            ))
          )}
        </Card>
      ) : null}
    </View>
  );
}
