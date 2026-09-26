'use client';

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { Avatar } from '@yapilapi/design-system';
import { api } from '@/lib/api';

type Suggestion = { key: string; insert: string; primary: string; secondary?: string; avatar?: { name: string; src: string | null } };

/** The @name or #tag being typed right before the caret, if any. */
const TOKEN = /(^|[\s(])([@#])([\p{L}\p{M}\p{N}_.]{0,30})$/u;

let trending: Promise<string[]> | null = null;
const trendingTags = () =>
  (trending ??= api.trending(30).then(
    (r) => r.items.map((x) => x.tag),
    () => ((trending = null), []),
  ));

type Common = { value: string; onValueChange: (v: string) => void };
type Props =
  | (Common & { as?: 'textarea' } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>)
  | (Common & { as: 'input' } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>);

/**
 * A text box that suggests people as you type @name (people you know first)
 * and tags as you type #tag (from what's trending). Arrow keys move, Enter or
 * Tab picks, Escape closes.
 */
export function AutocompleteText(props: Props) {
  const {
    value,
    onValueChange,
    as = 'textarea',
    onKeyDown,
    className,
    ...rest
  } = props as Common & { as?: 'textarea' | 'input' } & TextareaHTMLAttributes<HTMLTextAreaElement>;
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const listId = useId();
  const [token, setToken] = useState<{ kind: '@' | '#'; q: string; start: number } | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);

  const readToken = (el: HTMLTextAreaElement | HTMLInputElement) => {
    const caret = el.selectionStart ?? el.value.length;
    const m = TOKEN.exec(el.value.slice(0, caret));
    setToken(m ? { kind: m[2] as '@' | '#', q: m[3]!, start: caret - m[3]!.length - 1 } : null);
  };

  useEffect(() => {
    if (!token || (token.kind === '@' && token.q.length < 1)) return setItems([]);
    let current = true;
    const run = async () => {
      if (token.kind === '@') {
        const r = await api.people.suggest(token.q, 6).catch(() => ({ items: [] }));
        return r.items.map(({ user }) => ({
          key: user.id,
          insert: `@${user.username} `,
          primary: user.displayName,
          secondary: `@${user.username}`,
          avatar: { name: user.displayName, src: user.avatarUrl },
        }));
      }
      const q = token.q.toLocaleLowerCase();
      return (await trendingTags())
        .filter((t) => t.startsWith(q) && t !== q)
        .slice(0, 6)
        .map((t) => ({ key: t, insert: `#${t} `, primary: `#${t}` }));
    };
    const timer = setTimeout(() => void run().then((s) => current && (setItems(s), setActive(0))), token.kind === '@' ? 150 : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [token?.kind, token?.q]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = !!token && items.length > 0;

  const pick = (s: Suggestion) => {
    const el = ref.current;
    if (!el || !token) return;
    const caret = el.selectionStart ?? value.length;
    const next = value.slice(0, token.start) + s.insert + value.slice(caret);
    onValueChange(next);
    setToken(null);
    setItems([]);
    const pos = token.start + s.insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const shared = {
    ...rest,
    ref,
    value,
    className,
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open ? `${listId}-${active}` : undefined,
    onChange: (e: { currentTarget: HTMLTextAreaElement | HTMLInputElement }) => {
      onValueChange(e.currentTarget.value);
      readToken(e.currentTarget);
    },
    onClick: (e: { currentTarget: HTMLTextAreaElement | HTMLInputElement }) => readToken(e.currentTarget),
    onBlur: () => setTimeout(() => setToken(null), 150),
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement & HTMLInputElement>) => {
      if (open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          pick(items[active]!);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setToken(null);
          return;
        }
      }
      onKeyDown?.(e as KeyboardEvent<HTMLTextAreaElement>);
    },
  };

  return (
    <div className="ac">
      {as === 'input' ? <input {...(shared as InputHTMLAttributes<HTMLInputElement>)} ref={ref} /> : <textarea {...shared} ref={ref} />}
      {open ? (
        <ul id={listId} role="listbox" className="ac__list" aria-label={token!.kind === '@' ? 'People' : 'Tags'}>
          {items.map((s, i) => (
            <li
              key={s.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className="ac__item"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {s.avatar ? <Avatar name={s.avatar.name} src={s.avatar.src} size="sm" /> : null}
              <span className="ac__text">
                <bdi>{s.primary}</bdi>
                {s.secondary ? <span className="muted">{s.secondary}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
