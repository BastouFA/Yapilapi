import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Chapter, ChapterStory } from '../../../packages/api-client/src/index';
import {
  CHAPTER_AUDIENCES,
  CHAPTER_DESCRIPTION_MAX,
  CHAPTER_GRADIENT_NAMES,
  CHAPTER_GRADIENTS,
  CHAPTER_SYMBOLS,
  CHAPTER_TITLE_MAX,
  type ChapterAudience,
  type ChapterGradient,
  type ChapterSymbol,
} from '../../../packages/shared/src/constants';
import { client, errorMessage } from '../lib/api';
import { SYMBOL_ICON } from '../lib/chapters';
import { useT } from '../lib/i18n';
import { radius, space } from '../lib/theme';
import { Button, Field, Icon, Loading, Notice, SwitchRow, useColors } from '../lib/ui';

const DAY = 86_400_000;
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Start or edit a chapter (`?id=` to edit): title, description, audience, cover (one of its
 * stories, or a brand gradient with a symbol) and "Seal until" to make it a time capsule.
 */
export default function ChapterEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const c = useColors();
  const { t, date } = useT();
  const [chapter, setChapter] = useState<Chapter | null | undefined>(id ? undefined : null);
  const [stories, setStories] = useState<ChapterStory[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [audience, setAudience] = useState<ChapterAudience>('followers');
  const [gradient, setGradient] = useState<ChapterGradient>('yapi');
  const [symbol, setSymbol] = useState<ChapterSymbol>('star');
  const [coverStoryId, setCoverStoryId] = useState<string | null>(null);
  const [capsule, setCapsule] = useState(false);
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    client()
      .then((api) => api.chapters.get(id))
      .then(
        ({ chapter: ch, stories: s }) => {
          setChapter(ch);
          setStories(s);
          setTitle(ch.title);
          setDescription(ch.description);
          setAudience(ch.audience);
          setGradient(ch.coverGradient);
          setSymbol(ch.coverSymbol);
          setCoverStoryId(ch.coverStoryId ?? null);
          setCapsule(!!ch.capsule);
          setUntil(ch.capsule ? toDay(new Date(ch.capsule.opensAt)) : '');
        },
        (e) => {
          setChapter(null);
          setError(errorMessage(e));
        },
      );
  }, [id]);

  if (chapter === undefined) return <Loading />;
  const dateLocked = !!chapter?.capsule && (chapter.capsule.sealed || chapter.capsule.open);
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(until) && !Number.isNaN(new Date(`${until}T00:00:00`).getTime());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const api = await client();
      const opensAt = dateLocked ? undefined : capsule && validDay ? new Date(`${until}T00:00:00`).toISOString() : null;
      const base = { title: title.trim(), description: description.trim(), audience, coverGradient: gradient, coverSymbol: symbol };
      const r = chapter
        ? await api.chapters.update(chapter.id, { ...base, ...(opensAt !== undefined ? { opensAt } : {}), coverStoryId })
        : await api.chapters.create({ ...base, opensAt: opensAt ?? null });
      if (chapter) router.back();
      else router.replace(`/chapter/${r.chapter.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const chip = (key: string, on: boolean, label: string, onPress: () => void, extra?: ReactNode) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: space[3],
        height: 36,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: on ? c.yapi : c.line,
        backgroundColor: on ? c.yapiSoft : c.surface,
      }}
    >
      {extra}
      <Text style={{ color: c.ink, fontWeight: on ? '700' : '600' }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      keyboardShouldPersistTaps="handled"
    >
      <Field
        label={t('m.chapters.titleLabel')}
        value={title}
        onChangeText={setTitle}
        maxLength={CHAPTER_TITLE_MAX}
        placeholder={t('m.chapters.newPlaceholder')}
      />
      <Field
        label={t('m.chapters.descriptionLabel')}
        value={description}
        onChangeText={setDescription}
        maxLength={CHAPTER_DESCRIPTION_MAX}
        multiline
        style={{ minHeight: 72, paddingTop: space[2] }}
      />
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.chapters.audience')}</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {CHAPTER_AUDIENCES.map((a) => chip(a, audience === a, t(`m.chapters.audience.${a}`), () => setAudience(a)))}
        </View>
      </View>
      {stories.length ? (
        <View style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.chapters.cover')}</Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {chip('none', coverStoryId === null, t('m.chapters.coverColour'), () => setCoverStoryId(null))}
            {stories.map((s, n) =>
              chip(s.id, coverStoryId === s.id, t('m.chapters.coverStory', { index: n + 1, date: date(s.createdAt, { dateStyle: 'medium' }) }), () =>
                setCoverStoryId(s.id),
              ),
            )}
          </View>
        </View>
      ) : null}
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.chapters.colour')}</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {CHAPTER_GRADIENT_NAMES.map((g) => (
            <Pressable
              key={g}
              accessibilityRole="radio"
              accessibilityState={{ selected: gradient === g }}
              accessibilityLabel={`${t('m.chapters.colour')} ${CHAPTER_GRADIENT_NAMES.indexOf(g) + 1}`}
              onPress={() => setGradient(g)}
              style={{ borderRadius: radius.sm + 3, borderWidth: 2, borderColor: gradient === g ? c.yapi : 'transparent', padding: 2 }}
            >
              <LinearGradient
                colors={[...CHAPTER_GRADIENTS[g]]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ width: 40, height: 40, borderRadius: radius.sm }}
              />
            </Pressable>
          ))}
        </View>
      </View>
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.chapters.symbol')}</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {CHAPTER_SYMBOLS.map((s) => (
            <Pressable
              key={s}
              accessibilityRole="radio"
              accessibilityState={{ selected: symbol === s }}
              accessibilityLabel={`${t('m.chapters.symbol')} ${CHAPTER_SYMBOLS.indexOf(s) + 1}`}
              onPress={() => setSymbol(s)}
              style={{
                width: 44,
                height: 44,
                borderRadius: radius.sm,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: symbol === s ? 2 : 1,
                borderColor: symbol === s ? c.yapi : c.line,
                backgroundColor: c.surface,
              }}
            >
              <Icon name={SYMBOL_ICON[s]} size={20} color={c.ink} />
            </Pressable>
          ))}
        </View>
      </View>
      <SwitchRow label={t('m.chapters.capsule')} hint={t('m.chapters.capsuleHint')} value={capsule} disabled={dateLocked} onValueChange={setCapsule} />
      {capsule ? (
        <View style={{ gap: space[2] }}>
          <Field
            label={t('m.chapters.sealUntil')}
            value={until}
            editable={!dateLocked}
            onChangeText={setUntil}
            placeholder={toDay(new Date(Date.now() + 365 * DAY))}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
          />
          {dateLocked ? (
            <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.chapters.dateFixed')}</Text>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {[30, 182, 365, 365 * 5].map((days) => {
                const d = toDay(new Date(Date.now() + days * DAY));
                return chip(String(days), until === d, date(`${d}T12:00:00`, { dateStyle: 'medium' }), () => setUntil(d));
              })}
            </View>
          )}
        </View>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        label={chapter ? t('m.chapters.save') : t('m.chapters.create')}
        disabled={!title.trim() || busy || (capsule && !dateLocked && !validDay)}
        onPress={() => void save()}
      />
    </ScrollView>
  );
}
