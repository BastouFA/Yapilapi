import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { timeZoneLabel, timeZoneList } from '../../../packages/shared/src/scheduling';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Field, Icon, useColors } from './ui';

/** The phone's own time zone, or UTC when it can't say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A field showing a time zone that opens a searchable list of them. */
export function TimeZoneField({ label, value, onChange }: { label: string; value: string; onChange: (tz: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const device = deviceTimeZone();
  const all = useMemo(() => timeZoneList([device, value]), [device, value]);
  const term = q.trim().toLowerCase().replace(/\s+/g, '_');
  const shown = term ? all.filter((z) => z.toLowerCase().includes(term)) : all;
  return (
    <View style={{ gap: space[1] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${timeZoneLabel(value)}`}
        accessibilityHint={t('m.tz.openHint')}
        onPress={() => {
          setQ('');
          setOpen(true);
        }}
        style={({ pressed }) => ({
          minHeight: 44,
          borderWidth: 1,
          borderRadius: radius.md,
          borderColor: c.line,
          backgroundColor: c.surface,
          paddingHorizontal: space[3],
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Icon name="globe-outline" size={18} color={c.inkMuted} />
        <Text style={{ flex: 1, color: c.ink, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
          {timeZoneLabel(value)}
        </Text>
        <Icon name="chevron-down" size={16} color={c.inkMuted} />
      </Pressable>
      {value !== device ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.tz.notYours', { zone: timeZoneLabel(device) })}</Text> : null}
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: space[4], paddingBottom: insets.bottom }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[4], gap: space[2] }}>
            <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 18, fontWeight: '800' }}>
              {label}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.common.close')}
              onPress={() => setOpen(false)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="close" size={22} color={c.ink} />
            </Pressable>
          </View>
          <View style={{ paddingHorizontal: space[4], paddingVertical: space[2] }}>
            <Field label={t('m.tz.search')} hideLabel placeholder={t('m.tz.search')} value={q} onChangeText={setQ} autoCorrect={false} autoCapitalize="none" />
          </View>
          <FlatList
            data={shown}
            keyExtractor={(z) => z}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={30}
            renderItem={({ item }) => {
              const on = item === value;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={item === device ? t('m.tz.yours', { zone: timeZoneLabel(item) }) : timeZoneLabel(item)}
                  onPress={() => {
                    onChange(item);
                    setOpen(false);
                  }}
                  style={({ pressed }) => ({
                    minHeight: 48,
                    paddingHorizontal: space[4],
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[2],
                    backgroundColor: on ? c.yapiSoft : pressed ? c.surfaceSunken : 'transparent',
                  })}
                >
                  <Text style={{ flex: 1, color: c.ink, fontSize: 15, fontWeight: on ? '700' : '400' }}>{timeZoneLabel(item)}</Text>
                  {item === device ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.tz.phone')}</Text> : null}
                  {on ? <Icon name="checkmark" size={18} color={c.yapi} /> : null}
                </Pressable>
              );
            }}
          />
        </View>
      </Modal>
    </View>
  );
}
