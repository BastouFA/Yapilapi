'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Avatar, Button } from '@yapilapi/design-system';
import { t as translate } from '@yapilapi/shared';
import { useLogout } from '@/components/AccountMenu';
import { GROUPS, legacySettingsHref, SECTIONS, SETTINGS } from '@/components/settings/catalog';
import { SettingsLink } from '@/components/settings/Shell';
import { useSession } from '../../providers';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0';

/** Lowercase without accents, so "securite" finds "Sécurité". */
const fold = (s: string, locale: string) => s.toLocaleLowerCase(locale).normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Settings home: who you are, a search box that finds any setting by name, then every section
 * in groups (each opens its own page), and Log out at the bottom. Links to the old tabbed page
 * (?tab=… or #…) open the matching section.
 */
export default function SettingsHome() {
  const { me, t, tp, locale } = useSession();
  const router = useRouter();
  const logout = useLogout();
  const [query, setQuery] = useState('');

  useEffect(() => {
    document.title = `${t('settings.title')} · YAPILAPI`;
  }, [t]);

  useEffect(() => {
    const to = legacySettingsHref(new URLSearchParams(location.search).get('tab'), location.hash);
    if (to) router.replace(to);
  }, [router]);

  const results = useMemo(() => {
    const q = fold(query.trim(), locale);
    if (!q) return null;
    const hit = (key: Parameters<typeof t>[0]) => fold(t(key), locale).includes(q) || fold(translate(key, 'en'), 'en').includes(q);
    const seen = new Set<string>();
    const out: { href: string; title: string; desc: string; icon: (typeof SECTIONS)[keyof typeof SECTIONS]['icon'] }[] = [];
    const add = (href: string, title: string, desc: string, icon: (typeof SECTIONS)[keyof typeof SECTIONS]['icon']) => {
      if (seen.has(`${href}|${title}`)) return;
      seen.add(`${href}|${title}`);
      out.push({ href, title, desc, icon });
    };
    for (const s of Object.values(SECTIONS)) if (hit(s.title) || hit(s.desc)) add(`/settings/${s.id}`, t(s.title), t(s.desc), s.icon);
    for (const e of SETTINGS)
      if (hit(e.label)) add(`/settings/${e.section}${e.anchor ? `#${e.anchor}` : ''}`, t(e.label), t(SECTIONS[e.section].title), SECTIONS[e.section].icon);
    return out;
  }, [query, locale, t]);

  if (!me) return null;
  const plusUntil = me.plusUntil ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(me.plusUntil)) : null;

  return (
    <div className="yp-shell__inner settings-home">
      <div className="yp-topbar">
        <h1>{t('settings.title')}</h1>
      </div>

      <section className="settings-me" aria-label={t('acct.menu')}>
        <Avatar name={me.displayName} src={me.avatarUrl} size="lg" />
        <div className="settings-me__names">
          <bdi className="settings-me__name">{me.displayName}</bdi>
          <span className="muted">@{me.username}</span>
        </div>
        <div className="settings-me__actions">
          <Link href={`/u/${me.username}`} className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('acct.viewProfile')}
          </Link>
          <Link href="/settings/account" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('profile.edit')}
          </Link>
        </div>
      </section>

      <form role="search" className="settings-search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="settings-search" className="yp-visually-hidden">
          {t('st.search.label')}
        </label>
        <input
          id="settings-search"
          className="yp-search settings-search__input"
          type="search"
          autoComplete="off"
          placeholder={t('st.search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </form>

      {results ? (
        <section className="settings-group" aria-labelledby="settings-results">
          <h2 id="settings-results" className="settings-group__title">
            {t('st.search.results')}
          </h2>
          <p className="yp-visually-hidden" aria-live="polite">
            {results.length ? tp('st.search.count', results.length) : t('st.search.none', { query: query.trim() })}
          </p>
          {results.length ? (
            <div className="settings-group__rows">
              {results.map((r) => (
                <SettingsLink key={`${r.href}|${r.title}`} href={r.href} icon={r.icon} title={r.title} desc={r.desc} />
              ))}
            </div>
          ) : (
            <p className="muted settings-empty">{t('st.search.none', { query: query.trim() })}</p>
          )}
        </section>
      ) : (
        GROUPS.map((g) => (
          <section key={g.title} className="settings-group" aria-labelledby={`settings-group-${g.title}`}>
            <h2 id={`settings-group-${g.title}`} className="settings-group__title">
              {t(g.title)}
            </h2>
            <div className="settings-group__rows">
              {g.sections.map((id) => {
                const s = SECTIONS[id];
                return <SettingsLink key={id} href={`/settings/${id}`} icon={s.icon} title={t(s.title)} desc={t(s.desc)} />;
              })}
              {g.title === 'st.group.more' ? (
                <>
                  <SettingsLink
                    href="/plus"
                    icon="sparkle"
                    title={t('plus.title')}
                    desc={plusUntil ? t('plus.status.active', { date: plusUntil }) : t('plus.status.none')}
                  />
                  <SettingsLink href="/invite" icon="users" title={t('invite.title')} desc={t('plus.inviteHint')} />
                  <SettingsLink href="/developers" icon="link" title={t('settings.dev.title')} desc={t('settings.dev.subtitle')} external />
                  {/* The moderation console, for the people who work in it (the server checks the role on every call). */}
                  {me?.role === 'admin' || me?.role === 'moderator' ? (
                    <SettingsLink href="/admin" icon="shield" title={t('m.role.admin')} desc={t('admin.settingsDesc')} />
                  ) : null}
                </>
              ) : null}
            </div>
          </section>
        ))
      )}

      <div className="settings-foot">
        <Button variant="secondary" icon="logout" block onClick={logout.ask}>
          {t('auth.logout')}
        </Button>
        <p className="muted settings-foot__version">
          {t('st.about.web')} · {t('st.about.version', { version: VERSION })}
        </p>
      </div>
      {logout.dialog}
    </div>
  );
}
