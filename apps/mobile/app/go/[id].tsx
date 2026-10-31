import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useLayoutEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { PLAN_ANSWER_KEYS } from '../../../../packages/shared/src/plans';
import { client, errorMessage } from '../../lib/api';
import { useWhenText } from '../../lib/date-time';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { AnswerButtons, confirmCancel, Costs, PlaceLine, PlanForm, PlanPeoplePick, useCountsText, usePlan } from '../../lib/plans';
import { space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, Icon, KeyboardAvoid, Loading, Notice, ScreenError, useColors, userText } from '../../lib/ui';

/**
 * One plan, for the people in it (docs/product/go-out-together.md): when and where, who made it,
 * I'm in / Maybe / Can't, who's coming, its chat (and a poll to pick a time or a place), inviting
 * more friends, the maker's edit and cancel, and the cost split.
 */
export default function PlanScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useT();
  const when = useWhenText();
  const counts = useCountsText();
  const navigation = useNavigation();
  const on = useFlag('GO_OUT') !== false;
  const { plan, setPlan, problem, load } = usePlan(id);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: plan?.title ?? t('plans.title') });
  }, [navigation, plan?.title, t]);

  if (!on) return <EmptyState title={t('plans.title')} icon="calendar-outline" />;
  if (problem && !plan)
    return problem.gone ? (
      <EmptyState title={problem.text} icon="calendar-outline" action={{ label: t('plans.title'), onPress: () => router.replace('/go') }} />
    ) : (
      <ScreenError message={problem.text} onRetry={load} />
    );
  if (!plan) return <Loading />;
  const p = plan;
  const active = p.status === 'active';

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
  const openChat = (poll: boolean) =>
    p.conversationId && router.push({ pathname: '/chat/[id]', params: { id: p.conversationId, ...(poll ? { poll: '1' } : {}) } });

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={[{ color: c.ink, fontWeight: '800', fontSize: 24 }, userText]}>
            {p.title}
          </Text>
          {active ? null : <Notice tone="warn">{t('plans.cancelled')}</Notice>}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
            <Icon name="time-outline" size={16} color={c.inkMuted} />
            <Text style={{ color: c.ink, fontWeight: '600' }}>{when(new Date(p.startsAt))}</Text>
          </View>
          <PlaceLine place={p.place} />
          <Text style={[{ color: c.inkMuted }, userText]}>
            {t('plans.by', { name: p.maker.displayName })}
            {p.squad ? ` · ${t('plans.with', { squad: p.squad.name })}` : ''}
          </Text>
          {p.note ? <Text style={[{ color: c.ink, lineHeight: 22 }, userText]}>{p.note}</Text> : null}
        </View>
        {error ? <Notice tone="danger">{error}</Notice> : null}

        {editing ? (
          <Card>
            <PlanForm
              plan={p}
              onSaved={(next) => {
                setPlan(next);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </Card>
        ) : null}

        {active && !p.viewer.maker ? <AnswerButtons plan={p} onPlan={setPlan} onError={setError} /> : null}

        {p.conversationId ? (
          <View style={{ gap: space[2] }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              <Button label={t('plans.chat')} icon="chatbubbles-outline" size="sm" onPress={() => openChat(false)} />
              {active ? <Button label={t('plans.poll')} icon="stats-chart-outline" size="sm" variant="secondary" onPress={() => openChat(true)} /> : null}
            </View>
            <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('plans.chatNote')}</Text>
          </View>
        ) : null}

        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>
            {t('plans.people')}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{counts(p.counts)}</Text>
          {p.people.map((x) => (
            <View
              key={x.user.id}
              accessible
              accessibilityLabel={`${x.user.displayName}, ${t(PLAN_ANSWER_KEYS[x.answer])}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48 }}
            >
              <Avatar name={x.user.displayName} url={x.user.avatarUrl} size={36} />
              <Text style={[{ flex: 1, color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
                {x.user.displayName}
              </Text>
              <Text
                style={{
                  color: x.answer === 'in' ? c.success : x.answer === 'cant' ? c.danger : c.inkMuted,
                  fontWeight: x.answer === 'in' ? '700' : '500',
                  fontSize: 13,
                }}
              >
                {t(PLAN_ANSWER_KEYS[x.answer])}
              </Text>
            </View>
          ))}
          {p.viewer.canInvite ? (
            inviting ? (
              <>
                <PlanPeoplePick
                  planId={p.id}
                  chosen={inviting}
                  onToggle={(u) => setInviting((cur) => ((cur ?? []).includes(u.id) ? (cur ?? []).filter((x) => x !== u.id) : [...(cur ?? []), u.id]))}
                />
                <View style={{ flexDirection: 'row', gap: space[2] }}>
                  <Button
                    label={t('plans.invite')}
                    disabled={!inviting.length || !!busy}
                    onPress={() =>
                      run('invite', async () => {
                        setPlan((await (await client()).plans.invite(p.id, { userIds: inviting })).plan);
                        setInviting(null);
                      })
                    }
                  />
                  <Button label={t('common.cancel')} variant="ghost" onPress={() => setInviting(null)} />
                </View>
              </>
            ) : (
              <Button
                label={t('plans.inviteMore')}
                icon="person-add-outline"
                size="sm"
                variant="secondary"
                onPress={() => setInviting([])}
                style={{ alignSelf: 'flex-start' }}
              />
            )
          ) : null}
        </Card>

        {p.costs ? <Costs plan={p} onPlan={setPlan} /> : null}

        {p.viewer.maker && active && !editing ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button label={t('plans.edit')} icon="create-outline" variant="secondary" onPress={() => setEditing(true)} />
            <Button
              label={t('plans.cancel')}
              variant="danger"
              disabled={!!busy}
              onPress={() => confirmCancel(t, () => void run('cancel', async () => setPlan((await (await client()).plans.cancel(p.id)).plan)))}
            />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoid>
  );
}
