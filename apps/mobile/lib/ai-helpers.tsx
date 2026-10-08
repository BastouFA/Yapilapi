/**
 * AI helpers on the phone: Catch me up on Pulse and in communities, suggested replies in chats,
 * "Suggest a description" for photos, caption ideas, and their switches in Settings. Everything
 * they show is labelled AI-generated; nothing is posted or sent until the person does it.
 */
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import type { AiSettings, CaptionIdeas, CatchUp, CatchUpOffer, SmartReplies } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { Chip } from './chips';
import { useFlag } from './flags';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Button, Card, Icon, Notice, SwitchRow, Title, useColors, userText } from './ui';

/** A card for AI output: a sparkle, the title, an "AI-generated" mark, then the content, the small print and actions. */
export function AiPanel({ title, children, notice, actions }: { title: string; children?: ReactNode; notice?: string; actions?: ReactNode }) {
  const c = useColors();
  const { t } = useT();
  return (
    <Card style={{ gap: space[2], borderWidth: 1.5, borderColor: c.yapiSoft }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Icon name="sparkles" size={18} color={c.yapi} />
        <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 15, flex: 1 }}>
          {title}
        </Text>
        <View style={{ backgroundColor: c.ground, borderRadius: radius.full, paddingHorizontal: space[2], paddingVertical: 2 }}>
          <Text style={{ color: c.inkMuted, fontSize: 11, fontWeight: '600' }}>{t('ai.label')}</Text>
        </View>
      </View>
      {typeof children === 'string' ? <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 22 }, userText]}>{children}</Text> : children}
      {notice ? <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>{notice}</Text> : null}
      {actions ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{actions}</View> : null}
    </Card>
  );
}

/** The small print under AI output: the dev stand-in's mark, or the held-back note, then the feature's own note. */
function useAiNotice() {
  const { t } = useT();
  return (r: { provider?: string; notice?: string } | null | undefined, extra?: string) =>
    [r?.provider === 'dev' ? t('ai.devNotice') : null, r?.notice && r.provider !== 'dev' ? t('ai.held') : null, extra].filter(Boolean).join(' ');
}

const SECTION_TITLE: Record<CatchUp['sections'][number]['kind'], MessageKey> = {
  moments: 'catchUp.section.moments',
  plans: 'catchUp.section.plans',
  popular: 'catchUp.section.popular',
};

/**
 * Pulse: after 12 hours or more away, a card offers "Catch me up", a short summary of what
 * your friends and the people you follow shared since, each line opening its posts.
 */
export function CatchUpCard() {
  const c = useColors();
  const { t, tp } = useT();
  const on = useFlag('AI_CATCH_UP');
  const notice = useAiNotice();
  const [offer, setOffer] = useState<CatchUpOffer | null>(null);
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!on) return;
    client()
      .then((api) => api.ai.pulseVisit())
      .then(setOffer, () => {});
  }, [on]);

  if (hidden || !offer?.offer) return null;
  if (!catchUp)
    return (
      <AiPanel
        title={t('catchUp.title')}
        actions={
          <>
            <Button
              label={t('catchUp.title')}
              icon="sparkles-outline"
              size="sm"
              onPress={async () => {
                setError(null);
                try {
                  setCatchUp((await (await client()).ai.catchUp()).catchUp);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
            <Button
              label={t('catchUp.notNow')}
              size="sm"
              variant="ghost"
              onPress={() => {
                setHidden(true);
                void client().then((api) => api.ai.dismissCatchUp().catch(() => {}));
              }}
            />
          </>
        }
      >
        <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{tp('catchUp.offer', offer.postCount ?? 0)}</Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </AiPanel>
    );
  return (
    <AiPanel
      title={t('catchUp.heading')}
      notice={notice(catchUp, t('catchUp.note'))}
      actions={<Button label={t('catchUp.hide')} size="sm" variant="ghost" onPress={() => setHidden(true)} />}
    >
      {catchUp.sections.length ? (
        <View style={{ gap: space[3] }}>
          {catchUp.sections.map((s) => (
            <View key={s.kind} style={{ gap: space[1] }}>
              <Text accessibilityRole="header" style={{ color: c.inkMuted, fontSize: 13, fontWeight: '700' }}>
                {t(SECTION_TITLE[s.kind])}
              </Text>
              {s.lines.map((l, i) => (
                <View key={i} style={{ gap: 2 }}>
                  <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText]}>{`• ${l.text}`}</Text>
                  {/* rowGap 28: links that wrap keep their 44pt touch areas apart. */}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: space[3], rowGap: 28, paddingStart: space[3] }}>
                    {l.posts.map((p) => (
                      <Pressable
                        key={p.id}
                        accessibilityRole="link"
                        // A 17pt line of text; the touch area reaches 44 (13 below, where the next point is 27pt away).
                        hitSlop={{ top: 14, bottom: 13, left: 6, right: 6 }}
                        onPress={() => router.push(`/p/${p.id}`)}
                      >
                        <Text style={{ color: c.yapi, fontSize: 13, fontWeight: '600' }}>{t('catchUp.openPost', { name: p.authorName })}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ color: c.ink }}>{t('catchUp.empty')}</Text>
      )}
    </AiPanel>
  );
}

/**
 * Up to three suggested replies under the last message you received. Tapping one puts it in the
 * message box; it's only sent when you send it. Asked for again when a new message arrives.
 */
export function SmartReplyChips({
  conversationId,
  lastMessageId,
  enabled,
  onPick,
}: {
  conversationId: string;
  lastMessageId: string | null;
  enabled: boolean;
  onPick: (text: string) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const on = useFlag('AI_SMART_REPLIES');
  const [replies, setReplies] = useState<SmartReplies | null>(null);
  useEffect(() => {
    setReplies(null);
    if (!enabled || !on || !lastMessageId) return;
    let live = true;
    client()
      .then((api) => api.conversations.smartReplies(conversationId))
      .then(
        (r) => live && setReplies(r),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [conversationId, lastMessageId, enabled, on]);
  if (!replies?.suggestions.length) return null;
  return (
    // One row: the label stays put and the replies scroll sideways, so longer ones (or languages)
    // never push the message box up.
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={`${t('smartReplies.label')}, ${t('ai.label')}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingStart: space[3], paddingTop: space[2] }}
    >
      <Text style={{ color: c.inkMuted, fontSize: 11, fontWeight: '600' }}>{t('ai.label')}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        // The chips are 36 tall with 4pt slop; the 4pt of padding (taken back by the margin) keeps
        // that slop inside the scroll view, which would clip it.
        style={{ flex: 1, marginVertical: -4 }}
        contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingEnd: space[3], paddingVertical: 4 }}
      >
        {replies.suggestions.map((s) => (
          <Chip
            key={s}
            label={s}
            a11yHint={t('smartReplies.hint')}
            onPress={() => {
              onPick(s);
              setReplies(null);
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/** Suggested replies for one chat: this chat's switch, with what the default is and whether Settings turned them off. */
export function SmartRepliesSwitch({
  state,
  onChange,
}: {
  state: { on: boolean; setting: boolean | null; defaultOn: boolean; everywhere: boolean };
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useT();
  const why = !state.everywhere
    ? t('smartReplies.offEverywhere')
    : state.setting === null
      ? t(state.defaultOn ? 'smartReplies.defaultDirect' : 'smartReplies.defaultGroup')
      : '';
  return (
    <SwitchRow
      label={t('smartReplies.label')}
      hint={`${t('smartReplies.chatHint')}${why ? ` ${why}` : ''}`}
      value={state.setting ?? state.defaultOn}
      disabled={!state.everywhere}
      onValueChange={onChange}
    />
  );
}

/** "Suggest a description" for one of your photos: the suggestion goes in the field, to edit before posting. */
export function SuggestAltText({
  mediaId,
  onSuggested,
  onError,
}: {
  mediaId: string;
  onSuggested: (text: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useT();
  const on = useFlag('AI_ALT_TEXT');
  const [note, setNote] = useState<string | null>(null);
  if (!on) return null;
  return (
    <View style={{ gap: space[1] }}>
      <Button
        label={t('altText.suggest')}
        icon="sparkles-outline"
        size="sm"
        variant="ghost"
        style={{ alignSelf: 'flex-start' }}
        onPress={async () => {
          try {
            const { suggestion } = await (await client()).ai.altText(mediaId);
            if (suggestion.text) {
              onSuggested(suggestion.text.slice(0, 500));
              setNote(suggestion.provider === 'dev' ? `${t('altText.suggested')} ${t('ai.devNotice')}` : t('altText.suggested'));
            } else setNote(t('altText.none'));
          } catch (e) {
            onError(errorMessage(e));
          }
        }}
      />
      {note ? <NoteText>{note}</NoteText> : null}
    </View>
  );
}

function NoteText({ children }: { children: string }) {
  const c = useColors();
  return (
    <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>
      {children}
    </Text>
  );
}

/** Caption ideas and hashtags people already use: "Use this" replaces the text, a tag is added to it. Nothing is posted. */
export function CaptionIdeasPanel({
  ideas,
  onUse,
  onAddTag,
  onClose,
}: {
  ideas: CaptionIdeas;
  onUse: (caption: string) => void;
  onAddTag: (tag: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const { t } = useT();
  const notice = useAiNotice();
  const [added, setAdded] = useState<string[]>([]);
  return (
    <AiPanel
      title={t('captions.title')}
      notice={notice(ideas, t('captions.note'))}
      actions={<Button label={t('compose.dismiss')} size="sm" variant="ghost" onPress={onClose} />}
    >
      {ideas.captions.length ? (
        <View style={{ gap: space[2] }}>
          {ideas.captions.map((caption) => (
            <View key={caption} style={{ gap: space[1] }}>
              <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText]}>{caption}</Text>
              <Button label={t('compose.useThis')} size="sm" variant="secondary" style={{ alignSelf: 'flex-start' }} onPress={() => onUse(caption)} />
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ color: c.ink }}>{t('captions.none')}</Text>
      )}
      {ideas.hashtags.length ? (
        <View style={{ gap: space[1] }}>
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '700' }}>{t('captions.hashtags')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {ideas.hashtags.map((tag) => (
              <Chip
                key={tag}
                label={`#${tag}`}
                a11yLabel={t('captions.addTag', { tag })}
                disabled={added.includes(tag)}
                onPress={() => {
                  onAddTag(tag);
                  setAdded((a) => [...a, tag]);
                }}
              />
            ))}
          </View>
        </View>
      ) : null}
    </AiPanel>
  );
}

/** A community's "Catch me up": a summary of recent posts members can see, reporting what they said. */
export function CommunityCatchUp({ communityId }: { communityId: string }) {
  const { t } = useT();
  const [summary, setSummary] = useState<{ text: string; dev: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={{ gap: space[2] }}>
      {summary ? null : (
        <Button
          label={t('community.catchUp')}
          icon="sparkles-outline"
          size="sm"
          variant="ghost"
          style={{ alignSelf: 'flex-start' }}
          onPress={async () => {
            setError(null);
            try {
              const r = await (await client()).ai.assist({ task: 'summarize_community', communityId });
              // Held back by the safety filters: say so rather than show an empty summary.
              setSummary({ text: r.output === null ? t('chat.ai.withheld') : String(r.output), dev: r.provider === 'dev' });
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {summary ? (
        <AiPanel
          title={t('community.catchUp.title')}
          notice={[summary.dev ? t('ai.devNotice') : null, t('community.catchUp.note')].filter(Boolean).join(' ')}
          actions={<Button label={t('m.common.close')} size="sm" variant="ghost" onPress={() => setSummary(null)} />}
        >
          {summary.text}
        </AiPanel>
      ) : null}
    </View>
  );
}

/** Settings > Privacy: suggested replies in chats (off by default under 18) and the Catch me up card on Pulse. */
export function AiHelpersSettings() {
  const { t } = useT();
  const [s, setS] = useState<AiSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client()
      .then((api) => api.ai.settings())
      .then(setS, (e) => setError(errorMessage(e)));
  }, []);
  const save = async (next: Partial<AiSettings>) => {
    setS((cur) => (cur ? { ...cur, ...next } : cur));
    setError(null);
    try {
      setS(await (await client()).ai.setSettings(next));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.ai.desc')}>{t('st.ai.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {s ? (
        <>
          <SwitchRow
            label={t('st.ai.smartReplies')}
            hint={t('st.ai.smartRepliesHint')}
            value={s.smartReplies}
            onValueChange={(v) => void save({ smartReplies: v })}
          />
          <SwitchRow label={t('st.ai.catchUp')} hint={t('st.ai.catchUpHint')} value={s.catchUp} onValueChange={(v) => void save({ catchUp: v })} />
        </>
      ) : null}
    </Card>
  );
}
