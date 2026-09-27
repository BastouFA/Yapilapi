import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { MAX_CIRCLES, type CircleKind } from '../../../packages/shared/src/constants';
import type { Circle } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { CIRCLE_NAME_MAX, KindPicker } from '../lib/circles';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Button, Card, Field, Icon, KeyboardAvoid, Loading, Notice, Row, Title, useColors } from '../lib/ui';

/**
 * Circles: your own small groups (family, work, a trip) to share a post with. Only you see
 * them, and nobody is told which circles they're in.
 */
export default function Circles() {
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const [list, setList] = useState<Circle[] | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CircleKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reload when coming back from a circle (renamed, deleted, people added).
  useFocusEffect(
    useCallback(() => {
      client()
        .then((api) => api.circles.list())
        .then(
          (r) => setList(r.items),
          (e) => {
            setList((cur) => cur ?? []);
            setError(errorMessage(e));
          },
        );
    }, []),
  );

  if (me === undefined || list === null) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { circle } = await (await client()).circles.create({ name: name.trim(), ...(kind ? { kind } : {}) });
      setList((cur) => [circle, ...(cur ?? [])]);
      setName('');
      setKind(null);
      router.push({ pathname: '/circle/[id]', params: { id: circle.id } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const full = list.length >= MAX_CIRCLES;

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Title sub={t('m.circles.hint')}>{t('m.circles.title')}</Title>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
            {t('m.circles.new')}
          </Text>
          {full ? (
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.circles.limit', { max: MAX_CIRCLES })}</Text>
          ) : (
            <>
              <Field
                label={t('m.circles.name')}
                placeholder={t('m.circles.namePlaceholder')}
                value={name}
                onChangeText={setName}
                maxLength={CIRCLE_NAME_MAX}
                returnKeyType="done"
              />
              <KindPicker value={kind} onChange={setKind} />
              <Button label={t('m.circles.create')} disabled={busy || !name.trim()} onPress={() => create()} />
            </>
          )}
        </Card>
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
            {t('m.circles.yours')}
          </Text>
          {list.length ? (
            list.map((x) => (
              <Row
                key={x.id}
                title={x.name}
                subtitle={`${t(`m.circles.kind.${x.kind}`)} · ${tp('m.circles.members', x.memberCount)}`}
                start={<Icon name="ellipse-outline" size={18} color={c.yapi} />}
                end={<Icon name="chevron-forward" size={18} color={c.inkMuted} directional />}
                onPress={() => router.push({ pathname: '/circle/[id]', params: { id: x.id } })}
              />
            ))
          ) : (
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.circles.empty')}</Text>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoid>
  );
}
