import { router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, Pressable, Text, View } from 'react-native';
import type { Profile } from '../../../packages/shared/src/types';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import {
  ASK_AUDIENCES,
  ASK_PROMPT_MAX,
  ASK_QUESTION_MAX,
  askedByKey,
  type AnswerCard,
  type AskAudience,
  type AskBoxSettings,
  type AskRefusal,
  type QuotedQuestion,
} from '../../../packages/shared/src/ask';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { useReport } from './report';
import { useSession } from './session';
import { radius, space } from './theme';
import { BottomSheet, Button, Card, EmptyState, Field, Icon, Notice, SkeletonList, SwitchRow, Title, useColors, userText, type Tint } from './ui';
import { noticeText } from '../../../packages/shared/src/server-text';

const REFUSAL: Partial<Record<AskRefusal, MessageKey>> = {
  audience: 'ask.refusal.audience',
  private: 'ask.refusal.private',
  minor: 'ask.refusal.minor',
  blocked: 'ask.refusal.blocked',
};

const AUDIENCE_LABEL: Record<AskAudience, MessageKey> = {
  everyone: 'ask.audience.everyone',
  following: 'ask.audience.following',
  friends: 'ask.audience.friends',
};

/** Read a note out on iOS when it appears; the live region around it covers Android. */
function useSayOnIos(text: string | null | undefined) {
  useEffect(() => {
    if (text && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

/**
 * A quoted question: the question, then "Asked by @name" (which opens their profile) or "Asked
 * without a name". A question asked without a name never carries who asked. `children` goes
 * underneath (the answer).
 */
export function QuestionQuoteView({ question, children }: { question: Pick<QuotedQuestion, 'question' | 'askedWithoutName' | 'asker'>; children?: ReactNode }) {
  const c = useColors();
  const { t } = useT();
  const by = askedByKey(question);
  const asker = !question.askedWithoutName ? question.asker : null;
  return (
    <View
      style={{
        gap: space[1],
        padding: space[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.line,
        borderStartWidth: 3,
        borderStartColor: c.yapi,
        backgroundColor: c.surfaceSunken,
      }}
    >
      <View accessible accessibilityLabel={`${t('ask.card.question')}: ${question.question}`} style={{ flexDirection: 'row', gap: space[2] }}>
        <Icon name="help-circle-outline" size={18} color={c.yapi} />
        <Text style={[{ flex: 1, color: c.ink, fontSize: 15, fontWeight: '700', lineHeight: 21 }, userText]}>{question.question}</Text>
      </View>
      {asker ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t(by, { name: asker.username })}
          hitSlop={8}
          onPress={() => router.push(`/u/${asker.username}`)}
          style={{ minHeight: 28, justifyContent: 'center' }}
        >
          <Text style={{ color: c.inkMuted, fontSize: 13, textDecorationLine: 'underline' }}>{t(by, { name: asker.username })}</Text>
        </Pressable>
      ) : (
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t(by, { name: '' })}</Text>
      )}
      {children}
    </View>
  );
}

/** An answer's text under its question. */
export function AnswerText({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text
      style={[{ color: c.ink, fontSize: 15, lineHeight: 22, marginTop: space[2], paddingTop: space[2], borderTopWidth: 1, borderTopColor: c.line }, userText]}
    >
      {text}
    </Text>
  );
}

/**
 * The question box on a profile. Visitors see the prompt and a button that opens the question
 * sheet (with "Ask without your name shown" when the owner allows it); when they can't ask, it
 * says why. Your own: the prompt and your questions, or a way to turn it on.
 */
export function AskCard({ profile, tint, onChanged }: { profile: Profile; tint: Tint; onChanged: () => void }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const box = profile.ask;
  useSayOnIos(note?.text);

  if (profile.relationship.isSelf) {
    if (!box?.enabled)
      return (
        <Card style={{ gap: space[2] }}>
          <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('ask.card.self')}</Text>
          {note ? (
            <View accessibilityLiveRegion="polite">
              <Notice tone={note.tone}>{note.text}</Notice>
            </View>
          ) : null}
          <Button
            label={t('ask.card.turnOn')}
            size="sm"
            variant="secondary"
            icon="help-circle-outline"
            style={{ alignSelf: 'flex-start' }}
            onPress={async () => {
              try {
                await (await client()).questions.setBox({ enabled: true });
                onChanged();
              } catch (e) {
                setNote({ tone: 'danger', text: errorMessage(e) });
              }
            }}
          />
        </Card>
      );
    return (
      <Card style={{ gap: space[2] }}>
        <Title sub={box.prompt ?? undefined}>{t('ask.box.title')}</Title>
        <Button
          label={t('ask.box.open')}
          size="sm"
          variant="secondary"
          icon="chatbubbles-outline"
          style={{ alignSelf: 'flex-start' }}
          onPress={() => router.push('/questions')}
        />
      </Card>
    );
  }

  if (!box?.enabled) return null;
  return (
    <Card style={{ gap: space[2] }}>
      <Title sub={box.prompt ?? undefined}>{t('ask.card.title', { name: profile.displayName })}</Title>
      {note ? (
        <View accessibilityLiveRegion="polite">
          <Notice tone={note.tone}>{note.text}</Notice>
        </View>
      ) : null}
      {!me ? (
        <Button label={t('ask.card.signIn')} size="sm" tint={tint} style={{ alignSelf: 'flex-start' }} onPress={() => router.push('/login')} />
      ) : !box.canAsk ? (
        <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>
          {t(REFUSAL[box.refusal ?? 'blocked'] ?? 'ask.refusal.blocked', { name: profile.displayName })}
        </Text>
      ) : (
        <Button label={t('ask.card.send')} size="sm" tint={tint} icon="help-circle-outline" style={{ alignSelf: 'flex-start' }} onPress={() => setOpen(true)} />
      )}
      <AskSheet
        visible={open}
        profile={profile}
        tint={tint}
        onClose={() => setOpen(false)}
        onSent={(text) => {
          setOpen(false);
          setNote({ tone: 'info', text });
        }}
      />
    </Card>
  );
}

/** Write a question; it goes when it's sent, and the sheet closes. */
function AskSheet({
  visible,
  profile,
  tint,
  onClose,
  onSent,
}: {
  visible: boolean;
  profile: Profile;
  tint: Tint;
  onClose: () => void;
  onSent: (note: string) => void;
}) {
  const { t } = useT();
  const [body, setBody] = useState('');
  const [hideName, setHideName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = !!profile.ask?.hiddenNamesAllowed;
  return (
    <BottomSheet visible={visible} title={t('ask.card.title', { name: profile.displayName })} subtitle={profile.ask?.prompt ?? undefined} onClose={onClose}>
      <Field
        label={t('ask.card.placeholder')}
        value={body}
        onChangeText={setBody}
        multiline
        autoFocus
        maxLength={ASK_QUESTION_MAX}
        style={{ minHeight: 96, textAlignVertical: 'top' }}
        error={error}
        hint={t('ask.card.count', { count: body.length, max: ASK_QUESTION_MAX })}
      />
      {allowed ? (
        <SwitchRow
          label={t('ask.card.hideName')}
          hint={t('ask.card.hideNameHint', { name: profile.displayName })}
          value={hideName}
          onValueChange={setHideName}
        />
      ) : null}
      <Button
        label={t('ask.card.send')}
        tint={tint}
        disabled={!body.trim()}
        onPress={async () => {
          setError(null);
          try {
            const r = await (await client()).questions.ask(profile.id, body.trim(), hideName && allowed);
            setBody('');
            setHideName(false);
            onSent(noticeText({ code: r.noticeCode, message: r.notice }, t) ?? t('ask.card.sent'));
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}

/** The Answers tab: answered questions, newest first, each with Report for other people. */
export function AnswersList({ profile }: { profile: Profile }) {
  const c = useColors();
  const { t, timeAgo } = useT();
  const { me } = useSession();
  const report = useReport();
  const [items, setItems] = useState<AnswerCard[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (next?: string) => {
      try {
        const page = await (await client()).questions.answers(profile.id, next);
        setItems((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setItems((cur) => cur ?? []);
        setError(errorMessage(e));
      }
    },
    [profile.id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!items) return <SkeletonList kind="post" count={2} />;
  if (!items.length)
    return (
      <View style={{ gap: space[2] }}>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <EmptyState title={t('ask.answers.empty')} body={profile.relationship.isSelf ? t('ask.answers.emptySelf') : undefined} />
      </View>
    );
  const canReport = !!me && !profile.relationship.isSelf;
  return (
    <View style={{ gap: space[3] }}>
      {items.map((a) => (
        <Card key={a.id} style={{ gap: space[2] }}>
          <QuestionQuoteView question={a}>
            <AnswerText text={a.answer} />
          </QuestionQuoteView>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' }}>
            <Text style={{ color: c.inkMuted, fontSize: 12, flex: 1 }}>{timeAgo(a.answeredAt)}</Text>
            {a.held ? <Text style={{ color: c.inkMuted, fontSize: 12, flexBasis: '100%' }}>{t('ask.answer.held')}</Text> : null}
            {canReport ? (
              <Button label={t('ask.action.report')} size="sm" variant="ghost" icon="flag-outline" onPress={() => report.open({ type: 'answer', id: a.id })} />
            ) : null}
          </View>
        </Card>
      ))}
      {cursor ? <Button label={t('feed.loadMore')} variant="secondary" onPress={() => load(cursor)} /> : null}
      {report.sheet}
    </View>
  );
}

/**
 * Settings: your question box. On or off, the prompt shown above it, who can ask, and whether
 * people may ask without their name shown (never for accounts of people under 18).
 */
export function AskBoxSettings() {
  const c = useColors();
  const { t } = useT();
  const [box, setBox] = useState<AskBoxSettings | null>(null);
  const [prompt, setPrompt] = useState('');
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  useSayOnIos(note?.text);
  useEffect(() => {
    client()
      .then((api) => api.questions.box())
      .then((r) => {
        setBox(r.box);
        setPrompt(r.box.prompt ?? '');
      })
      .catch((e) => setNote({ tone: 'danger', text: errorMessage(e) }));
  }, []);

  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('ask.box.desc')}>{t('ask.box.title')}</Title>
      {note ? (
        <View accessibilityLiveRegion="polite">
          <Notice tone={note.tone}>{note.text}</Notice>
        </View>
      ) : null}
      {box ? (
        <>
          <SwitchRow label={t('ask.box.enable')} value={box.enabled} onValueChange={(v) => setBox({ ...box, enabled: v })} />
          <Field label={t('ask.box.prompt')} value={prompt} onChangeText={setPrompt} maxLength={ASK_PROMPT_MAX} hint={t('ask.box.promptHint')} />
          <View accessibilityRole="radiogroup" accessibilityLabel={t('ask.box.audience')} style={{ gap: space[1] }}>
            <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('ask.box.audience')}</Text>
            {ASK_AUDIENCES.map((id) => {
              const on = box.audience === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => setBox({ ...box, audience: id })}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
                >
                  <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
                  <Text style={{ color: c.ink, fontSize: 15, fontWeight: on ? '700' : '500' }}>{t(AUDIENCE_LABEL[id])}</Text>
                </Pressable>
              );
            })}
          </View>
          <SwitchRow
            label={t('ask.box.hiddenNames')}
            hint={box.hiddenNamesAvailable ? t('ask.box.hiddenNamesHint') : t('ask.box.hiddenNamesMinor')}
            value={box.allowHiddenNames}
            disabled={!box.hiddenNamesAvailable}
            onValueChange={(v) => setBox({ ...box, allowHiddenNames: v })}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button
              label={t('common.save')}
              onPress={async () => {
                setNote(null);
                try {
                  const r = await (
                    await client()
                  ).questions.setBox({
                    enabled: box.enabled,
                    prompt: prompt.trim() || null,
                    audience: box.audience,
                    allowHiddenNames: box.allowHiddenNames,
                  });
                  setBox(r.box);
                  setPrompt(r.box.prompt ?? '');
                  setNote({ tone: 'info', text: t('ask.box.saved') });
                } catch (e) {
                  setNote({ tone: 'danger', text: errorMessage(e) });
                }
              }}
            />
            <Button label={t('ask.box.open')} variant="ghost" onPress={() => router.push('/questions')} />
          </View>
        </>
      ) : null}
    </Card>
  );
}
