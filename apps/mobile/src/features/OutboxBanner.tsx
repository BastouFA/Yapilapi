import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { useOutbox } from '../offline/OutboxProvider';
import { AppText, Banner, Button } from '../ui';

/** Lists posts (and optionally messages) that are saved on the device but not delivered yet, with retry and discard. */
export function OutboxBanner({ kind = 'post' }: { kind?: 'post' | 'message' }) {
  const th = useTheme();
  const t = useT();
  const { items, retry, discard } = useOutbox();
  const mine = items.filter((i) => i.kind === kind);
  if (!mine.length) return null;
  const failed = mine.filter((i) => i.status === 'failed');
  return (
    <View>
      <Banner tone="warning" text={t('state.queuedBanner', { count: mine.length })} />
      {failed.map((i) => (
        <View
          key={i.id}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: th.space[2],
            paddingHorizontal: th.space[4],
            paddingVertical: th.space[2],
          }}
        >
          <AppText
            variant="caption"
            tone="danger"
            style={{ flex: 1 }}
            numberOfLines={2}
          >{`${t('state.queuedFailed')}: ${i.error ?? ''}`}</AppText>
          <Button
            label={t('state.queuedRetry')}
            variant="secondary"
            compact
            onPress={() => void retry(i.id)}
          />
          <Button
            label={t('state.queuedDiscard')}
            variant="ghost"
            compact
            onPress={() => void discard(i.id)}
          />
        </View>
      ))}
    </View>
  );
}
