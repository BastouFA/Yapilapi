'use client';

import dynamic from 'next/dynamic';
import { useEffect, useId, useRef, useState } from 'react';
import { BottomSheet, Button, Icon, Segments, TextField } from '@yapilapi/design-system';
import {
  IMAGE_ACCEPT,
  NOW_STATUS_ICONS,
  NOW_STATUS_MAX,
  profileQrInk,
  type CoverPhoto,
  type CoverRecipe,
  type MessageKey,
  type NowStatus,
  type NowStatusAudience,
  type NowStatusIcon,
  type Profile,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import type { CoverEditorTab } from './editor/CoverEditor';
import { SuggestAltText } from './AiHelpers';
import { EditorLoading } from './Loading';

// The cover editor downloads when you open it on your own profile.
const CoverEditor = dynamic(() => import('./editor/CoverEditor').then((m) => m.CoverEditor), { ssr: false, loading: () => <EditorLoading /> });

// ── Cover ───────────────────────────────────────────────────────────────
/**
 * The band at the top of a profile: the person's cover photo (a processed size),
 * or a gradient when there isn't one. A soft fade into the page sits under the
 * avatar in both themes. Your own profile gets a button to change it.
 */
export function ProfileCover({ profile, onEdit }: { profile: Profile; onEdit?: () => void }) {
  const { t } = useSession();
  // The header style: 'cover' shows the photo (or the accent gradient without one), 'gradient' always the gradient, 'clean' no band.
  const header = profile.style?.header ?? 'cover';
  if (header === 'clean') return null;
  const photo = header === 'cover' && profile.coverUrl ? profile.coverUrl : null;
  return (
    <div className={photo ? 'profile__cover profile__cover--photo' : 'profile__cover'}>
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="profile__cover-img" src={photo} alt={profile.coverAlt || t('m.cover.alt', { name: profile.displayName })} />
      ) : null}
      <span className="profile__cover-fade" aria-hidden />
      {onEdit && header === 'cover' ? (
        <Button size="sm" variant="secondary" icon="image" className="profile__cover-edit" onClick={onEdit}>
          {profile.coverUrl ? t('m.cover.edit') : t('profilePlus.addCover')}
        </Button>
      ) : null}
    </div>
  );
}

/** What the cover editor is open on: a new file, one of your uploads, or your cover's original. */
type CoverSource =
  { kind: 'file'; file: File; src: string } | { kind: 'media'; mediaId: string; src: string; initial: CoverRecipe | null; tab: CoverEditorTab };

/**
 * Choose, edit, describe or remove your cover photo. A new photo or one of your recent ones opens
 * the cover editor; "Edit cover" and "Adjust position" open your cover's original with the edits
 * you made. The server renders the cover from the original (PUT /v1/me/cover with the recipe).
 */
export function CoverSheet({ open, onClose, profile, onSaved }: { open: boolean; onClose: () => void; profile: Profile; onSaved: (p: Profile) => void }) {
  const { toast, t, locale } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState(profile.coverAlt ?? '');
  const [busy, setBusy] = useState<'save' | 'remove' | 'edit' | null>(null);
  const [recent, setRecent] = useState<CoverPhoto[] | null>(null);
  const [editing, setEditing] = useState<CoverSource | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const edit = profile.coverEdit ?? null;

  useEffect(() => {
    if (!open) return;
    setAlt(profile.coverAlt ?? '');
    setEditError(null);
    setStage(null);
    let live = true;
    api.me
      .coverPhotos()
      .then((r) => live && setRecent(r.items))
      .catch(() => live && setRecent([]));
    return () => {
      live = false;
    };
  }, [open, profile.coverAlt]);
  // A new file's address lives only while the editor is open on it.
  useEffect(() => {
    if (editing?.kind !== 'file') return;
    const src = editing.src;
    return () => URL.revokeObjectURL(src);
  }, [editing]);

  async function saveDescription() {
    setBusy('save');
    try {
      onSaved((await api.me.updateProfile({ coverAlt: alt.trim() || null })).profile);
      toast(t('profilePlus.descriptionSaved'));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit(recipe: CoverRecipe) {
    if (!editing) return;
    setBusy('edit');
    setEditError(null);
    try {
      let saved: Profile;
      const description = alt.trim() || undefined;
      if (editing.kind === 'file') {
        setStage(t('profilePlus.uploading'));
        const { media } = await api.media.upload(editing.file, description);
        if (media.kind !== 'image') throw new Error(t('profilePlus.photoOnly'));
        setStage(t('m.cover.preparing'));
        saved = (await api.me.setCoverWhenReady(media.id, description, { edit: recipe })).profile;
      } else {
        setStage(t('coverEditor.saving'));
        saved = (await api.me.setCover(editing.mediaId, description, recipe)).profile;
      }
      onSaved(saved);
      toast(t('profilePlus.coverUpdated'));
      setEditing(null);
      onClose();
    } catch (e) {
      setEditError(e instanceof Error && !('status' in e) ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }

  const openEdit = (tab: CoverEditorTab) => edit && setEditing({ kind: 'media', mediaId: edit.mediaId, src: edit.url, initial: edit.recipe, tab });
  const dateOf = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));

  if (editing)
    return (
      <>
        <CoverEditor
          src={editing.src}
          profile={profile}
          initial={editing.kind === 'media' ? editing.initial : null}
          initialTab={editing.kind === 'media' ? editing.tab : 'frame'}
          title={editing.kind === 'media' && editing.tab === 'frame' && edit?.mediaId === editing.mediaId ? t('coverEditor.adjustPosition') : t('m.cover.edit')}
          busy={busy === 'edit'}
          error={editError}
          onDone={saveEdit}
          onCancel={() => {
            setEditing(null);
            setEditError(null);
          }}
        />
        {stage ? (
          <p className="yp-visually-hidden" role="status">
            {stage}
          </p>
        ) : null}
      </>
    );

  async function remove() {
    setBusy('remove');
    try {
      onSaved((await api.me.removeCover()).profile);
      toast(t('profilePlus.coverRemoved'));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('profilePlus.coverTitle')}>
      <div className="stack">
        <div className="cover-sheet__preview">
          {profile.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.coverUrl} alt="" />
          ) : (
            <span className="muted">{t('profilePlus.noCover')}</span>
          )}
        </div>
        {edit ? (
          <div className="cover-sheet__actions">
            <Button variant="secondary" icon="edit" onClick={() => openEdit('look')} disabled={!!busy}>
              {t('m.cover.edit')}
            </Button>
            <Button variant="secondary" onClick={() => openEdit('frame')} disabled={!!busy}>
              {t('coverEditor.adjustPosition')}
            </Button>
          </div>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) setEditing({ kind: 'file', file: f, src: URL.createObjectURL(f) });
            e.currentTarget.value = '';
          }}
        />
        <Button variant={edit ? 'ghost' : 'secondary'} icon="image" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          {t('coverEditor.upload')}
        </Button>
        {recent?.length ? (
          <section className="stack-sm" aria-labelledby="cover-recent-title">
            <h3 id="cover-recent-title" className="yp-field__label" style={{ margin: 0 }}>
              {t('coverEditor.recent')}
            </h3>
            <ul className="cover-sheet__recent">
              {recent.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="cover-sheet__photo"
                    disabled={!!busy}
                    aria-label={
                      p.altText
                        ? `${p.altText}. ${t('coverEditor.photoFrom', { date: dateOf(p.createdAt) })}`
                        : t('coverEditor.photoFrom', { date: dateOf(p.createdAt) })
                    }
                    onClick={() => setEditing({ kind: 'media', mediaId: p.id, src: p.url, initial: null, tab: 'frame' })}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.thumbUrl} alt="" loading="lazy" decoding="async" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <TextField
          label={t('profilePlus.describe')}
          hint={t('profilePlus.describeHint')}
          value={alt}
          maxLength={300}
          onChange={(e) => setAlt(e.currentTarget.value)}
        />
        {edit ? <SuggestAltText mediaId={edit.mediaId} index={0} onSuggested={(text) => setAlt(text.slice(0, 300))} /> : null}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {profile.coverUrl ? (
            <Button variant="ghost" icon="trash" loading={busy === 'remove'} disabled={!!busy} onClick={remove}>
              {t('profilePlus.removeCover')}
            </Button>
          ) : (
            <span />
          )}
          {profile.coverUrl ? (
            <Button loading={busy === 'save'} disabled={!!busy || alt.trim() === (profile.coverAlt ?? '')} onClick={saveDescription}>
              {t('coverEditor.saveDescription')}
            </Button>
          ) : null}
        </div>
      </div>
    </BottomSheet>
  );
}

// ── "Now" status ────────────────────────────────────────────────────────
const ICON_LABELS: Record<NowStatusIcon, MessageKey> = {
  sparkle: 'm.now.icon.sparkle',
  music: 'm.now.icon.music',
  'map-pin': 'm.now.icon.map-pin',
  calendar: 'm.now.icon.calendar',
  heart: 'm.now.icon.heart',
  globe: 'profilePlus.iconTravel',
  star: 'm.now.icon.star',
  mic: 'm.now.icon.mic',
};
const AUDIENCE_LABELS: Record<NowStatusAudience, MessageKey> = {
  everyone: 'm.now.audience.everyone',
  followers: 'm.now.audience.followers',
  close_friends: 'm.now.audience.close_friends',
};

/** A status line: its icon (if any) and text. `compact` for chat headers. */
export function NowStatusLine({ status, compact }: { status: NowStatus; compact?: boolean }) {
  const { t } = useSession();
  return (
    <p className={compact ? 'now-status now-status--compact' : 'now-status'}>
      <span className="yp-visually-hidden">{`${t('profilePlus.nowLabel')} `}</span>
      {status.icon ? <Icon name={status.icon} size={compact ? 14 : 16} /> : null}
      <bdi className="now-status__text">{status.text}</bdi>
    </p>
  );
}

/** Set or clear your "Now" status. It ends by itself after 24 hours. */
export function NowStatusSheet({
  open,
  onClose,
  current,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  current: NowStatus | null;
  onSaved: (s: NowStatus | null) => void;
}) {
  const { toast, t } = useSession();
  const groupId = useId();
  const [text, setText] = useState('');
  const [icon, setIcon] = useState<NowStatusIcon | null>(null);
  const [audience, setAudience] = useState<NowStatusAudience>('everyone');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(current?.text ?? '');
    setIcon(current?.icon ?? null);
    setAudience(current?.audience ?? 'everyone');
  }, [open, current]);

  async function save() {
    setBusy('save');
    try {
      const { status } = await api.me.setStatus({ text: text.trim(), icon, audience });
      onSaved(status);
      toast(t('profilePlus.statusSet'));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function clear() {
    setBusy('clear');
    try {
      await api.me.clearStatus();
      onSaved(null);
      toast(t('profilePlus.statusCleared'));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.now.title')}>
      <div className="stack">
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('profilePlus.statusIntro')}
        </p>
        <TextField
          label={t('profilePlus.statusLabel')}
          value={text}
          maxLength={NOW_STATUS_MAX}
          placeholder={t('profilePlus.statusPlaceholder')}
          hint={t('m.now.counterLabel', { count: text.length, max: NOW_STATUS_MAX })}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <fieldset className="now-status__icons">
          <legend className="yp-field__label">{t('profilePlus.iconOptional')}</legend>
          <label className="now-status__icon">
            <input
              type="radio"
              className="yp-visually-hidden"
              name={groupId}
              aria-label={t('m.now.noIcon')}
              checked={icon === null}
              onChange={() => setIcon(null)}
            />
            <span aria-hidden>{t('profilePlus.noIconShort')}</span>
          </label>
          {NOW_STATUS_ICONS.map((name) => (
            <label key={name} className="now-status__icon">
              <input
                type="radio"
                className="yp-visually-hidden"
                name={groupId}
                aria-label={t(ICON_LABELS[name])}
                checked={icon === name}
                onChange={() => setIcon(name)}
              />
              <Icon name={name} />
            </label>
          ))}
        </fieldset>
        <div className="stack-sm">
          <span className="yp-field__label">{t('m.now.audience')}</span>
          <Segments
            label={t('m.now.audience')}
            value={audience}
            onChange={setAudience}
            options={(Object.keys(AUDIENCE_LABELS) as NowStatusAudience[]).map((id) => ({ id, label: t(AUDIENCE_LABELS[id]) }))}
          />
          <span className="muted" style={{ fontSize: 13 }}>
            {audience === 'everyone'
              ? t('profilePlus.audienceEveryone')
              : audience === 'followers'
                ? t('profilePlus.audienceFollowers')
                : t('profilePlus.audienceCloseFriends')}
          </span>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {current ? (
            <Button variant="ghost" loading={busy === 'clear'} disabled={!!busy} onClick={clear}>
              {t('m.now.clear')}
            </Button>
          ) : (
            <span />
          )}
          <Button loading={busy === 'save'} disabled={!!busy || !text.trim()} onClick={save}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

// ── Share ───────────────────────────────────────────────────────────────
/**
 * A QR code for `value`, drawn as SVG in the browser. Always dark on light so phone cameras can read
 * it: `ink` is the profile's accent, deepened to at least 7:1 against the white card (profileQrInk).
 * The encoder downloads the first time a code is shown; until then the white square holds its place.
 */
export function QrCode({ value, label, size = 208, ink = '#0E1020' }: { value: string; label: string; size?: number; ink?: string }) {
  const [code, setCode] = useState<{ value: string; path: string; count: number } | null>(null);
  useEffect(() => {
    let live = true;
    void import('qrcode-generator').then(({ default: qrcode }) => {
      if (!live) return;
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
      setCode({ value, path: d, count: n + 8 });
    });
    return () => {
      live = false;
    };
  }, [value]);
  const ready = code?.value === value ? code : null;
  const count = ready?.count ?? 1;
  return (
    <svg
      className="qr-code"
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      role="img"
      aria-label={label}
      aria-busy={!ready}
      shapeRendering="crispEdges"
    >
      <rect width={count} height={count} fill="#FFFFFF" />
      {ready ? <path d={ready.path} fill={ink} /> : null}
    </svg>
  );
}

/** "Share profile": a QR code for the public profile address, and a button to copy it. */
export function ShareProfileSheet({ open, onClose, profile }: { open: boolean; onClose: () => void; profile: Profile }) {
  const { toast, t } = useSession();
  const [url, setUrl] = useState('');
  useEffect(() => setUrl(`${location.origin}/u/${profile.username}`), [profile.username]);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.profile.share')}>
      <div className="stack share-profile">
        <div className="share-profile__card" style={{ borderTopColor: profileQrInk(profile.style?.accent) }}>
          {url ? <QrCode value={url} ink={profileQrInk(profile.style?.accent)} label={t('profilePlus.qrLabel', { name: profile.displayName })} /> : null}
          <strong>{profile.displayName}</strong>
          <span className="muted">@{profile.username}</span>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14, textAlign: 'center' }}>
          {t('profilePlus.scanHint')}
        </p>
        <input className="yp-input" readOnly value={url} aria-label={t('profilePlus.profileLink')} onFocus={(e) => e.currentTarget.select()} />
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            icon="link"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                toast(t('invite.copied'));
              } catch {
                toast(t('profilePlus.copyFailed'));
              }
            }}
          >
            {t('invite.copy')}
          </Button>
          {canShare ? (
            <Button
              variant="secondary"
              icon="send"
              onClick={() => navigator.share({ title: t('profilePlus.shareTitle', { name: profile.displayName }), url }).catch(() => {})}
            >
              {t('m.common.share')}
            </Button>
          ) : null}
        </div>
      </div>
    </BottomSheet>
  );
}
