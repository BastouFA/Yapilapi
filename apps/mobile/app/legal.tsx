import { ScrollView, Text } from 'react-native';
import { LEGAL_DOCS } from '../../../packages/shared/src/legal';
import { useT } from '../lib/i18n';
import { openLegal } from '../lib/legal';
import { space } from '../lib/theme';
import { Icon, Row, useColors } from '../lib/ui';

/** Legal and policies: each one opens on the web, in the phone's browser. Reachable from Settings. */
export default function Legal() {
  const c = useColors();
  const { t } = useT();
  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}>
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('legal.index.body')}</Text>
      {LEGAL_DOCS.map((d) => (
        <Row
          key={d.slug}
          title={t(d.title)}
          subtitle={t('m.legal.hint')}
          start={<Icon name="document-text-outline" size={18} color={c.inkMuted} />}
          end={<Icon name="open-outline" size={18} color={c.inkMuted} />}
          onPress={() => void openLegal(d.slug)}
        />
      ))}
    </ScrollView>
  );
}
