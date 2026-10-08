import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, ScrollView, Text, TextInput, View } from 'react-native';
import { t as translate } from '../../../../packages/shared/src/i18n-core';
import { useConfirmLogout } from '../../lib/account-menu';
import { webUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { GROUPS, SECTIONS, SETTINGS } from '../../lib/settings-catalog';
import { About, SettingsGroup, SettingsLinkRow } from '../../lib/settings-extra';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, Card, Icon, Loading, Notice, useColors, userText } from '../../lib/ui';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Settings home: who you are, a search box that finds any setting by name, the sections in
 * groups (each opens its own screen), Plus and inviting friends, the app version, and Log out at
 * the bottom (after asking).
 */
export default function SettingsHome() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const confirmLogout = useConfirmLogout();
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return null;
    const hit = (key: Parameters<typeof t>[0]) => fold(t(key)).includes(q) || fold(translate(key, 'en')).includes(q);
    const out: { key: string; title: string; desc: string; section: (typeof SECTIONS)[keyof typeof SECTIONS] }[] = [];
    const seen = new Set<string>();
    for (const s of Object.values(SECTIONS))
      if (hit(s.title) || hit(s.desc)) {
        seen.add(t(s.title));
        out.push({ key: s.id, title: t(s.title), desc: t(s.desc), section: s });
      }
    for (const e of SETTINGS)
      if (hit(e.label) && !seen.has(t(e.label))) {
        seen.add(t(e.label));
        out.push({ key: `${e.section}-${e.label}`, title: t(e.label), desc: t(SECTIONS[e.section].title), section: SECTIONS[e.section] });
      }
    return out;
  }, [query, t]);

  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }} onPress={() => router.push('/profile')} label={t('acct.viewProfile')}>
        <Avatar name={me.displayName} url={me.avatarUrl} size={56} />
        <View style={{ flex: 1 }}>
          <Text style={[{ color: c.ink, fontSize: 18, fontWeight: '800' }, userText]} numberOfLines={1}>
            {me.displayName}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 14 }} numberOfLines={1}>
            @{me.username}
          </Text>
        </View>
        <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
      </Card>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          height: 46,
          paddingHorizontal: space[3],
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: c.line,
          backgroundColor: c.surface,
        }}
      >
        <Icon name="search" size={18} color={c.inkMuted} />
        <TextInput
          accessibilityLabel={t('st.search.label')}
          placeholder={t('st.search.placeholder')}
          placeholderTextColor={c.inkMuted}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="search"
          style={{ flex: 1, color: c.ink, fontSize: 16, paddingVertical: 0 }}
        />
      </View>

      {results ? (
        <View style={{ gap: space[2] }}>
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13, marginStart: space[1] }}>
            {results.length ? t('st.search.results') : t('st.search.none', { query: query.trim() })}
          </Text>
          {results.length ? (
            <SettingsGroup>
              {results.map((r) => (
                <SettingsLinkRow key={r.key} icon={r.section.icon} title={r.title} desc={r.desc} onPress={() => router.push(r.section.href)} />
              ))}
            </SettingsGroup>
          ) : null}
        </View>
      ) : (
        <>
          {GROUPS.map((g) => (
            <SettingsGroup key={g.title} title={t(g.title)}>
              {g.sections.map((id) => {
                const s = SECTIONS[id];
                return <SettingsLinkRow key={id} icon={s.icon} title={t(s.title)} desc={t(s.desc)} onPress={() => router.push(s.href)} />;
              })}
              {g.title === 'st.group.more' ? (
                <>
                  <SettingsLinkRow icon="sparkles-outline" title={t('plus.title')} desc={t('m.plus.settingsHint')} onPress={() => router.push('/plus')} />
                  <SettingsLinkRow icon="gift-outline" title={t('invite.title')} desc={t('plus.inviteHint')} onPress={() => router.push('/invite')} />
                </>
              ) : null}
            </SettingsGroup>
          ))}
          {/* For the team: the admin console is on the web, opened in the browser (there is no console in the app). */}
          {me?.role === 'admin' || me?.role === 'moderator' ? (
            <SettingsGroup title={t('m.admin.group')}>
              <SettingsLinkRow
                icon="shield-checkmark-outline"
                title={t('m.admin.title')}
                desc={t('m.admin.desc')}
                external
                onPress={() => void Linking.openURL(`${webUrl}/admin`).catch(() => {})}
              />
            </SettingsGroup>
          ) : null}
          <About />
        </>
      )}

      <Button label={t('auth.logout')} icon="log-out-outline" variant="secondary" onPress={confirmLogout} />
    </ScrollView>
  );
}
