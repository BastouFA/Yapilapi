import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../theme';
import { usePrefs } from '../prefs';
import { useT } from '../i18n';
import { initials } from '../lib/format';
import { AppText } from './Text';

/** Round avatar. In low-data mode only the initials are drawn, so no image bytes are downloaded for it. */
export function Avatar({
  name,
  uri,
  size = 40,
}: {
  name: string;
  uri?: string | null | undefined;
  size?: number;
}) {
  const th = useTheme();
  const t = useT();
  const { lowBandwidth } = usePrefs();
  const label = t('common.avatarOf', { name });
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: th.colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {uri && !lowBandwidth ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size }}
          contentFit="cover"
          cachePolicy="disk"
          recyclingKey={uri}
          accessible={false}
        />
      ) : (
        <AppText
          variant="label"
          style={{ color: th.colors.onPrimarySoft, fontSize: Math.max(12, size * 0.38) }}
        >
          {initials(name)}
        </AppText>
      )}
    </View>
  );
}
