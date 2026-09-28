'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, BottomSheet, Button, Dialog, Icon, type IconName } from '@yapilapi/design-system';
import { api } from '@/lib/api';
import { disableBrowserPush } from '@/lib/push';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { useSession } from '@/app/providers';

/**
 * Log out, after asking: "Log out of YAPILAPI?". This browser stops getting notifications for
 * the account, the session ends, and the login page opens with "You're logged out." A full page
 * load, so nothing from the account stays in memory.
 */
export function useLogout() {
  const { t } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    setBusy(true);
    await Promise.race([disableBrowserPush().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    await api.auth.logout().catch(() => {});
    location.replace('/login?loggedOut=1');
  };
  // In <body>: the rail is its own stacking layer, and the page would otherwise cover the dialog.
  const dialog =
    !open || typeof document === 'undefined'
      ? null
      : createPortal(
          <Dialog
            open={open}
            onClose={() => !busy && setOpen(false)}
            title={t('acct.logout.title')}
            footer={
              <>
                <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="danger" icon="logout" loading={busy} onClick={logout}>
                  {t('auth.logout')}
                </Button>
              </>
            }
          >
            <p style={{ margin: 0 }}>{t('acct.logout.body')}</p>
          </Dialog>,
          document.body,
        );
  return { ask: () => setOpen(true), dialog };
}

const THEMES: { id: ThemeChoice; icon: IconName; label: 'st.appearance.light' | 'st.appearance.dark' | 'st.appearance.system' }[] = [
  { id: 'light', icon: 'sun', label: 'st.appearance.light' },
  { id: 'dark', icon: 'moon', label: 'st.appearance.dark' },
  { id: 'system', icon: 'device', label: 'st.appearance.system' },
];

/** Light, Dark or Match device, applied the moment it's picked and remembered in this browser. */
export function AppearancePicker({ compact }: { compact?: boolean }) {
  const { t } = useSession();
  const [theme, setTheme] = useTheme();
  const name = useId();
  return (
    <div role="radiogroup" aria-label={t('st.appearance.title')} className={compact ? 'theme-picker theme-picker--compact' : 'theme-picker'}>
      {THEMES.map((o) => (
        <label key={o.id} className="theme-picker__option" data-theme-option={o.id}>
          <input type="radio" name={name} value={o.id} checked={theme === o.id} onChange={() => setTheme(o.id)} />
          {compact ? null : <span className={`theme-picker__preview theme-picker__preview--${o.id}`} aria-hidden />}
          <span className="theme-picker__label">
            <Icon name={o.icon} size={18} />
            {t(o.label)}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * What the account menu holds: who you are, then View profile, Settings, Saved, Drafts, Your drops, Your mixes,
 * Appearance, Language, Help and legal, and Log out. `onClose` runs when a link is followed.
 */
function AccountMenuBody({ onClose, onLogout }: { onClose: () => void; onLogout: () => void }) {
  const { me, t } = useSession();
  if (!me) return null;
  const links: { href: string; icon: IconName; label: string }[] = [
    { href: `/u/${me.username}`, icon: 'user', label: t('acct.viewProfile') },
    { href: '/settings', icon: 'settings', label: t('settings.title') },
    { href: '/saved', icon: 'bookmark', label: t('m.saved.title') },
    { href: '/drafts', icon: 'edit', label: t('m.drafts.title') },
    { href: '/drops', icon: 'bag', label: t('m.drops.yours') },
    { href: '/mixes', icon: 'mix', label: t('mixes.yours') },
  ];
  const more: { href: string; icon: IconName; label: string }[] = [
    { href: '/settings/language', icon: 'globe', label: t('settings.language') },
    { href: '/settings/help', icon: 'help', label: t('st.help.title') },
  ];
  return (
    <div className="account-menu">
      <Link href={`/u/${me.username}`} className="account-menu__who" onClick={onClose}>
        <Avatar name={me.displayName} src={me.avatarUrl} size="md" />
        <span className="account-menu__names">
          <bdi className="account-menu__name">{me.displayName}</bdi>
          <span className="account-menu__handle">@{me.username}</span>
        </span>
      </Link>
      <ul className="account-menu__list">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="yp-menu__item" onClick={onClose}>
              <Icon name={l.icon} />
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="account-menu__section">
        <span className="account-menu__heading" id="account-menu-appearance">
          {t('st.appearance.title')}
        </span>
        <AppearancePicker compact />
      </div>
      <ul className="account-menu__list">
        {more.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="yp-menu__item" onClick={onClose}>
              <Icon name={l.icon} />
              {l.label}
            </Link>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="yp-menu__item yp-menu__item--danger"
            onClick={() => {
              onClose();
              onLogout();
            }}
          >
            <Icon name="logout" />
            {t('auth.logout')}
          </button>
        </li>
      </ul>
    </div>
  );
}

/**
 * Wide screens: your avatar, name and @username at the bottom of the side rail. It opens the
 * account menu above it; Escape or a click elsewhere closes it and focus returns to the button.
 */
export function RailAccountButton() {
  const { me, t } = useSession();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const logout = useLogout();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    wrap.current?.querySelector<HTMLElement>('.account-menu a, .account-menu button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!me) return null;
  return (
    <div className="rail-account" ref={wrap}>
      {open ? (
        <div className="rail-account__panel" id={panelId} role="dialog" aria-label={t('acct.menu')}>
          <AccountMenuBody onClose={() => setOpen(false)} onLogout={logout.ask} />
        </div>
      ) : null}
      <button
        ref={button}
        type="button"
        className="rail-account__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('acct.open', { name: me.displayName })}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={me.displayName} src={me.avatarUrl} size="sm" />
        <span className="rail-account__names">
          <bdi className="rail-account__name">{me.displayName}</bdi>
          <span className="rail-account__handle">@{me.username}</span>
        </span>
        <Icon name="more" />
      </button>
      {logout.dialog}
    </div>
  );
}

/**
 * On your own profile: Settings (a gear) and the account menu, which opens as a sheet. This is
 * how phones reach both, since the rail's account button is only on wide screens.
 */
export function ProfileAccountActions() {
  const { t } = useSession();
  const [open, setOpen] = useState(false);
  const logout = useLogout();
  return (
    <div className="profile-account-actions">
      <Link href="/settings" className="yp-action profile-account-actions__btn" aria-label={t('settings.title')}>
        <Icon name="settings" />
      </Link>
      <button type="button" className="yp-action profile-account-actions__btn" aria-haspopup="dialog" aria-label={t('acct.menu')} onClick={() => setOpen(true)}>
        <Icon name="more" />
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t('acct.menu')}>
        <AccountMenuBody onClose={() => setOpen(false)} onLogout={logout.ask} />
      </BottomSheet>
      {logout.dialog}
    </div>
  );
}
