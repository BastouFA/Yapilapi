import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, Alert, FlatList, Platform, Pressable, RefreshControl, Text, View } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import {
  ASK_ANSWER_MAX,
  ASK_FILTERS,
  ASK_SHARE_VISIBILITIES,
  type AskBoxSettings,
  type AskFilter,
  type AskShareVisibility,
  type InboxQuestion,
} from '../../../packages/shared/src/ask';
import { client, errorMessage } from '../lib/api';
import { AnswerText, QuestionQuoteView } from '../lib/ask';
import { useT } from '../lib/i18n';
import { useReport } from '../lib/report';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { BottomSheet, Button, Card, EmptyState, Field, Icon, Loading, Notice, Screen, Segmented, SwitchRow, useActionSheet, useColors } from '../lib/ui';

const FILTER_LABEL: Record<AskFilter, MessageKey> = { new: 'ask.inbox.new', answered: 'ask.inbox.answered', hidden: 'ask.inbox.hidden' };
const EMPTY: Record<AskFilter, MessageKey> = { new: 'ask.inbox.empty.new', answered: 'ask.inbox.empty.answered', hidden: 'ask.inbox.empty.hidden' };

/**
 * Questions people asked you: new, answered and hidden. Answer (and share the answer as a post),
 * hide, delete, report or block whoever asked. Questions asked without a name never say who asked;
 * blocking from one stops that person asking again without telling you who it is.
 */
export default function Questions() {
  const c = useColors();
  const { t, timeAgo } = useT();
  const { me } = useSession();
  const menu = useActionSheet();
  const report = useReport();
  const [filter, setFilter] = useState<AskFilter>('new');
  const [items, setItems] = useState<InboxQuestion[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<AskFilter, number> | null>(null);
  const [box, setBox] = useState<AskBoxSettings | null>(null);
  const [answering, setAnswering] = useState<InboxQuestion | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // iOS has no live regions: read out what an action did ("Hidden", "Deleted") or why it failed.
  useEffect(() => {
    if (note && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(note.text);
  }, [note]);

  const load = useCallback(
    async (next?: string) => {
      try {
        const page = await (await client()).questions.inbox(filter, next);
        setItems((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
        setCounts(page.counts);
      } catch (e) {
        setItems((cur) => cur ?? []);
        setNote({ tone: 'danger', text: errorMessage(e) });
      }
    },
    [filter],
  );
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      if (!me) return;
      void client()
        .then((api) => api.questions.box())
        .then((r) => setBox(r.box))
        .catch(() => {});
    }, [me]),
  );

  /** Put a question back after an action, or drop it when it moved to another list. */
  const settle = (q: InboxQuestion | null, id: string) => {
    setItems((cur) => (q && q.state === filter ? (cur?.map((x) => (x.id === id ? q : x)) ?? cur) : (cur?.filter((x) => x.id !== id) ?? cur)));
    void client()
      .then((api) => api.questions.inbox(filter))
      .then((r) => setCounts(r.counts))
      .catch(() => {});
  };
  async function run(id: string, fn: () => Promise<InboxQuestion | null>, done?: string) {
    setNote(null);
    try {
      settle(await fn(), id);
      if (done) setNote({ tone: 'info', text: done });
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    }
  }

  function more(q: InboxQuestion) {
    const api = client();
    menu.show({
      title: t('ask.action.more'),
      actions: [
        { label: t('ask.action.report'), icon: 'flag-outline', onPress: () => report.open({ type: 'question', id: q.id }) },
        ...(q.askedWithoutName && q.askerBlocked
          ? [
              {
                label: t('ask.action.unblock'),
                icon: 'shield-outline' as const,
                onPress: () => void run(q.id, async () => (await (await api).questions.unblockAsker(q.id)).question, t('ask.unblock.done')),
              },
            ]
          : [
              {
                label: t('ask.action.block'),
                icon: 'hand-left-outline' as const,
                destructive: true,
                onPress: () =>
                  Alert.alert(
                    t('ask.action.block'),
                    q.askedWithoutName ? t('ask.block.confirmHidden') : t('ask.block.confirmNamed', { name: q.asker?.username ?? '' }),
                    [
                      { text: t('common.cancel'), style: 'cancel' },
                      {
                        text: t('ask.action.block'),
                        style: 'destructive',
                        onPress: () =>
                          void run(
                            q.id,
                            async () => (await (await api).questions.blockAsker(q.id)).question,
                            q.askedWithoutName ? t('ask.block.doneHidden') : t('ask.block.doneNamed'),
                          ),
                      },
                    ],
                  ),
              },
            ]),
        {
          label: t('ask.action.delete'),
          icon: 'trash-outline',
          destructive: true,
          onPress: () =>
            Alert.alert(t('ask.delete.confirm'), undefined, [
              { text: t('common.cancel'), style: 'cancel' },
              {
                text: t('ask.action.delete'),
                style: 'destructive',
                onPress: () =>
                  void run(
                    q.id,
                    async () => {
                      await (await api).questions.remove(q.id);
                      return null;
                    },
                    t('ask.deleted'),
                  ),
              },
            ]),
        },
      ],
    });
  }

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.common.signedOut')}</Notice>
      </Screen>
    );

  return (
    <>
      <FlatList
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
        data={items ?? []}
        keyExtractor={(q) => q.id}
        ListHeaderComponent={
          <View style={{ gap: space[3] }}>
            {box && !box.enabled ? (
              <Card style={{ gap: space[2] }}>
                <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('ask.box.off')}</Text>
                <Button
                  label={t('ask.card.turnOn')}
                  size="sm"
                  variant="secondary"
                  style={{ alignSelf: 'flex-start' }}
                  onPress={async () => {
                    try {
                      setBox((await (await client()).questions.setBox({ enabled: true })).box);
                    } catch (e) {
                      setNote({ tone: 'danger', text: errorMessage(e) });
                    }
                  }}
                />
              </Card>
            ) : null}
            <Button
              label={t('ask.box.title')}
              variant="ghost"
              size="sm"
              icon="settings-outline"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => router.push({ pathname: '/settings/[section]', params: { section: 'account' } })}
            />
            <Segmented
              label={t('ask.inbox.filter')}
              value={filter}
              onChange={setFilter}
              options={ASK_FILTERS.map((id) => ({ id, label: t(FILTER_LABEL[id]), count: counts?.[id] || undefined }))}
            />
            {note ? (
              <View accessibilityLiveRegion="polite">
                <Notice tone={note.tone} key={note.text}>
                  {note.text}
                </Notice>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={items ? <EmptyState title={t(EMPTY[filter])} /> : <Loading />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        onEndReached={() => void (cursor ? load(cursor) : undefined)}
        onEndReachedThreshold={0.5}
        renderItem={({ item: q }) => (
          <Card style={{ gap: space[2] }}>
            <QuestionQuoteView question={q}>{q.answer ? <AnswerText text={q.answer} /> : null}</QuestionQuoteView>
            <Text style={{ color: c.inkMuted, fontSize: 12 }}>
              {timeAgo(q.createdAt)}
              {q.held ? ` · ${t('ask.answer.held')}` : ''}
              {q.askerBlocked ? ` · ${t('ask.blocked.note')}` : ''}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] }}>
              {q.state === 'new' ? <Button label={t('ask.action.answer')} size="sm" onPress={() => setAnswering(q)} /> : null}
              {q.state === 'hidden' ? (
                <Button
                  label={t('ask.action.unhide')}
                  size="sm"
                  variant="secondary"
                  onPress={() => run(q.id, async () => (await (await client()).questions.unhide(q.id)).question)}
                />
              ) : (
                <Button
                  label={t('ask.action.hide')}
                  size="sm"
                  variant="ghost"
                  onPress={() => run(q.id, async () => (await (await client()).questions.hide(q.id)).question, t('ask.hidden.done'))}
                />
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('ask.action.more')}
                hitSlop={4}
                onPress={() => more(q)}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginStart: 'auto' }}
              >
                <Icon name="ellipsis-horizontal" size={20} color={c.ink} />
              </Pressable>
            </View>
          </Card>
        )}
      />
      <AnswerSheet
        question={answering}
        onClose={() => setAnswering(null)}
        onAnswered={(q, message) => {
          setAnswering(null);
          settle(q, q.id);
          setNote({ tone: 'info', text: message });
        }}
      />
      {menu.sheet}
      {report.sheet}
    </>
  );
}

/** Write an answer; optionally share it as a post too, to the audience chosen. */
function AnswerSheet({
  question,
  onClose,
  onAnswered,
}: {
  question: InboxQuestion | null;
  onClose: () => void;
  onAnswered: (q: InboxQuestion, message: string) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const [answer, setAnswer] = useState('');
  const [share, setShare] = useState(false);
  const [visibility, setVisibility] = useState<AskShareVisibility>('public');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setAnswer('');
    setShare(false);
    setError(null);
  }, [question?.id]);
  return (
    <BottomSheet visible={!!question} title={t('ask.action.answer')} onClose={onClose}>
      {question ? <QuestionQuoteView question={question} /> : null}
      <Field
        label={t('ask.answer.label')}
        value={answer}
        onChangeText={setAnswer}
        multiline
        autoFocus
        maxLength={ASK_ANSWER_MAX}
        style={{ minHeight: 110, textAlignVertical: 'top' }}
        error={error}
        hint={t('ask.card.count', { count: answer.length, max: ASK_ANSWER_MAX })}
      />
      <SwitchRow label={t('ask.answer.share')} value={share} onValueChange={setShare} />
      {share ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={t('ask.answer.shareTo')} style={{ gap: space[1] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('ask.answer.shareTo')}</Text>
          {ASK_SHARE_VISIBILITIES.map((v) => {
            const on = visibility === v;
            return (
              <Pressable
                key={v}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setVisibility(v)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
              >
                <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
                <Text style={{ color: c.ink, fontSize: 15, fontWeight: on ? '700' : '500' }}>{t(`visibility.${v}` as MessageKey)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <Button
        label={t('ask.answer.send')}
        disabled={!answer.trim()}
        onPress={async () => {
          if (!question) return;
          setError(null);
          try {
            const r = await (await client()).questions.answer(question.id, answer.trim(), share ? { visibility } : undefined);
            onAnswered(r.question, r.moderation?.message ?? t('ask.answer.done'));
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}
