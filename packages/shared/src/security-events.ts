import type { MessageKey } from './i18n-core.ts';

/**
 * What each security event (GET /v1/auth/security-events) is called in Settings > Security, web
 * and phone. Types without an entry show as "Account activity".
 */
export const SECURITY_EVENT_KEYS: Record<string, MessageKey> = {
  login: 'st.event.login',
  login_failed: 'st.event.login_failed',
  login_throttled: 'st.event.login_throttled',
  login_password_ok_mfa_pending: 'st.event.login_pending',
  password_changed: 'st.event.password_changed',
  password_reset: 'st.event.password_reset',
  password_reset_requested: 'st.event.password_reset_requested',
  mfa_enabled: 'st.event.mfa_enabled',
  mfa_disabled: 'st.event.mfa_disabled',
  mfa_failed: 'st.event.mfa_failed',
  mfa_locked: 'st.event.mfa_locked',
  mfa_recovery_codes_regenerated: 'st.event.mfa_recovery_codes_regenerated',
  passkey_added: 'st.event.passkey_added',
  passkey_removed: 'st.event.passkey_removed',
  passkey_failed: 'st.event.passkey_failed',
  phone_verified: 'st.event.phone_verified',
  phone_removed: 'st.event.phone_removed',
  sessions_revoked: 'st.event.sessions_revoked',
  session_revoked: 'st.event.session_revoked',
  account_created: 'st.event.account_created',
  email_verified: 'st.event.email_verified',
  username_changed: 'st.event.username_changed',
  sign_in_alerts_on: 'st.event.sign_in_alerts_on',
  sign_in_alerts_off: 'st.event.sign_in_alerts_off',
};

/** Events that deserve a second look (shown with a warning icon). */
export const SECURITY_EVENT_WARNINGS = new Set(['login_failed', 'login_throttled', 'mfa_failed', 'mfa_locked', 'passkey_failed']);
