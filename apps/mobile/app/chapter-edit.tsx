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
import { addDays, startOfDay } from '../../../packages/shared/src/date-picker';
import { client, errorMessage } from '../lib/api';
import { CoverPreview, SYMBOL_ICON } from '../lib/chapters';
import { DateField } from '../lib/date-time';
import { useT } from '../lib/i18n';
import { radius, space } from '../lib/theme';
import { Button, Field, Icon, Loading, Notice, SwitchRow, useColors, userText } from '../lib/ui';

const DAY = 86_400_000;
/** The API's window for a time capsule's opening: an hour to 25 years from now (apps/api/src/modules/chapters.ts). */
const CAPSULE_MIN_MS = 60 * 60 * 1000;
const CAPSULE_MAX_MS = 25 * 365 * DAY;

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
  // The opening day, at midnight on this phone's clock.
  const [until, setUntil] = useState<Date | null>(null);
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
          setUntil(ch.capsule ? new Date(ch.capsule.opensAt) : null);
        },
        (e) => {
          setChapter(null);
          setError(errorMessage(e));
        },
      );
  }, [id]);

  if (chapter === undefined) return <Loading />;
  const dateLocked = !!chapter?.capsule && (chapter.capsule.sealed || chapter.capsule.open);
  const validDay = !!until;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const api = await client();
      const opensAt = dateLocked ? undefined : capsule && until ? until.toISOString() : null;
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

  // A story picked as the cover shows instead of the colour and symbol.
  const coverStory = coverStoryId ? stories.find((x) => x.id === coverStoryId) : undefined;
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
      {/* Live preview: how the cover will look with the colour, symbol and story chosen below. */}
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[3],
          padding: space[3],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: c.line,
          backgroundColor: c.surfaceSunken,
        }}
      >
        <CoverPreview
          size={60}
          gradient={gradient}
          symbol={symbol}
          image={coverStory ? (coverStory.mediaKind === 'image' ? coverStory.mediaUrl : coverStory.posterUrl) : null}
          locked={capsule}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
            {title.trim() || t('chapters.previewTitle')}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {coverStory ? t('chapters.previewStoryCover') : capsule ? t('chapters.previewCapsule') : t('chapters.previewHint')}
          </Text>
        </View>
      </View>
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
          <DateField
            label={t('m.chapters.sealUntil')}
            sheetTitle={t('m.chapters.sealTitle')}
            mode="date"
            value={until}
            onChange={setUntil}
            disabled={dateLocked}
            min={new Date(Date.now() + CAPSULE_MIN_MS)}
            max={new Date(Date.now() + CAPSULE_MAX_MS)}
            presets={[30, 182, 365, 365 * 5].map((days) => {
              const at = startOfDay(addDays(new Date(), days));
              return { id: String(days), label: date(at, { dateStyle: 'medium' }), at };
            })}
            hint={t('m.chapters.sealHint')}
          />
          {dateLocked ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.chapters.dateFixed')}</Text> : null}
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
