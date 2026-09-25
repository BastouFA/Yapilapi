import React from 'react';
import { Modal, Pressable, Switch, View, ScrollView } from 'react-native';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { AppText } from './Text';
import { Button } from './Button';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

/** Single-choice tabs (feed modes, filters). Uses tab roles so screen readers announce "selected". */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<SegmentOption<V>>;
  value: V;
  onChange: (v: V) => void;
  label: string;
}) {
  const th = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        backgroundColor: th.colors.surfaceSubtle,
        borderRadius: th.radius.pill,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1,
              minHeight: th.targetMin - 6,
              borderRadius: th.radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? th.colors.surface : 'transparent',
              borderWidth: on ? 1 : 0,
              borderColor: th.colors.border,
              paddingHorizontal: th.space[2],
            }}
          >
            <AppText
              variant="label"
              tone={on ? 'default' : 'muted'}
              numberOfLines={1}
              style={on ? { fontWeight: '700' } : undefined}
            >
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Radio-style list for a setting with a few named choices. */
export function ChoiceGroup<V extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<SegmentOption<V>>;
  value: V;
  onChange: (v: V) => void;
  disabled?: boolean;
}) {
  const th = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ marginBottom: th.space[4] }}
    >
      <AppText variant="label" tone="muted" style={{ marginBottom: th.space[2] }} header>
        {label}
      </AppText>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={{
              minHeight: th.targetMin,
              flexDirection: 'row',
              alignItems: 'center',
              gap: th.space[3],
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                borderWidth: 2,
                borderColor: on ? th.colors.primary : th.colors.borderStrong,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {on ? (
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: th.colors.primary,
                  }}
                />
              ) : null}
            </View>
            <AppText variant="body">{o.label}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SwitchRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string | undefined;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const th = useTheme();
  return (
    <View
      style={{
        minHeight: th.targetMin,
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space[3],
        marginBottom: th.space[3],
      }}
    >
      <View style={{ flex: 1 }}>
        <AppText variant="bodyStrong">{label}</AppText>
        {hint ? (
          <AppText variant="caption" tone="muted">
            {hint}
          </AppText>
        ) : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={label}
        accessibilityHint={hint}
        trackColor={{ true: th.colors.primary, false: th.colors.borderStrong }}
        thumbColor={th.colors.surface}
      />
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={{
        minHeight: th.targetMin,
        paddingHorizontal: th.space[4],
        borderRadius: th.radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: selected ? th.colors.primary : th.colors.borderStrong,
        backgroundColor: selected ? th.colors.primarySoft : th.colors.surface,
      }}
    >
      <AppText
        variant="label"
        style={{ color: selected ? th.colors.onPrimarySoft : th.colors.text }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

export function Badge({ count, label }: { count: number; label?: string }) {
  const th = useTheme();
  if (count <= 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={label ?? String(count)}
      style={{
        minWidth: 20,
        height: 20,
        borderRadius: 10,
        paddingHorizontal: 5,
        backgroundColor: th.colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppText
        variant="caption"
        tone="onPrimary"
        style={{ fontSize: 11, lineHeight: 14, fontWeight: '700' }}
      >
        {count > 99 ? '99+' : String(count)}
      </AppText>
    </View>
  );
}

export interface MenuAction {
  key: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/** Bottom sheet of actions (overflow menus). Own component instead of Alert so it works on every platform and is testable. */
export function ActionMenu({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean;
  title?: string;
  actions: MenuAction[];
  onClose: () => void;
}) {
  const th = useTheme();
  const t = useT();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: th.colors.overlay, justifyContent: 'flex-end' }}
      >
        <Pressable
          accessible={false}
          style={{
            backgroundColor: th.colors.surface,
            borderTopLeftRadius: th.radius.lg,
            borderTopRightRadius: th.radius.lg,
            paddingBottom: th.space[6],
            maxHeight: '80%',
          }}
        >
          <ScrollView>
            {title ? (
              <AppText variant="heading" style={{ padding: th.space[4] }} header>
                {title}
              </AppText>
            ) : null}
            {actions.map((a) => (
              <Pressable
                key={a.key}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                onPress={() => {
                  onClose();
                  a.onPress();
                }}
                style={{
                  minHeight: th.targetMin,
                  justifyContent: 'center',
                  paddingHorizontal: th.space[4],
                }}
              >
                <AppText variant="body" tone={a.destructive ? 'danger' : 'default'}>
                  {a.label}
                </AppText>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
              onPress={onClose}
              style={{
                minHeight: th.targetMin,
                justifyContent: 'center',
                paddingHorizontal: th.space[4],
              }}
            >
              <AppText variant="body" tone="muted">
                {t('common.cancel')}
              </AppText>
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Confirmation dialog for irreversible actions. */
export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  destructive,
  loading,
  onConfirm,
  onCancel,
  children,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const th = useTheme();
  const t = useT();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <View
        style={{
          flex: 1,
          backgroundColor: th.colors.overlay,
          justifyContent: 'center',
          padding: th.space[6],
        }}
      >
        <View
          accessibilityRole="alert"
          style={{
            backgroundColor: th.colors.surface,
            borderRadius: th.radius.lg,
            padding: th.space[5],
            gap: th.space[3],
          }}
        >
          <AppText variant="heading" header>
            {title}
          </AppText>
          {body ? (
            <AppText variant="body" tone="muted">
              {body}
            </AppText>
          ) : null}
          {children}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              gap: th.space[2],
              marginTop: th.space[2],
            }}
          >
            <Button label={t('common.cancel')} variant="ghost" onPress={onCancel} />
            <Button
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              loading={loading}
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
