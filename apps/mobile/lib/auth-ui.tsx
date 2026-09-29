import { router } from 'expo-router';
import { useState, type ReactNode, type Ref } from 'react';
import { Pressable, ScrollView, type TextInput, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '../../../packages/api-client/src/index';
import type { Me } from '../../../packages/shared/src/types';
import type { Translate } from './locale';
import { space } from './theme';
import { Field, Icon, KeyboardAvoid, useColors } from './ui';
import { followActiveAccount } from './push';

/** The scrolling, keyboard-aware page the sign-up, log-in and reset screens share. */
export function AuthPage({ children }: { children: ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space[6], paddingBottom: insets.bottom + space[8], gap: space[4], maxWidth: 520, width: '100%', alignSelf: 'center' }}
      >
        {children}
      </ScrollView>
    </KeyboardAvoid>
  );
}

/** A password field with a button to show or hide what was typed. */
export function PasswordField({
  t,
  ref,
  ...props
}: TextInputProps & { label: string; t: Translate; hint?: string; error?: string | null; ref?: Ref<TextInput> }) {
  const c = useColors();
  const [shown, setShown] = useState(false);
  return (
    <Field
      {...props}
      ref={ref}
      secureTextEntry={!shown}
      autoCapitalize="none"
      autoCorrect={false}
      end={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={shown ? t('m.auth.hidePassword') : t('m.auth.showPassword')}
          onPress={() => setShown((v) => !v)}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={shown ? 'eye-off-outline' : 'eye-outline'} size={20} color={c.inkMuted} />
        </Pressable>
      }
    />
  );
}

/**
 * After signing up or logging in: close the welcome screens and open the app (onboarding first
 * for a new account). `enter` (from the session) puts the account in use as the API returned it,
 * so a check that fails right after (offline) can't leave the previous account showing.
 */
export async function enterApp(user: Me, enter: (user: Me) => Promise<void>) {
  await enter(user);
  // This phone's notifications now go to the account just logged in to.
  void followActiveAccount();
  if (router.canDismiss()) router.dismissAll();
  router.replace(user.onboarded ? '/' : '/onboarding');
}

/**
 * What went wrong, in the app's language where we know the case, with the fields to point at.
 * Other API messages are shown as they come.
 */
export function authProblem(e: unknown, t: Translate, twoStep = false): { message: string; fields: Record<string, string> } {
  if (!(e instanceof ApiError)) return { message: e instanceof Error && e.message ? e.message : t('error.generic'), fields: {} };
  if (e.code === 'network') return { message: t('error.network'), fields: {} };
  // Too many wrong passwords for the account, or wrong codes for this sign-in: the server says what to do (in the reader's language).
  if (e.status === 429) return { message: e.code === 'too_many_attempts' ? e.message : t('m.auth.tooMany'), fields: {} };
  const f = e.fields ?? {};
  const fields: Record<string, string> = {};
  if (f.email) fields.email = e.status === 409 ? t('m.auth.emailTaken') : t('m.auth.emailInvalid');
  if (f.username) fields.username = e.status === 409 ? t('m.auth.usernameTaken') : t('m.auth.usernameRule');
  if (f.password) fields.password = t('auth.password.hint');
  if (f.birthDate) fields.birthDate = e.status === 403 ? t('m.auth.tooYoung') : t('auth.birthDate.required');
  if (f.inviteCode) fields.inviteCode = t('m.auth.inviteInvalid');
  if (f.code) fields.code = t('m.auth.codeWrong');
  if (f.displayName) fields.displayName = t('m.auth.nameNeeded');
  const first = Object.values(fields)[0];
  // On the code step a 401 means the sign-in expired (the message is translated, so it can't be matched on).
  if (e.status === 401) return { message: twoStep ? t('m.auth.challengeExpired') : t('m.auth.wrongPassword'), fields };
  if (e.code === 'under_minimum_age') return { message: t('m.auth.tooYoung'), fields };
  if (e.status === 403) return { message: e.message, fields };
  return { message: first ?? e.message ?? t('error.generic'), fields };
}

/** Letters, numbers, dots and underscores, 3 to 30 of them (the API's rule). */
export const USERNAME_RE = /^[a-z0-9_.]{3,30}$/i;

/** A username suggested from a name: "Ada Obi" → "ada.obi". */
export function usernameFrom(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '')
    .slice(0, 30);
}

/** YYYY-MM-DD for a date picked on the phone (local calendar day). */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
