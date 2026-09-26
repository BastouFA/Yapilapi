import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { StoryGroup } from '../../../../packages/api-client/src/index';
import { client } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { StoryViewer } from '../../lib/stories';
import { EmptyState, Loading, useColors } from '../../lib/ui';

/**
 * One story, opened from a link, a story card in a chat, a reshare or a notification.
 * It opens only for people who can see it.
 */
export default function StoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useT();
  const [groups, setGroups] = useState<StoryGroup[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setGroups(null);
    setMissing(false);
    void client()
      .then((api) => api.moments.get(id))
      .then(
        (r) => setGroups([r.group]),
        () => setMissing(true),
      );
  }, [id]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (missing)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.stories.unavailable')} body={t('m.stories.unavailableBody')} />
      </View>
    );
  if (!groups) return <Loading />;
  return (
    <StoryViewer key={id} groups={groups} start={groups.length ? 0 : null} onClose={close} onChange={(next) => (next.length ? setGroups(next) : close())} />
  );
}
