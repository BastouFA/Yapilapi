import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { NOW_STATUS_AUDIENCES, NOW_STATUS_ICONS, NOW_STATUS_MAX, type NowStatusAudience, type NowStatusIcon } from '../../../packages/shared/src/constants';
import type { NowStatus } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { liveStatus, NOW_ICON_GLYPHS, statusChanged } from '../lib/now-status';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Button, Card, Field, Icon, KeyboardAvoid, Loading, Notice, Segmented, Title, useColors } from '../lib/ui';

/**
 * Your "Now" status: a short line (up to 60 characters) with an optional icon, for everyone,
 * your followers or your close friends. It disappears after 24 hours.
 */
export default function NowStatusScreen() {
  const c = useColors();
  const { t, dateTime } = useT();
  const { me } = useSession();
  const [current, setCurrent] = useState<NowStatus | null | undefined>(undefined);
  const [text, setText] = useState('');
  const [icon, setIcon] = useState<NowStatusIcon | null>(null);
  const [audience, setAudience] = useState<NowStatusAudience>('everyone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client()
      .then((api) => api.me.status())
      .then(
        (r) => {
          const s = liveStatus(r.status);
          setCurrent(s);
          if (s) {
            setText(s.text);
            setIcon(s.icon);
            setAudience(s.audience ?? 'everyone');
          }
        },
        (e) => {
          setCurrent(null);
          setError(errorMessage(e));
        },
      );
  }, []);

  if (me === undefined || current === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { status } = await (await client()).me.setStatus({ text: text.trim(), icon, audience });
      statusChanged(status);
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await (await client()).me.clearStatus();
      statusChanged(null);
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const length = text.length;
  const options: { id: NowStatusIcon | null; label: string }[] = [
    { id: null, label: t('m.now.noIcon') },
    ...NOW_STATUS_ICONS.map((id) => ({ id, label: t(`m.now.icon.${id}`) })),
  ];

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Title sub={t('m.now.hint')}>{t('m.now.title')}</Title>
        {current ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.now.until', { time: dateTime(current.expiresAt) })}</Text> : null}
        <Card style={{ gap: space[3] }}>
          <Field
            label={t('m.now.label')}
            placeholder={t('m.now.placeholder')}
            value={text}
            onChangeText={setText}
            maxLength={NOW_STATUS_MAX}
            returnKeyType="done"
            autoFocus={!current}
          />
          <Text
            accessibilityLabel={t('m.now.counterLabel', { count: length, max: NOW_STATUS_MAX })}
            style={{ color: length >= NOW_STATUS_MAX ? c.danger : c.inkMuted, fontSize: 12, alignSelf: 'flex-end' }}
          >
            {t('m.now.counter', { count: length, max: NOW_STATUS_MAX })}
          </Text>

          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.now.icon')}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t('m.now.icon')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {options.map((o) => {
              const on = o.id === icon;
              return (
                <Pressable
                  key={o.id ?? 'none'}
                  accessibilityRole="radio"
                  accessibilityLabel={o.label}
                  accessibilityState={{ selected: on, checked: on }}
                  onPress={() => setIcon(o.id)}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: on ? 2 : 1,
                    borderColor: on ? c.yapi : c.line,
                    backgroundColor: on ? c.yapiSoft : c.surface,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <Icon name={o.id ? NOW_ICON_GLYPHS[o.id] : 'remove-outline'} size={20} color={on ? c.yapi : c.inkMuted} />
                </Pressable>
              );
            })}
          </View>

          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.now.audience')}</Text>
          <Segmented
            label={t('m.now.audience')}
            options={NOW_STATUS_AUDIENCES.map((id) => ({ id, label: t(`m.now.audience.${id}`) }))}
            value={audience}
            onChange={setAudience}
          />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button label={busy ? t('m.common.saving') : t('common.save')} disabled={busy || !text.trim()} onPress={() => save()} />
          {current ? <Button label={t('m.now.clear')} variant="ghost" disabled={busy} onPress={() => clear()} /> : null}
        </Card>
      </ScrollView>
    </KeyboardAvoid>
  );
}
