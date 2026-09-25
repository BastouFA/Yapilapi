import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import {
  useAnswerInvitation,
  useCommunities,
  useInvitations,
  useMyCommunities,
} from '../../data/social';
import { CommunityRow } from '../../features/CommunityRow';
import { AppText, Button, EmptyView, PagedList, Segmented, TextField } from '../../ui';

type Tab = 'joined' | 'discover';

function Invitations() {
  const th = useTheme();
  const t = useT();
  const inv = useInvitations();
  const answer = useAnswerInvitation();
  const items = inv.data?.items ?? [];
  if (!items.length) return null;
  return (
    <View
      style={{ padding: th.space[4], gap: th.space[2], backgroundColor: th.colors.primarySoft }}
    >
      <AppText variant="heading" header>
        {t('communities.invitations')}
      </AppText>
      {items.map((c) => (
        <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: th.space[2] }}>
          <AppText variant="body" style={{ flex: 1 }} numberOfLines={1}>
            {c.name}
          </AppText>
          <Button
            compact
            label={t('communities.acceptInvite')}
            accessibilityLabel={`${t('communities.acceptInvite')}: ${c.name}`}
            loading={answer.isPending}
            onPress={() => answer.mutate({ id: c.id, accept: true })}
          />
          <Button
            compact
            variant="secondary"
            label={t('communities.declineInvite')}
            accessibilityLabel={`${t('communities.declineInvite')}: ${c.name}`}
            onPress={() => answer.mutate({ id: c.id, accept: false })}
          />
        </View>
      ))}
    </View>
  );
}

export default function Communities() {
  const th = useTheme();
  const t = useT();
  const [tab, setTab] = useState<Tab>('joined');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setTerm(q), 350);
    return () => clearTimeout(id);
  }, [q]);
  const joined = useMyCommunities();
  const discover = useCommunities(term);
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.bg }}>
      <View style={{ padding: th.space[3], backgroundColor: th.colors.surface, gap: th.space[3] }}>
        <Segmented<Tab>
          label={t('nav.communities')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'joined', label: t('communities.joined') },
            { value: 'discover', label: t('communities.discover') },
          ]}
        />
        {tab === 'discover' ? (
          <TextField
            label={t('communities.search')}
            value={q}
            onChangeText={setQ}
            autoCapitalize="none"
            returnKeyType="search"
          />
        ) : null}
      </View>
      {tab === 'joined' ? (
        <PagedList
          key="joined"
          query={joined}
          header={<Invitations />}
          renderItem={({ item }) => <CommunityRow community={item} />}
          empty={
            <EmptyView
              message={t('communities.emptyJoined')}
              actionLabel={t('communities.discover')}
              onAction={() => setTab('discover')}
            />
          }
        />
      ) : (
        <PagedList
          key="discover"
          query={discover}
          renderItem={({ item }) => <CommunityRow community={item} />}
          empty={<EmptyView message={t('communities.emptyDiscover')} />}
        />
      )}
    </View>
  );
}
