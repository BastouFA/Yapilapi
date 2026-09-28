'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Avatar, Button, Card, CardHeadings, Icon, List, ListItem, type IconName } from '@yapilapi/design-system';
import type { MessageKey } from '@yapilapi/shared';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { SECTIONS, type SectionId } from './catalog';

/**
 * One settings page: a way back to Settings, the section's name and what it covers, then its
 * settings. A link to one setting (/settings/security#two-step) scrolls to it once it has loaded
 * and marks it briefly.
 */
export function SettingsPage({ section, children }: { section: SectionId; children: ReactNode }) {
  const { t } = useSession();
  const s = SECTIONS[section];
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 40) clearInterval(timer);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.classList.add('settings-target');
      setTimeout(() => el.classList.remove('settings-target'), 2400);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    document.title = `${t(s.title)} · YAPILAPI`;
  }, [s.title, t]);
  return (
    <div className="yp-shell__inner settings-page">
      <div className="yp-topbar settings-topbar">
        <div className="settings-topbar__title">
          <Link href="/settings" className="yp-action settings-back" aria-label={t('st.back')}>
            <Icon name="chevron-left" />
          </Link>
          <h1>{t(s.title)}</h1>
        </div>
      </div>
      <p className="muted settings-page__desc">{t(s.desc)}</p>
      {/* Cards sit right under the page's h1, so their titles are h2. */}
      <div className="stack">
        <CardHeadings level={2}>{children}</CardHeadings>
      </div>
    </div>
  );
}

/** A section's anchor: search results and old links point at it. */
export function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} className="settings-anchor">
      {children}
    </div>
  );
}

/** A row that opens another page: icon in a soft squircle, title, one line about it, chevron. */
export function SettingsLink({ href, icon, title, desc, external }: { href: string; icon: IconName; title: string; desc?: string; external?: boolean }) {
  const body = (
    <>
      <span className="settings-row__icon" aria-hidden>
        <Icon name={icon} />
      </span>
      <span className="settings-row__text">
        <span className="settings-row__title">{title}</span>
        {desc ? <span className="settings-row__desc">{desc}</span> : null}
      </span>
      <Icon name="chevron-right" className="settings-row__chevron" />
    </>
  );
  return external ? (
    <a href={href} className="settings-row">
      {body}
    </a>
  ) : (
    <Link href={href} className="settings-row">
      {body}
    </Link>
  );
}

/**
 * A choice among a few options, as radio buttons with a line under each where it helps.
 * Changes apply right away (the parent saves them).
 */
export function ChoiceGroup<T extends string>({
  legend,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  legend: string;
  hint?: string;
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="settings-choice" disabled={disabled}>
      <legend className="settings-choice__legend">{legend}</legend>
      {options.map((o) => (
        <label key={o.id} className="settings-choice__option">
          <input type="radio" name={name} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
          <span>
            {o.label}
            {o.hint ? <span className="settings-choice__hint">{o.hint}</span> : null}
          </span>
        </label>
      ))}
      {hint ? <p className="muted setting-hint">{hint}</p> : null}
    </fieldset>
  );
}

/**
 * People you blocked, muted or restricted, each with a button to undo it. `load` fetches them;
 * `undo` removes one (the row goes when it succeeds).
 */
export function PeopleCard({
  id,
  title,
  subtitle,
  empty,
  undoLabel,
  load,
  undo,
}: {
  id: string;
  title: MessageKey;
  subtitle?: MessageKey;
  empty: MessageKey;
  undoLabel: MessageKey;
  load: () => Promise<{ items: PublicUserLike[] }>;
  undo: (userId: string) => Promise<unknown>;
}) {
  const { t, toast } = useSession();
  const [items, setItems] = useState<PublicUserLike[] | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current().then(
      (r) => setItems(r.items),
      (e) => (setItems([]), toast(errorMessage(e))),
    );
  }, [toast]);
  return (
    <Anchor id={id}>
      <Card title={t(title)} subtitle={subtitle ? t(subtitle) : undefined}>
        {items === null ? null : items.length ? (
          <List>
            {items.map((u) => (
              <ListItem
                key={u.id}
                start={<Avatar name={u.displayName} src={u.avatarUrl} size="sm" />}
                primary={u.displayName}
                secondary={u.username ? `@${u.username}` : undefined}
                end={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await undo(u.id);
                        setItems((x) => x?.filter((y) => y.id !== u.id) ?? x);
                      } catch (e) {
                        toast(errorMessage(e));
                      }
                    }}
                  >
                    {t(undoLabel)}
                  </Button>
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t(empty)}
          </p>
        )}
      </Card>
    </Anchor>
  );
}

type PublicUserLike = { id: string; displayName: string; username?: string; avatarUrl?: string | null };
