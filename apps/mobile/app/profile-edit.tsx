import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PROFILE_MODES } from '../../../packages/shared/src/constants';
import { SUPPORTED_LOCALES, type MessageKey } from '../../../packages/shared/src/i18n';
import type { Post, Profile } from '../../../packages/shared/src/types';
import { CITY_MAX, PRONOUNS_MAX, type ProfileAccent, type ProfileHeaderStyle, type ProfileTab } from '../../../packages/shared/src/profile-style';
import { languageName } from '../../../packages/shared/src/translation';
import { ApiError } from '../../../packages/api-client/src/index';
import { client, errorMessage, mediaUrl } from '../lib/api';
import { Chip, ChipRow } from '../lib/chips';
import { useScrollToError } from '../lib/forms';
import { useT } from '../lib/i18n';
import { pickOne, uploadPicked } from '../lib/media';
import { MusicField, draftMusic, musicInput, type DraftMusic } from '../lib/music';
import { FeaturedEditor, LinksEditor, StyleEditor, TabsEditor, editorTabs, songAsTrack, useTint } from '../lib/profile-style';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Avatar, Button, Card, Field, KeyboardAvoid, Loading, Notice, SwitchRow, Title, useColors } from '../lib/ui';

/**
 * Edit profile: photo, name, bio, profile type, the app's language and a private account, the
 * same fields as the web settings, and how the profile looks: accent and header (with a live
 * preview in light and dark), pronouns and city, links, a song, tabs and featured posts. The cover
 * photo is changed on the profile itself.
 */
export default function ProfileEdit() {
  const c = useColors();
  const { t, number } = useT();
  const { me, refresh } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [mode, setMode] = useState<string>('personal');
  const [locale, setLocale] = useState('en');
  const [initialLocale, setInitialLocale] = useState('en');
  const [isPrivate, setIsPrivate] = useState(false);
  const [photo, setPhoto] = useState<{ local: string; progress: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const form = useScrollToError();
  const [accent, setAccent] = useState<ProfileAccent>('yapi');
  const [header, setHeader] = useState<ProfileHeaderStyle>('cover');
  const [pronouns, setPronouns] = useState('');
  const [city, setCity] = useState('');
  const [links, setLinks] = useState<{ label: string; url: string }[]>([]);
  const [tabOrder, setTabOrder] = useState<ProfileTab[]>(editorTabs([]));
  const [tabsShown, setTabsShown] = useState<Set<ProfileTab>>(new Set(editorTabs([])));
  const [featured, setFeatured] = useState<Post[]>([]);
  const [song, setSong] = useState<DraftMusic | null>(null);
  const [songChanged, setSongChanged] = useState(false);
  const tint = useTint(accent);

  useEffect(() => {
    if (!me) return;
    void client()
      .then((api) => api.users.get(me.username))
      .then(
        ({ profile: p }) => {
          setProfile(p);
          setDisplayName(p.displayName);
          setBio(p.bio);
          setMode(p.mode);
          setIsPrivate(p.isPrivate);
          setAccent(p.style.accent);
          setHeader(p.style.header);
          setPronouns(p.pronouns ?? '');
          setCity(p.city ?? '');
          setLinks(p.links.map(({ label, url }) => ({ label, url })));
          setTabOrder(editorTabs(p.tabs));
          setTabsShown(new Set(p.tabs));
          setFeatured(p.featured);
          setSong(p.song ? draftMusic(songAsTrack(p.song), 'post', { startMs: p.song.startMs, durationMs: p.song.durationMs }) : null);
          // The app's language as saved ("fr-CA" shows as French); only sent back if changed here.
          const current = SUPPORTED_LOCALES.find((l) => me.locale === l || me.locale?.startsWith(`${l}-`)) ?? 'en';
          setLocale(current);
          setInitialLocale(current);
        },
        (e) => setError(errorMessage(e)),
      );
  }, [me]);

  async function changePhoto() {
    setError(null);
    const asset = await pickOne(['images']).catch((e: unknown) => {
      setError(errorMessage(e));
      return null;
    });
    if (asset === 'denied') return setError(t('m.create.photosPermission'));
    if (!asset) return;
    setPhoto({ local: asset.uri, progress: 0 });
    try {
      const m = await uploadPicked(asset, (progress) => setPhoto({ local: asset.uri, progress }));
      const url = mediaUrl(m.url);
      const r = await (await client()).me.updateProfile({ avatarUrl: url });
      setProfile(r.profile);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPhoto(null);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await (
        await client()
      ).me.updateProfile({
        displayName: displayName.trim(),
        bio,
        mode,
        isPrivate,
        ...(locale !== initialLocale ? { locale } : {}),
        accent,
        headerStyle: header,
        pronouns: pronouns.trim() || null,
        city: city.trim() || null,
        links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })).filter((l) => l.label || l.url),
        tabs: tabOrder.filter((x) => tabsShown.has(x)),
        featuredPostIds: featured.map((p) => p.id),
        ...(songChanged ? { song: song ? musicInput(song) : null } : {}),
      });
      await refresh();
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      form.toTop();
    } finally {
      setBusy(false);
    }
  }

  if (!me || !profile) return error ? <Notice tone="danger">{error}</Notice> : <Loading />;

  return (
    <KeyboardAvoid>
      <ScrollView
        ref={form.ref}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Card style={{ alignItems: 'center', gap: space[3] }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('settings.changePhoto')} onPress={() => void changePhoto()} disabled={!!photo}>
            <Avatar name={displayName || profile.displayName} url={photo ? null : profile.avatarUrl} size={96} />
            {photo ? (
              <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
                <ActivityIndicator color={c.yapi} />
              </View>
            ) : null}
          </Pressable>
          {photo ? (
            <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
              {t('m.cover.uploading', { progress: number(photo.progress, { style: 'percent' }) })}
            </Text>
          ) : (
            <Button label={t('settings.changePhoto')} variant="secondary" size="sm" icon="camera-outline" onPress={() => changePhoto()} />
          )}
        </Card>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Card style={{ gap: space[3] }}>
          <Field label={t('auth.displayName')} value={displayName} onChangeText={setDisplayName} maxLength={60} autoCapitalize="words" />
          {fields.displayName ? <Text style={{ color: c.danger, fontSize: 13 }}>{fields.displayName}</Text> : null}
          <Field
            label={t('settings.bio')}
            value={bio}
            onChangeText={setBio}
            maxLength={300}
            multiline
            style={{ minHeight: 96, paddingTop: space[2], textAlignVertical: 'top' }}
          />
          <Text style={{ color: c.inkMuted, fontSize: 12, alignSelf: 'flex-end' }}>{t('m.profileEdit.count', { count: bio.length, max: 300 })}</Text>
          {fields.bio ? <Text style={{ color: c.danger, fontSize: 13 }}>{fields.bio}</Text> : null}
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title>{t('settings.profileType')}</Title>
          <ChipRow radios label={t('settings.profileType')}>
            {PROFILE_MODES.map((m) => (
              <Chip key={m} radio label={t(`settings.mode.${m}` as MessageKey)} selected={mode === m} onPress={() => setMode(m)} />
            ))}
          </ChipRow>
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title sub={t('m.profileEdit.languageHint')}>{t('settings.language')}</Title>
          <ChipRow radios label={t('settings.language')}>
            {SUPPORTED_LOCALES.map((l) => (
              <Chip key={l} radio label={languageName(l, l)} selected={locale === l} onPress={() => setLocale(l)} />
            ))}
          </ChipRow>
        </Card>

        <Card>
          <SwitchRow label={t('settings.private')} hint={t('settings.privateHint')} value={isPrivate} onValueChange={setIsPrivate} />
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title sub={t('ps.edit.desc')}>{t('ps.style.title')}</Title>
          <StyleEditor profile={profile} accent={accent} onAccent={setAccent} header={header} onHeader={setHeader} pronouns={pronouns} />
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title>{t('ps.about')}</Title>
          <Field
            label={t('ps.pronouns')}
            hint={t('ps.pronouns.hint')}
            value={pronouns}
            onChangeText={setPronouns}
            maxLength={PRONOUNS_MAX}
            autoCapitalize="none"
            error={fields.pronouns}
          />
          <Field
            label={t('ps.city')}
            hint={t('ps.city.hint')}
            value={city}
            onChangeText={setCity}
            maxLength={CITY_MAX}
            textContentType="addressCity"
            error={fields.city}
          />
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title>{t('ps.links.title')}</Title>
          <LinksEditor links={links} onChange={setLinks} errors={fields} />
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title sub={t('ps.song.hint')}>{t('ps.song.title')}</Title>
          <MusicField
            use="post"
            value={song}
            onChange={(m) => {
              setSong(m);
              setSongChanged(true);
            }}
          />
          {fields['song.durationMs'] ? <Text style={{ color: c.danger, fontSize: 13 }}>{fields['song.durationMs']}</Text> : null}
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title>{t('ps.tabs.title')}</Title>
          <TabsEditor
            order={tabOrder}
            shown={tabsShown}
            onChange={(o, sh) => {
              setTabOrder(o);
              setTabsShown(sh);
            }}
          />
        </Card>

        <Card style={{ gap: space[3] }}>
          <Title>{t('ps.featured.title')}</Title>
          <FeaturedEditor username={me.username} value={featured} onChange={setFeatured} error={fields.featuredPostIds} tint={tint} />
        </Card>

        <Button label={busy ? t('m.common.saving') : t('settings.saveProfile')} disabled={busy || !displayName.trim()} onPress={() => save()} />
      </ScrollView>
    </KeyboardAvoid>
  );
}
