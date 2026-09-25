import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { FeedMode } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { usePrefs } from '../../prefs';
import { useFeed } from '../../data/feed';
import { kv } from '../../lib/kv';
import { PostCard } from '../../features/PostCard';
import { OutboxBanner } from '../../features/OutboxBanner';
import { AppText, EmptyView, PagedList, Segmented } from '../../ui';

const MODES: FeedMode[] = ['for_you', 'following', 'friends'];
const MODE_KEY = 'yl.feedmode.v1';

export default function Home() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const { lowBandwidth } = usePrefs();
  const [mode, setMode] = useState<FeedMode>('for_you');
  React.useEffect(() => {
    void kv.get<FeedMode>(MODE_KEY).then((m) => {
      if (m && MODES.includes(m)) setMode(m);
    });
  }, []);
  const feed = useFeed(mode);
  const choose = (m: FeedMode) => {
    setMode(m);
    void kv.set(MODE_KEY, m);
  };

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.bg }}>
      <View style={{ padding: th.space[3], backgroundColor: th.colors.surface }}>
        <Segmented
          label={t('feed.modes')}
          value={mode}
          onChange={choose}
          options={MODES.map((m) => ({
            value: m,
            label: t(`feed.mode.${m as 'for_you' | 'following' | 'friends'}`),
          }))}
        />
      </View>
      <OutboxBanner kind="post" />
      {lowBandwidth ? (
        <AppText
          variant="caption"
          tone="subtle"
          style={{ padding: th.space[2], textAlign: 'center' }}
        >
          {t('feed.lowBandwidth')}
        </AppText>
      ) : null}
      <PagedList
        key={mode}
        query={feed}
        onRefresh={feed.refresh}
        manualPaging={lowBandwidth}
        renderItem={({ item }) => <PostCard post={item} showReasons={mode === 'for_you'} />}
        empty={
          <EmptyView
            message={t(`feed.empty.${mode as 'for_you' | 'following' | 'friends'}`)}
            actionLabel={mode === 'for_you' ? t('feed.newPost') : t('feed.findPeople')}
            onAction={() => router.push(mode === 'for_you' ? '/compose' : '/search')}
          />
        }
      />
    </View>
  );
}
