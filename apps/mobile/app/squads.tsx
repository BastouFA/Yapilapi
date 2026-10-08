import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { MAX_SQUAD_MEMBERS, SQUAD_RULES, type SquadColor } from '../../../packages/shared/src/constants';
import type { SquadCard } from '../../../packages/shared/src/squads';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { ColorChoice, PeoplePick, PhotoChoice, SquadCoverView } from '../lib/squads';
import { space } from '../lib/theme';
import { Button, Card, ErrorState, Field, Icon, KeyboardAvoid, Loading, Notice, Title, useColors, userText } from '../lib/ui';

/**
 * Squads: small private groups of up to 10 friends, with a shared feed, story, chat and weekly
 * memory. Invites wait at the top with Join and Decline; below, your squads and a new one.
 */
export default function Squads() {
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const [list, setList] = useState<SquadCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<SquadColor>('coral');
  const [photo, setPhoto] = useState<{ id: string; url: string } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    client()
      .then((api) => api.squads.list())
      .then(
        (r) => setList(r.items),
        (e) => {
          setList((cur) => cur ?? []);
          setLoadError(errorMessage(e));
        },
      );
  }, []);
  // Reload when coming back from a squad (left, deleted, renamed).
  useFocusEffect(load);

  if (me === undefined || list === null) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );

  async function run(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const create = () =>
    run('create', async () => {
      if (chosen.length < SQUAD_RULES.minInvites) throw new Error(t('squads.invitePick', { min: SQUAD_RULES.minInvites }));
      const { squad } = await (await client()).squads.create({ name: name.trim(), color, coverMediaId: photo?.id, userIds: chosen });
      setMaking(false);
      setName('');
      setChosen([]);
      setPhoto(null);
      router.push({ pathname: '/squad/[id]', params: { id: squad.id } });
    });

  const answer = (s: SquadCard, join: boolean) =>
    run(s.id, async () => {
      const api = await client();
      if (join) {
        await api.squads.accept(s.id);
        router.push({ pathname: '/squad/[id]', params: { id: s.id } });
      } else await api.squads.decline(s.id);
      load();
    });

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Title sub={t('squads.intro', { max: MAX_SQUAD_MEMBERS })}>{t('squads.title')}</Title>
        {loadError ? <ErrorState message={loadError} onRetry={load} /> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {list.length ? (
          list.map((s) => (
            <Card
              key={s.id}
              onPress={s.invitedBy ? undefined : () => router.push({ pathname: '/squad/[id]', params: { id: s.id } })}
              label={s.name}
              style={{ gap: space[3] }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                <SquadCoverView name={s.name} cover={s.cover} size={48} />
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16 }, userText]} numberOfLines={1}>
                    {s.name}
                  </Text>
                  <Text style={[{ color: c.inkMuted }, userText]} numberOfLines={1}>
                    {s.invitedBy ? t('squads.invitedBy', { name: s.invitedBy.displayName }) : tp('squads.people', s.memberCount)}
                  </Text>
                </View>
                {s.invitedBy ? null : <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />}
              </View>
              {s.invitedBy ? (
                <View style={{ flexDirection: 'row', gap: space[2] }}>
                  <Button label={t('squads.join')} size="sm" disabled={busy === s.id} onPress={() => answer(s, true)} />
                  <Button label={t('m.common.decline')} size="sm" variant="secondary" disabled={busy === s.id} onPress={() => answer(s, false)} />
                </View>
              ) : null}
            </Card>
          ))
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('squads.empty')}</Text>
        )}
        {making ? (
          <Card style={{ gap: space[3] }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
              {t('squads.new')}
            </Text>
            <SquadCoverView
              name={name || '?'}
              cover={{ color, photo: photo ? { id: photo.id, kind: 'image', url: photo.url, altText: null, width: null, height: null } : null }}
            />
            <Field label={t('squads.name')} value={name} onChangeText={setName} maxLength={SQUAD_RULES.nameMax} returnKeyType="done" />
            <ColorChoice value={color} onChange={setColor} />
            <PhotoChoice value={photo} onChange={setPhoto} onError={setError} />
            <PeoplePick
              chosen={chosen}
              max={MAX_SQUAD_MEMBERS - 1}
              onToggle={(u) => setChosen((cur) => (cur.includes(u.id) ? cur.filter((x) => x !== u.id) : [...cur, u.id]))}
            />
            <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
              <Button label={t('squads.create')} disabled={!!busy || !name.trim()} onPress={create} />
              <Button label={t('common.cancel')} variant="ghost" onPress={() => setMaking(false)} />
            </View>
          </Card>
        ) : (
          <Button label={t('squads.new')} icon="add" onPress={() => setMaking(true)} />
        )}
      </ScrollView>
    </KeyboardAvoid>
  );
}
