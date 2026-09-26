'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Avatar } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api } from '@/lib/api';

export type PersonSuggestion = { user: PublicUser; relation: 'friend' | 'following' | null; canMessage: boolean; canTag: boolean };

/**
 * Pick people with suggestions as you type. Before typing it offers your
 * friends, people you follow and recent chats; each letter narrows it down.
 * Keyboard: arrows move, Enter adds, Backspace on an empty field removes the
 * last person. By default people you can't message yet are shown but can't be
 * added; `canPick` and `unavailable` change that for other uses.
 */
export function PeoplePicker({
  picked,
  onChange,
  label = 'Add people',
  hint,
  scope,
  max,
  canPick = (s) => s.canMessage,
  unavailable = 'You can message them once you are friends',
  exclude,
}: {
  /** People not to suggest (already added elsewhere). */
  exclude?: string[];
  picked: PublicUser[];
  onChange: (p: PublicUser[]) => void;
  label?: string;
  hint?: string;
  /** Which people to suggest (see api.people.suggest). */
  scope?: 'all' | 'followers' | 'mutuals';
  /** At most this many people. */
  max?: number;
  canPick?: (s: PersonSuggestion) => boolean;
  /** Shown after a person who can't be picked. */
  unavailable?: string;
}) {
  const id = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PersonSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const req = useRef(0);
  const full = max !== undefined && picked.length >= max;

  useEffect(() => {
    if (!open || full) return;
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        api.people.suggest(q.trim(), 8, scope).then(
          (r) => n === req.current && (setItems(r.items), setActive(0)),
          () => {},
        ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, open, scope, full]);

  const shown = full ? [] : items.filter((s) => !picked.some((p) => p.id === s.user.id) && !exclude?.includes(s.user.id));
  const add = (s: PersonSuggestion | undefined) => {
    if (!s || !canPick(s) || full) return;
    onChange([...picked, s.user]);
    setQ('');
  };

  return (
    <div className="picker">
      <label htmlFor={`${id}-input`} className="yp-field__label">
        {label}
      </label>
      <div className="picker__box" onClick={() => document.getElementById(`${id}-input`)?.focus()}>
        {picked.map((p) => (
          <button
            key={p.id}
            type="button"
            className="yp-chip"
            onClick={(e) => {
              e.stopPropagation();
              onChange(picked.filter((x) => x.id !== p.id));
            }}
            aria-label={`Remove ${p.displayName}`}
          >
            <bdi>{p.displayName}</bdi> ×
          </button>
        ))}
        <input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open && shown.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${id}-opt-${active}` : undefined}
          aria-describedby={hint || full ? `${id}-hint` : undefined}
          autoComplete="off"
          value={q}
          readOnly={full}
          placeholder={full ? '' : picked.length ? '' : 'Type a name or username'}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, Math.max(0, shown.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              if (open && shown[active]) {
                e.preventDefault();
                add(shown[active]);
              }
            } else if (e.key === 'Escape') {
              setOpen(false);
            } else if (e.key === 'Backspace' && !q && picked.length) {
              onChange(picked.slice(0, -1));
            }
          }}
        />
      </div>
      {hint || full ? (
        <span id={`${id}-hint`} className="yp-field__hint">
          {full ? `That's the most you can add (${max}). ` : ''}
          {hint}
        </span>
      ) : null}
      {open && shown.length ? (
        <ul id={`${id}-list`} role="listbox" className="picker__list" aria-label="Suggestions">
          {shown.map((s, i) => (
            <li
              key={s.user.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={!canPick(s)}
              className="picker__option"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
            >
              <Avatar name={s.user.displayName} src={s.user.avatarUrl} size="sm" />
              <span className="picker__text">
                <bdi className="picker__name">{s.user.displayName}</bdi>
                <span className="picker__meta">
                  <bdi>@{s.user.username}</bdi>
                  {s.relation === 'friend' ? ' · Friend' : s.relation === 'following' ? ' · You follow' : ''}
                  {!canPick(s) ? ` · ${unavailable}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : open && q.trim() && !full ? (
        <p className="muted" role="status" style={{ margin: 0, fontSize: 13 }}>
          Nobody matches &ldquo;{q.trim()}&rdquo;.
        </p>
      ) : null}
    </div>
  );
}
