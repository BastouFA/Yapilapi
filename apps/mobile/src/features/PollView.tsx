import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Poll } from '@yapilapi/api-client';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { useVotePoll } from '../data/posts';
import { AppText, Button } from '../ui';

export function PollView({ postId, poll }: { postId: string; poll: Poll }) {
  const th = useTheme();
  const t = useT();
  const vote = useVotePoll();
  const [picked, setPicked] = useState<string[]>([]);
  const closed = poll.closesAt !== null && new Date(poll.closesAt).getTime() < Date.now();
  const voted = poll.myVotes.length > 0;
  const showResults = voted || closed;
  const submit = (ids: string[]) => vote.mutate({ postId, optionIds: ids });

  return (
    <View accessibilityRole="summary" style={{ marginTop: th.space[3], gap: th.space[2] }}>
      <AppText variant="bodyStrong">{poll.question}</AppText>
      {poll.options.map((o) => {
        const pct = poll.totalVotes > 0 ? Math.round((o.votes / poll.totalVotes) * 100) : 0;
        const mine = poll.myVotes.includes(o.id);
        const on = picked.includes(o.id);
        return (
          <Pressable
            key={o.id}
            disabled={showResults || vote.isPending}
            accessibilityRole={showResults ? 'text' : poll.multiple ? 'checkbox' : 'button'}
            accessibilityState={
              poll.multiple && !showResults ? { checked: on } : { selected: mine }
            }
            accessibilityLabel={
              showResults ? `${o.label}, ${pct}%` : t('post.pollVote', { option: o.label })
            }
            onPress={() => {
              if (poll.multiple)
                setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
              else submit([o.id]);
            }}
            style={{
              minHeight: th.targetMin,
              borderRadius: th.radius.sm,
              borderWidth: 1,
              borderColor: mine || on ? th.colors.primary : th.colors.borderStrong,
              overflow: 'hidden',
              justifyContent: 'center',
              paddingHorizontal: th.space[3],
            }}
          >
            {showResults ? (
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  start: 0,
                  width: `${pct}%`,
                  backgroundColor: mine ? th.colors.primarySoft : th.colors.surfaceSubtle,
                }}
              />
            ) : null}
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space[2] }}
            >
              <AppText variant="body" style={{ flex: 1 }}>
                {o.label}
              </AppText>
              {showResults ? <AppText variant="label" tone="muted">{`${pct}%`}</AppText> : null}
            </View>
          </Pressable>
        );
      })}
      {poll.multiple && !showResults ? (
        <Button
          label={t('post.pollSubmit')}
          compact
          disabled={picked.length === 0}
          loading={vote.isPending}
          onPress={() => submit(picked)}
        />
      ) : null}
      <AppText variant="caption" tone="subtle">
        {closed ? t('post.pollClosed') : t('post.pollVotes', { count: poll.totalVotes })}
      </AppText>
    </View>
  );
}
