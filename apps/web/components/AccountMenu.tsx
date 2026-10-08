'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, BottomSheet, Button, Dialog, Icon, type IconName } from '@yapilapi/design-system';
import type { BrowserAccount } from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { homeFor, startAs, switchAccount } from '@/lib/accounts';
import { currentSubscription, disableBrowserPush } from '@/lib/push';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { useSession } from '@/app/providers';

/** Waits for a step that tidies up (notifications), but never long: logging out must not hang on it. */
const briefly = (p: Promise<unknown>) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);

type Asking = { kind: 'current'; others: number } | { kind: 'all' } | { kind: 'other'; account: BrowserAccount };

/**
 * Logging out, after asking:
 * - `ask`: the account in use ("Log out of YAPILAPI?"). When other accounts are signed in on this
 *   browser, the next one takes over; otherwise the login page opens with "You're logged out."
 * - `askAll`: every account on this browser.
 * - `askOne`: another account on this browser; the one in use stays.
 * This browser stops getting notifications for an account that leaves. A full page load
 * afterwards, so nothing from the account stays in memory.
 */
export function useLogout() {
  const { me, t, toast } = useSession();
  const path = usePathname();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const signedOut = () => location.replace('/login?loggedOut=1');
  const logout = async () => {
    if (!asking) return;
    setBusy(true);
    if (asking.kind === 'other') {
      await api.auth.logoutAccount(asking.account.id).then(
        () => toast(t('acct.loggedOut')),
        (e) => toast(errorMessage(e)),
      );
      setBusy(false);
      setAsking(null);
      return;
    }
    if (asking.kind === 'all') {
      await briefly(disableBrowserPush());
      await api.auth.logoutAllAccounts().catch(() => {});
      return signedOut();
    }
    // The leaving account stops getting this browser's notifications while it can still say so.
    const sub = await currentSubscription().catch(() => null);
    if (sub) await briefly(api.push.unsubscribe(sub.endpoint));
    const r = me ? await api.auth.logoutAccount(me.id).catch(() => null) : null;
    // Another account signed in here takes over (and gets this browser's notifications).
    if (r?.current) return startAs(homeFor(path));
    if (!r) await api.auth.logout().catch(() => {});
    if (sub) await sub.unsubscribe().catch(() => {});
    signedOut();
  };
  const title =
    asking?.kind === 'all'
      ? t('acct.logoutAll')
      : asking?.kind === 'other'
        ? t('acct.logoutOne', { username: asking.account.username })
        : t('acct.logout.title');
  const body =
    asking?.kind === 'other'
      ? t('acct.logout.bodyAccount', { username: asking.account.username })
      : asking?.kind === 'current' && asking.others > 0 && me
        ? t('acct.logout.bodyAccount', { username: me.username })
        : t('acct.logout.body');
  // In <body>: the rail is its own stacking layer, and the page would otherwise cover the dialog.
  const dialog =
    !asking || typeof document === 'undefined'
      ? null
      : createPortal(
          <Dialog
            open
            onClose={() => !busy && setAsking(null)}
            title={title}
            footer={
              <>
                <Button variant="secondary" disabled={busy} onClick={() => setAsking(null)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="danger" icon="logout" loading={busy} onClick={logout}>
                  {t('auth.logout')}
                </Button>
              </>
            }
          >
            <p style={{ margin: 0 }}>{body}</p>
          </Dialog>,
          document.body,
        );
  return {
    /** `others`: how many other accounts are signed in here, when the caller knows (otherwise it is asked). */
    ask: (others?: unknown) => {
      if (typeof others === 'number') return setAsking({ kind: 'current', others });
      setAsking({ kind: 'current', others: 0 });
      api.auth.accounts().then(
        (r) => setAsking((a) => (a?.kind === 'current' ? { kind: 'current', others: r.items.filter((x) => !x.current).length } : a)),
        () => {},
      );
    },
    askAll: () => setAsking({ kind: 'all' }),
    askOne: (account: BrowserAccount) => setAsking({ kind: 'other', account }),
    dialog,
  };
}

type Logout = ReturnType<typeof useLogout>;

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
 * The other accounts signed in on this browser: tap one to switch to it (the page starts again as
 * it, in Yap mode when you were there), log out of one, or add one (the login page in add-account
 * mode), up to the most a browser keeps. Each shows its unread notifications.
 */
function OtherAccounts({ onClose, logout, onLoaded }: { onClose: () => void; logout: Logout; onLoaded: (others: number) => void }) {
  const { me, t, toast } = useSession();
  const path = usePathname();
  const [list, setList] = useState<{ items: BrowserAccount[]; max: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    let live = true;
    api.auth.accounts().then(
      (r) => {
        if (!live) return;
        setList(r);
        loaded.current(r.items.filter((a) => !a.current).length);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (!me) return null;
  const others = (list?.items ?? []).filter((a) => a.id !== me.id && !a.current);
  const max = list?.max ?? 5;
  const full = (list?.items.length ?? 1) >= max;
  const home = homeFor(path);
  const addHref = `/login?add=1&next=${encodeURIComponent(home)}`;
  const go = async (a: BrowserAccount) => {
    setBusy(a.id);
    try {
      await switchAccount(a.id, home);
    } catch (e) {
      setBusy(null);
      // Its session ended (logged out elsewhere, a new password): it has left the list, so log in to it again.
      if (e instanceof ApiError && e.status === 404) {
        onClose();
        location.assign(addHref);
      } else toast(errorMessage(e));
    }
  };
  return (
    <div className="account-menu__accounts">
      {others.map((a) => (
        <div key={a.id} className="account-menu__account">
          <button
            type="button"
            className="account-menu__switch"
            aria-label={
              a.unread
                ? `${t('acct.switchTo', { username: a.username })}, ${t('home.notificationsUnread', { count: a.unread })}`
                : t('acct.switchTo', { username: a.username })
            }
            aria-busy={busy === a.id || undefined}
            disabled={!!busy}
            onClick={() => void go(a)}
          >
            <Avatar name={a.displayName} src={a.avatarUrl} size="sm" />
            <span className="account-menu__names">
              <bdi className="account-menu__name">{a.displayName}</bdi>
              <span className="account-menu__handle">@{a.username}</span>
            </span>
            {a.unread ? (
              <span className="account-menu__unread" aria-hidden>
                {a.unread > 99 ? '99+' : a.unread}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="account-menu__logout-one"
            aria-label={t('acct.logoutOne', { username: a.username })}
            disabled={!!busy}
            onClick={() => {
              onClose();
              logout.askOne(a);
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      ))}
      {full ? (
        <p className="account-menu__note">{t('acct.maxBrowser', { count: max })}</p>
      ) : (
        <Link href={addHref} className="yp-menu__item account-menu__add" onClick={onClose}>
          <Icon name="user-plus" />
          {t('acct.add')}
        </Link>
      )}
    </div>
  );
}

/**
 * What the account menu holds: who you are and the other accounts on this browser (switch, add,
 * log out of one), then View profile, Settings, Saved, Drafts, Communities, Squads, Tickets, Your drops, Your mixes, Appearance,
 * Language, Help and legal, Log out, and Log out of all accounts when there are others. `onClose`
 * runs when a link is followed.
 */
function AccountMenuBody({ onClose, logout }: { onClose: () => void; logout: Logout }) {
  const { me, t } = useSession();
  const [others, setOthers] = useState(0);
  if (!me) return null;
  const links: { href: string; icon: IconName; label: string }[] = [
    { href: `/u/${me.username}`, icon: 'user', label: t('acct.viewProfile') },
    { href: '/settings', icon: 'settings', label: t('settings.title') },
    { href: '/saved', icon: 'bookmark', label: t('m.saved.title') },
    { href: '/drafts', icon: 'edit', label: t('m.drafts.title') },
    { href: '/communities', icon: 'users', label: t('communities.title') },
    { href: '/squads', icon: 'users', label: t('squads.title') },
    { href: '/tickets', icon: 'ticket', label: t('tickets.title') },
    { href: '/drops', icon: 'bag', label: t('m.drops.yours') },
    { href: '/mixes', icon: 'mix', label: t('mixes.yours') },
    { href: '/market/mine', icon: 'bag', label: t('market.yours') },
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
      <OtherAccounts onClose={onClose} logout={logout} onLoaded={setOthers} />
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
              logout.ask(others);
            }}
          >
            <Icon name="logout" />
            {t('auth.logout')}
          </button>
        </li>
        {others > 0 ? (
          <li>
            <button
              type="button"
              className="yp-menu__item yp-menu__item--danger"
              onClick={() => {
                onClose();
                logout.askAll();
              }}
            >
              <Icon name="logout" />
              {t('acct.logoutAll')}
            </button>
          </li>
        ) : null}
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
          <AccountMenuBody onClose={() => setOpen(false)} logout={logout} />
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
        <AccountMenuBody onClose={() => setOpen(false)} logout={logout} />
      </BottomSheet>
      {logout.dialog}
    </div>
  );
}

/**
 * Yap mode's bar: your avatar, opening the account menu as a sheet, so you can switch accounts
 * (and stay in Yap mode) without going back to YAPILAPI first.
 */
export function YapAccountButton() {
  const { me, t } = useSession();
  const [open, setOpen] = useState(false);
  const logout = useLogout();
  if (!me) return null;
  return (
    <>
      <button
        type="button"
        className="yap-mode__account"
        aria-haspopup="dialog"
        aria-label={t('acct.open', { name: me.displayName })}
        onClick={() => setOpen(true)}
      >
        <Avatar name={me.displayName} src={me.avatarUrl} size="sm" />
      </button>
      {/* In <body>: the bar's blurred backdrop would otherwise hold the sheet inside the bar. */}
      {open
        ? createPortal(
            <BottomSheet open onClose={() => setOpen(false)} title={t('acct.menu')}>
              <AccountMenuBody onClose={() => setOpen(false)} logout={logout} />
            </BottomSheet>,
            document.body,
          )
        : null}
      {logout.dialog}
    </>
  );
}
