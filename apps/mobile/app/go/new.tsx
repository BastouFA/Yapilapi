import { useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { PlanForm, type PlanTarget } from '../../lib/plans';
import { space } from '../../lib/theme';
import { EmptyState, KeyboardAvoid, useColors } from '../../lib/ui';

const LINKED_KINDS: readonly string[] = ['place', 'event', 'stash'];

/**
 * Make a plan (docs/product/go-out-together.md): what, when, where, details and who to invite. From
 * Wander the place comes as `place=event:<id>` with its `name`; from "Who's free", the friend as `with`.
 */
export default function NewPlan() {
  const c = useColors();
  const { t } = useT();
  const on = useFlag('GO_OUT') !== false;
  const params = useLocalSearchParams<{ place?: string; name?: string; with?: string; title?: string }>();
  if (!on) return <EmptyState title={t('plans.title')} icon="calendar-outline" />;
  const [kind, id] = (params.place ?? '').split(':');
  const linked = kind && id && LINKED_KINDS.includes(kind) ? { kind: kind as PlanTarget['kind'], id, name: params.name || null } : null;
  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <PlanForm linked={linked} withId={params.with || null} title={params.title || null} />
      </ScrollView>
    </KeyboardAvoid>
  );
}
