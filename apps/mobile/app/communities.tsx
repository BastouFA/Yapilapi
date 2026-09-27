import { router, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useState } from 'react';
import { FlatList } from 'react-native';
import type { Community } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { HeaderAction } from '../lib/forms';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { Avatar, EmptyState, Icon, Loading, Notice, Row, Screen, Segmented, useColors } from '../lib/ui';

type Scope = 'mine' | 'discover';

/** Communities: the ones you're in (with their posts, FAQ, rooms and members a tap away), and ones to discover. */
export default function Communities() {
  const c = useColors();
  const { t, tp } = useT();
  const [scope, setScope] = useState<Scope>('mine');
  const [items, setItems] = useState<Community[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: () => <HeaderAction label={t('m.communities.new')} icon="add" onPress={() => router.push('/community-new')} /> });
  }, [navigation, t]);

  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    void client()
      .then((api) => api.communities.list(scope))
      .then(
        (r) => live && setItems(r.items),
        (e) => live && (setItems([]), setError(errorMessage(e))),
      );
    return () => {
      live = false;
    };
  }, [scope]);

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <Segmented
        label={t('communities.title')}
        value={scope}
        onChange={setScope}
        options={[
          { id: 'mine', label: t('m.communities.mine') },
          { id: 'discover', label: t('m.communities.discover') },
        ]}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(x) => x.id}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[8] }}
          ListEmptyComponent={<EmptyState title={scope === 'mine' ? t('m.communities.emptyMine') : t('m.communities.emptyDiscover')} />}
          renderItem={({ item }) => (
            <Row
              title={item.name}
              subtitle={[tp('m.community.members', item.memberCount), item.visibility === 'private' ? t('m.community.private') : null]
                .filter(Boolean)
                .join(' · ')}
              start={<Avatar name={item.name} size={40} />}
              end={<Icon name="chevron-forward" size={18} color={c.inkMuted} directional />}
              onPress={() => router.push(`/c/${item.slug}`)}
            />
          )}
        />
      )}
    </Screen>
  );
}
