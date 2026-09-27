'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { BottomSheet, Button, Icon, Segments, TextField } from '@yapilapi/design-system';
import {
  IMAGE_ACCEPT,
  NOW_STATUS_ICONS,
  NOW_STATUS_MAX,
  type MessageKey,
  type NowStatus,
  type NowStatusAudience,
  type NowStatusIcon,
  type Profile,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

// ── Cover ───────────────────────────────────────────────────────────────
/**
 * The band at the top of a profile: the person's cover photo (a processed size),
 * or a gradient when there isn't one. A soft fade into the page sits under the
 * avatar in both themes. Your own profile gets a button to change it.
 */
export function ProfileCover({ profile, onEdit }: { profile: Profile; onEdit?: () => void }) {
  const { t } = useSession();
  return (
    <div className={profile.coverUrl ? 'profile__cover profile__cover--photo' : 'profile__cover'}>
      {profile.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="profile__cover-img" src={profile.coverUrl} alt={profile.coverAlt || t('m.cover.alt', { name: profile.displayName })} />
      ) : null}
      <span className="profile__cover-fade" aria-hidden />
      {onEdit ? (
        <Button size="sm" variant="secondary" icon="image" className="profile__cover-edit" onClick={onEdit}>
          {profile.coverUrl ? t('profilePlus.changeCover') : t('profilePlus.addCover')}
        </Button>
      ) : null}
    </div>
  );
}

/** Choose, describe or remove your cover photo. Photos go through the usual upload and processing. */
export function CoverSheet({ open, onClose, profile, onSaved }: { open: boolean; onClose: () => void; profile: Profile; onSaved: (p: Profile) => void }) {
  const { toast, t } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [alt, setAlt] = useState(profile.coverAlt ?? '');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setAlt(profile.coverAlt ?? '');
    setStage(null);
  }, [open, profile.coverAlt]);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function save() {
    setBusy('save');
    try {
      let saved: Profile;
      if (file) {
        setStage(t('profilePlus.uploading'));
        const { media } = await api.media.upload(file, alt.trim() || undefined);
        if (media.kind !== 'image') throw new Error(t('profilePlus.photoOnly'));
        setStage(t('m.cover.preparing'));
        saved = (await api.me.setCoverWhenReady(media.id, alt.trim() || undefined)).profile;
      } else {
        saved = (await api.me.updateProfile({ coverAlt: alt.trim() || null })).profile;
      }
      onSaved(saved);
      toast(file ? t('profilePlus.coverUpdated') : t('profilePlus.descriptionSaved'));
      onClose();
    } catch (e) {
      toast(e instanceof Error && !('status' in e) ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }

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

  const shown = preview ?? profile.coverUrl;
  return (
    <BottomSheet open={open} onClose={onClose} title={t('profilePlus.coverTitle')}>
      <div className="stack">
        <div className="cover-sheet__preview">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="" />
          ) : (
            <span className="muted">{t('profilePlus.noCover')}</span>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) setFile(f);
            e.currentTarget.value = '';
          }}
        />
        <Button variant="secondary" icon="image" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          {shown ? t('profilePlus.chooseDifferent') : t('m.cover.choose')}
        </Button>
        <TextField
          label={t('profilePlus.describe')}
          hint={t('profilePlus.describeHint')}
          value={alt}
          maxLength={300}
          onChange={(e) => setAlt(e.currentTarget.value)}
        />
        {stage ? (
          <p className="muted" role="status" style={{ margin: 0, fontSize: 14 }}>
            {stage}
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {profile.coverUrl ? (
            <Button variant="ghost" icon="trash" loading={busy === 'remove'} disabled={!!busy} onClick={remove}>
              {t('profilePlus.removeCover')}
            </Button>
          ) : (
            <span />
          )}
          <Button loading={busy === 'save'} disabled={!!busy || (!file && !profile.coverUrl)} onClick={save}>
            {t('common.save')}
          </Button>
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
/** A QR code for `value`, drawn as SVG in the browser. Always dark on light so phone cameras can read it. */
export function QrCode({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { path: d, count: n + 8 };
  }, [value]);
  return (
    <svg className="qr-code" width={size} height={size} viewBox={`0 0 ${count} ${count}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={count} height={count} fill="#FFFFFF" />
      <path d={path} fill="#0E1020" />
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
        <div className="share-profile__card">
          {url ? <QrCode value={url} label={t('profilePlus.qrLabel', { name: profile.displayName })} /> : null}
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
