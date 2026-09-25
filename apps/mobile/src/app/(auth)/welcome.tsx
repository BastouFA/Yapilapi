import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { useI18n } from '../../i18n';
import { LOCALES, LOCALE_NAMES } from '../../i18n/core';
import { usePrefs } from '../../prefs';
import { AppText, Button, Chip, Screen } from '../../ui';

export default function Welcome() {
  const th = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const { setPrefs } = usePrefs();
  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} scroll>
      <View style={{ paddingTop: th.space[12], gap: th.space[3] }}>
        <AppText variant="display" tone="primary" header accessibilityLabel={t('app.name')}>
          {t('app.name')}
        </AppText>
        <AppText variant="title">{t('app.tagline')}</AppText>
        <AppText variant="body" tone="muted">
          {t('welcome.subtitle')}
        </AppText>
      </View>
      <View style={{ marginTop: th.space[12], gap: th.space[3] }}>
        <Button label={t('welcome.create')} block onPress={() => router.push('/signup')} />
        <Button
          label={t('welcome.signIn')}
          variant="secondary"
          block
          onPress={() => router.push('/login')}
        />
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('language.language')}
        style={{
          marginTop: th.space[10],
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: th.space[2],
        }}
      >
        {LOCALES.map((l) => (
          <Chip
            key={l}
            label={LOCALE_NAMES[l]}
            selected={l === locale}
            onPress={() => setPrefs({ locale: l })}
          />
        ))}
      </View>
    </Screen>
  );
}
