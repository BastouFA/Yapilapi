import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  View,
  type FlatListProps,
  type ListRenderItem,
} from 'react-native';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { isOffline } from '../lib/errors';
import { AppText } from './Text';
import { Button } from './Button';
import { EmptyView, ErrorView, LoadingView, OfflineBanner } from './States';

/** The pieces of a TanStack infinite query the list needs. */
export interface PagedQueryLike<T> {
  items: T[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isRefetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => unknown;
  refetch: () => unknown;
}

export interface PagedListProps<T extends { id: string }> extends Omit<
  FlatListProps<T>,
  'data' | 'renderItem' | 'keyExtractor'
> {
  query: PagedQueryLike<T>;
  renderItem: ListRenderItem<T>;
  /** Shown when the first page loaded and is empty. */
  empty: React.ReactElement;
  onRefresh?: () => unknown;
  /** Auto-load on scroll (default) or show an explicit "Load more" button (low-data mode). */
  manualPaging?: boolean;
  header?: React.ReactElement | null;
  /** Show the "you are all caught up" line at the end (off for chat). */
  showEnd?: boolean;
}

/**
 * List with every state handled the same way across the app: first load (spinner), first-load error (message + retry),
 * offline with cached items (banner + list), empty, pagination footer (spinner / retry / load more) and pull to refresh.
 */
export function PagedList<T extends { id: string }>({
  query,
  renderItem,
  empty,
  onRefresh,
  manualPaging,
  header,
  showEnd = true,
  ...rest
}: PagedListProps<T>) {
  const th = useTheme();
  const t = useT();
  const { items } = query;
  if (query.isPending && items.length === 0) return <LoadingView />;
  if (query.isError && items.length === 0)
    return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;

  const footer = query.isFetchingNextPage ? (
    <View style={{ padding: th.space[4] }}>
      <ActivityIndicator color={th.colors.primary} accessibilityLabel={t('common.loading')} />
    </View>
  ) : query.isError ? (
    <View style={{ padding: th.space[4], alignItems: 'center' }}>
      <AppText variant="caption" tone="muted" style={{ marginBottom: th.space[2] }}>
        {isOffline(query.error) ? t('state.offlineRetry') : t('state.loadFailed')}
      </AppText>
      <Button
        label={t('common.retry')}
        variant="secondary"
        compact
        onPress={() => void query.fetchNextPage()}
      />
    </View>
  ) : query.hasNextPage && manualPaging ? (
    <View style={{ padding: th.space[4], alignItems: 'center' }}>
      <Button
        label={t('common.loadMore')}
        variant="secondary"
        onPress={() => void query.fetchNextPage()}
      />
    </View>
  ) : showEnd && items.length > 0 && !query.hasNextPage ? (
    <AppText variant="caption" tone="subtle" style={{ textAlign: 'center', padding: th.space[6] }}>
      {t('common.endOfList')}
    </AppText>
  ) : null;

  return (
    <View style={{ flex: 1 }}>
      <OfflineBanner visible={query.isError && items.length > 0 && isOffline(query.error)} />
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        ListHeaderComponent={header ?? null}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching && !query.isFetchingNextPage}
            onRefresh={() => void (onRefresh ?? query.refetch)()}
            tintColor={th.colors.primary}
            colors={[th.colors.primary]}
          />
        }
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (!manualPaging && query.hasNextPage && !query.isFetchingNextPage && !query.isError)
            void query.fetchNextPage();
        }}
        initialNumToRender={6}
        windowSize={7}
        maxToRenderPerBatch={6}
        removeClippedSubviews
        {...rest}
      />
    </View>
  );
}

export { EmptyView };
