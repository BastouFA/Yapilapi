'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Avatar, Button, Icon, tagBubbleClass } from '@yapilapi/design-system';
import { MAX_PHOTO_TAGS, type PublicUser } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { useSession } from '@/app/providers';
import type { PersonSuggestion } from './PeoplePicker';

/** Someone tagged in a photo that isn't posted yet, at a spot given as fractions of the width and height. */
export type DraftTag = { user: PublicUser; x: number; y: number };
export type Spot = { x: number; y: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * A layer over a photo for tagging people. Place it inside a positioned box the size of the
 * picture. The whole photo is a button: click a spot (or press Enter to use the middle) to
 * start a tag there. Tags show as name bubbles you can drag, move with the arrow keys, or remove.
 */
export function TagLayer({
  tags,
  pending,
  onPlace,
  onMove,
  onRemove,
  surfaceRef,
}: {
  tags: DraftTag[];
  pending: Spot | null;
  onPlace: (spot: Spot) => void;
  onMove: (index: number, spot: Spot) => void;
  onRemove: (index: number) => void;
  surfaceRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { t, locale } = useSession();
  const percent = new Intl.NumberFormat(locale, { style: 'percent' });
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const full = tags.length >= MAX_PHOTO_TAGS;
  const spotAt = (clientX: number, clientY: number): Spot | null => {
    const r = layer.current?.getBoundingClientRect();
    if (!r?.width || !r.height) return null;
    return { x: clamp01((clientX - r.left) / r.width), y: clamp01((clientY - r.top) / r.height) };
  };
  const keys = (i: number) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      e.stopPropagation();
      onMove(i, { x: clamp01(tags[i]!.x + d[0]!), y: clamp01(tags[i]!.y + d[1]!) });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove(i);
    }
  };
  const startDrag = (i: number) => (e: ReactPointerEvent<HTMLElement>) => {
    drag.current = { index: i, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const spot = spotAt(e.clientX, e.clientY);
    if (!spot) return;
    d.moved = true;
    onMove(d.index, spot);
  };
  const endDrag = () => (drag.current = null);

  return (
    <div ref={layer} className="ptag-layer">
      <button
        ref={surfaceRef}
        type="button"
        className="ptag-layer__surface"
        disabled={full}
        aria-label={full ? t('photoTags.full', { count: MAX_PHOTO_TAGS }) : t('photoTags.surface')}
        onClick={(e) => {
          // A click from the keyboard has no position: use the middle of the photo.
          const spot = e.detail === 0 ? { x: 0.5, y: 0.5 } : spotAt(e.clientX, e.clientY);
          if (spot) onPlace(spot);
        }}
      />
      {pending ? <span className="ptag-layer__spot" style={{ left: pct(pending.x), top: pct(pending.y) }} aria-hidden /> : null}
      {tags.length ? (
        <ul className="yp-phototags" aria-label={t('photoTags.list')}>
          {tags.map((tag, i) => (
            <li key={tag.user.id} className={tagBubbleClass(tag.x, tag.y)} style={{ left: `${tag.x * 100}%`, top: `${tag.y * 100}%` }}>
              <span className="yp-phototag__bubble">
                <button
                  type="button"
                  className="yp-phototag__name ptag-layer__name"
                  aria-label={t('photoTags.tagA11y', {
                    name: tag.user.displayName,
                    x: percent.format(Math.round(tag.x * 100) / 100),
                    y: percent.format(Math.round(tag.y * 100) / 100),
                  })}
                  onKeyDown={keys(i)}
                  onPointerDown={startDrag(i)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  <bdi>{tag.user.displayName}</bdi>
                </button>
                <button
                  type="button"
                  className="yp-phototag__remove"
                  onClick={() => onRemove(i)}
                  aria-label={t('photoTags.remove', { name: tag.user.displayName })}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Search for one person to tag: a combobox with a list of suggestions. People who don't
 * allow tags from you are shown but can't be chosen. Escape cancels.
 */
export function TagPersonSearch({ exclude, onPick, onCancel }: { exclude: string[]; onPick: (u: PublicUser) => void; onCancel: () => void }) {
  const { t } = useSession();
  const id = useId();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PersonSuggestion[] | null>(null);
  const [active, setActive] = useState(0);
  const req = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        api.people.suggest(q.trim(), 8).then(
          (r) => n === req.current && (setItems(r.items), setActive(0)),
          () => n === req.current && setItems([]),
        ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);

  const shown = (items ?? []).filter((s) => !exclude.includes(s.user.id));
  const pick = (s: PersonSuggestion | undefined) => {
    if (s?.canTag) onPick(s.user);
  };

  return (
    <div className="ptag-search">
      <label htmlFor={`${id}-q`} className="yp-field__label">
        {t('photoTags.who')}
      </label>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          ref={input}
          id={`${id}-q`}
          className="yp-input"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown[active] ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          placeholder={t('m.group.placeholder')}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (shown.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(shown[active]);
            } else if (e.key === 'Escape') {
              // Handled here so the sheet or editor around it stays open.
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
      {shown.length ? (
        <ul id={`${id}-list`} role="listbox" className="picker__list" aria-label={t('m.ac.people')}>
          {shown.map((s, i) => (
            <li
              key={s.user.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={!s.canTag}
              className="picker__option"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              <Avatar name={s.user.displayName} src={s.user.avatarUrl} size="sm" />
              <span className="picker__text">
                <bdi className="picker__name">{s.user.displayName}</bdi>
                <span className="picker__meta">
                  <bdi>@{s.user.username}</bdi>
                  {!s.canTag ? ` · ${t('photoTags.cantTag')}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : items !== null ? (
        <p className="muted" role="status" style={{ margin: 0, fontSize: 13 }}>
          {q.trim() ? t('people.noMatch', { query: q.trim() }) : t('photoTags.typeToFind')}
        </p>
      ) : null}
    </div>
  );
}

/** State for tagging one photo: the spot waiting for a person, and helpers to change the tags. */
export function useTagEditing(tags: DraftTag[], onChange: (t: DraftTag[]) => void) {
  const [pending, setPending] = useState<Spot | null>(null);
  const surfaceRef = useRef<HTMLButtonElement>(null);
  return {
    pending,
    surfaceRef,
    layerProps: {
      tags,
      pending,
      surfaceRef,
      onPlace: setPending,
      onMove: (i: number, spot: Spot) => onChange(tags.map((t, j) => (j === i ? { ...t, ...spot } : t))),
      onRemove: (i: number) => {
        onChange(tags.filter((_, j) => j !== i));
        surfaceRef.current?.focus();
      },
    },
    searchProps: {
      exclude: tags.map((t) => t.user.id),
      onPick: (user: PublicUser) => {
        if (pending) onChange([...tags, { user, ...pending }]);
        setPending(null);
        requestAnimationFrame(() => surfaceRef.current?.focus());
      },
      onCancel: () => {
        setPending(null);
        surfaceRef.current?.focus();
      },
    },
  };
}

/** Tag people in a photo you're about to post: the photo with its tags, and the search below it. */
export function PhotoTagger({ src, alt, tags, onChange }: { src: string; alt: string; tags: DraftTag[]; onChange: (t: DraftTag[]) => void }) {
  const edit = useTagEditing(tags, onChange);
  return (
    <div className="ptag stack-sm">
      <div className="ptag__photo">
        <img src={src} alt={alt} draggable={false} />
        <TagLayer {...edit.layerProps} />
      </div>
      {edit.pending ? <TagPersonSearch {...edit.searchProps} /> : <TagHint count={tags.length} />}
    </div>
  );
}

export function TagHint({ count }: { count: number }) {
  const { t, tp } = useSession();
  return (
    <p className="muted" style={{ margin: 0, fontSize: 13 }}>
      {count >= MAX_PHOTO_TAGS ? t('photoTags.full', { count: MAX_PHOTO_TAGS }) : t('photoTags.hint')}
      {count > 0 && count < MAX_PHOTO_TAGS ? ` ${tp('photoTags.tagged', count)}` : ''}
    </p>
  );
}
