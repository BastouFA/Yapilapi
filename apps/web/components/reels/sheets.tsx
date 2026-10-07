'use client';

import { useState } from 'react';
import { BottomSheet, Button, Icon, Segments, Switch, type IconName } from '@yapilapi/design-system';
import {
  ECHO_PERMISSIONS,
  formatReelTime,
  REEL_HIGHLIGHT_GAP_MS,
  REEL_HIGHLIGHT_LABEL_MAX,
  REEL_HIGHLIGHTS_MAX,
  REEL_SPEEDS,
  type EchoPermission,
  type Post,
  type ReelHighlight,
  type ReelSpeed,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import type { ReelPrefs } from './prefs';

function SheetItem({ icon, label, onClick, danger, pressed }: { icon: IconName; label: string; onClick: () => void; danger?: boolean; pressed?: boolean }) {
  return (
    <li>
      <button type="button" className={`reel-sheet__item${danger ? ' reel-sheet__item--danger' : ''}`} onClick={onClick} aria-pressed={pressed}>
        <span className="reel-sheet__icon">
          <Icon name={icon} size={20} />
        </span>
        <span>{label}</span>
      </button>
    </li>
  );
}

/**
 * Share: the link first (the system share sheet, or copied), then more ways to share: watch it
 * together in a chat, repost, echo it with your own video, duet side by side, remix with the
 * sound, the reel's echoes, duets and remixes, a video to share elsewhere, a board.
 */
export function ShareSheet({
  post,
  mine,
  signedIn,
  onClose,
  onRepost,
  onRemix,
  onRemixes,
  onDownload,
  onSaveTo,
  onWatch,
  onEcho,
  onEchoes,
  onShared,
  onSend,
}: {
  post: Post | null;
  mine: boolean;
  signedIn: boolean;
  onClose: () => void;
  onRepost: (p: Post) => void;
  onRemix: (p: Post, mode: 'duet' | 'remix') => void;
  onRemixes: (p: Post) => void;
  onDownload: (p: Post) => void;
  onSaveTo: (p: Post) => void;
  /** Watch it together with people in a chat. */
  onWatch?: (p: Post) => void;
  /** Answer it with your own video, and see the echoes of it. */
  onEcho?: (p: Post) => void;
  onEchoes?: (p: Post) => void;
  /** Its link went out (the share sheet finished, or it was copied). */
  onShared?: (p: Post) => void;
  /** Send it into one of your chats (the server counts that share itself). */
  onSend?: (p: Post) => void;
}) {
  const { t, toast, locale } = useSession();
  if (!post) return null;
  const url = `${location.origin}/reels?start=${post.id}`;
  const done = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      onShared?.(post);
      toast(t('reel.share.copied'));
    } catch {
      toast(url);
    }
  };
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;
  const publicReel = post.visibility === 'public';
  const remixes = post.counts.remixes ?? 0;
  const echoes = post.counts.echoes ?? 0;
  const compact = new Intl.NumberFormat(locale, { notation: 'compact' });
  return (
    <BottomSheet open onClose={onClose} title={t('reel.share.title')}>
      <ul className="reel-sheet__list">
        {canShare ? (
          <SheetItem
            icon="send"
            label={t('reel.share.link')}
            onClick={done(
              () =>
                void navigator.share({ title: t('m.reels.shareTitle', { name: post.author.displayName }), url }).then(
                  () => onShared?.(post),
                  () => {},
                ),
            )}
          />
        ) : null}
        <SheetItem icon="link" label={t('reel.share.copy')} onClick={done(() => void copy())} />
        {signedIn && onSend && post.visibility !== 'private' ? (
          <SheetItem icon="message" label={t('post.send.action')} onClick={done(() => onSend(post))} />
        ) : null}
        {signedIn && onWatch && post.media.some((m) => m.kind === 'video') ? (
          <SheetItem icon="play" label={t('watch.start')} onClick={done(() => onWatch(post))} />
        ) : null}
        {!mine && publicReel && signedIn ? (
          <SheetItem
            icon="repost"
            label={`${post.viewer.reposted ? t('reel.share.undoRepost') : t('reel.share.repost')}${post.counts.reposts ? ` (${compact.format(post.counts.reposts)})` : ''}`}
            pressed={post.viewer.reposted}
            onClick={done(() => onRepost(post))}
          />
        ) : null}
        {signedIn && onEcho && post.viewer.canEcho ? <SheetItem icon="repost" label={t('echo.action')} onClick={done(() => onEcho(post))} /> : null}
        {echoes && onEchoes ? <SheetItem icon="repost" label={`${t('echo.see')} (${compact.format(echoes)})`} onClick={done(() => onEchoes(post))} /> : null}
        {post.allowRemix && publicReel && signedIn ? (
          <>
            <SheetItem icon="duet" label={t('reel.share.duet')} onClick={done(() => onRemix(post, 'duet'))} />
            <SheetItem icon="music" label={t('reel.share.remix')} onClick={done(() => onRemix(post, 'remix'))} />
          </>
        ) : null}
        {remixes ? <SheetItem icon="repost" label={`${t('reel.share.remixes')} (${compact.format(remixes)})`} onClick={done(() => onRemixes(post))} /> : null}
        {post.downloadable ? <SheetItem icon="download" label={t('share.video.download')} onClick={done(() => onDownload(post))} /> : null}
        {signedIn ? <SheetItem icon="bookmark" label={t('m.boards.saveTo')} onClick={done(() => onSaveTo(post))} /> : null}
      </ul>
    </BottomSheet>
  );
}

/**
 * The "…" sheet: how to watch (speed, captions, quality) and what to do with the reel
 * (picture in picture, not interested, copy link, download, highlights, remix and echo settings
 * for the creator, leave as co-author, report).
 */
export function OptionsSheet({
  post,
  mine,
  prefs,
  onPrefs,
  onClose,
  pip,
  onPip,
  onNotInterested,
  onCopy,
  onDownload,
  onHighlights,
  onAllowRemix,
  onAllowEchoes,
  onLeaveCollab,
  onReport,
  onToggleCounts,
}: {
  post: Post | null;
  mine: boolean;
  prefs: ReelPrefs;
  onPrefs: (p: Partial<ReelPrefs>) => void;
  onClose: () => void;
  /** Picture in picture is available in this browser. */
  pip: boolean;
  onPip: () => void;
  onNotInterested: (p: Post) => void;
  onCopy: (p: Post) => void;
  onDownload: (p: Post) => void;
  onHighlights: (p: Post) => void;
  onAllowRemix: (p: Post, allow: boolean) => void;
  /** The creator: who may echo the reel. */
  onAllowEchoes?: (p: Post, allow: EchoPermission) => void;
  onLeaveCollab: (p: Post) => void;
  onReport: (p: Post) => void;
  /** The creator: hide the like and view counts from everyone else, or show them again. */
  onToggleCounts?: (p: Post) => void;
}) {
  const { t, locale } = useSession();
  if (!post) return null;
  const hasCaptions = !!post.media[0]?.captions?.length;
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const speedLabel = (s: ReelSpeed) => (s === 1 ? t('reel.speed.normal') : `${fmt.format(s)}×`);
  const done = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <BottomSheet open onClose={onClose} title={t('reel.options')}>
      <div className="reel-sheet">
        <div className="reel-sheet__group">
          <span className="reel-sheet__label">{t('reel.speed')}</span>
          <Segments
            label={t('reel.speed')}
            value={String(prefs.speed)}
            onChange={(v) => onPrefs({ speed: Number(v) as ReelSpeed })}
            options={REEL_SPEEDS.map((s) => ({ id: String(s), label: speedLabel(s) }))}
          />
        </div>
        <div className="reel-sheet__group">
          <span className="reel-sheet__label">{t('reel.captions')}</span>
          {hasCaptions ? (
            <Switch label={t('reel.captions.show')} checked={prefs.captions} onChange={(v) => onPrefs({ captions: v })} />
          ) : (
            <span className="muted reel-sheet__note">{t('reel.captions.none')}</span>
          )}
          <Switch label={t('reel.captions.bigger')} checked={prefs.bigCaptions} onChange={(v) => onPrefs({ bigCaptions: v })} />
        </div>
        <div className="reel-sheet__group">
          <span className="reel-sheet__label">{t('reel.quality')}</span>
          <Segments
            label={t('reel.quality')}
            value={prefs.quality}
            onChange={(v) => onPrefs({ quality: v })}
            options={[
              { id: 'auto', label: t('reel.quality.auto') },
              { id: 'saver', label: t('reel.quality.saver') },
              { id: 'best', label: t('reel.quality.best') },
            ]}
          />
        </div>
        {mine && onAllowEchoes && post.allowEchoes && !post.echoOf ? (
          <div className="reel-sheet__group">
            <span className="reel-sheet__label">{t('echo.settings')}</span>
            <Segments
              label={t('echo.settings')}
              value={post.allowEchoes}
              onChange={(v) => onAllowEchoes(post, v)}
              options={ECHO_PERMISSIONS.map((p) => ({ id: p, label: t(`echo.settings.${p}`) }))}
            />
            <span className="muted reel-sheet__note">{t('echo.settings.hint')}</span>
          </div>
        ) : null}
        <ul className="reel-sheet__list">
          {pip ? <SheetItem icon="image" label={t('reel.pip')} onClick={done(onPip)} /> : null}
          <SheetItem icon="link" label={t('reel.share.copy')} onClick={done(() => onCopy(post))} />
          {post.downloadable ? <SheetItem icon="download" label={t('share.video.download')} onClick={done(() => onDownload(post))} /> : null}
          {mine ? (
            <>
              <SheetItem icon="star" label={t('reel.highlights.edit')} onClick={done(() => onHighlights(post))} />
              <SheetItem
                icon="duet"
                label={post.allowRemix ? t('reel.remixes.stop') : t('reel.remixes.allow')}
                onClick={done(() => onAllowRemix(post, !post.allowRemix))}
              />
            </>
          ) : (
            <SheetItem icon="eye" label={t('reel.notInterested')} onClick={done(() => onNotInterested(post))} />
          )}
          {mine && onToggleCounts ? (
            <SheetItem
              icon={post.countsHidden ? 'eye' : 'eye-off'}
              label={t(post.countsHidden ? 'post.showCounts' : 'post.hideCounts')}
              onClick={done(() => onToggleCounts(post))}
            />
          ) : null}
          {post.viewer.collab === 'accepted' && !mine ? (
            <SheetItem icon="logout" label={t('reel.collab.leave')} onClick={done(() => onLeaveCollab(post))} />
          ) : null}
          {mine || post.viewer.collab === 'accepted' ? null : <SheetItem icon="flag" label={t('reel.report')} danger onClick={done(() => onReport(post))} />}
        </ul>
      </div>
    </BottomSheet>
  );
}

/**
 * The creator's highlights: up to five named points people can jump to. Pause where one
 * goes, name it and add it; rename or remove the others; save.
 */
export function HighlightsSheet({
  post,
  currentMs,
  onClose,
  onSaved,
  onSeek,
}: {
  post: Post | null;
  currentMs: () => number;
  onClose: () => void;
  onSaved: (p: Post, h: ReelHighlight[]) => void;
  onSeek: (ms: number) => void;
}) {
  const { t, toast } = useSession();
  const [list, setList] = useState<ReelHighlight[]>(post?.highlights ?? []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(() => currentMs());
  if (!post) return null;
  const full = list.length >= REEL_HIGHLIGHTS_MAX;
  const tooClose = list.some((h) => Math.abs(h.atMs - at) < REEL_HIGHLIGHT_GAP_MS);
  const add = () => {
    const label = name.trim();
    if (!label || full || tooClose) return;
    setList((l) => [...l, { atMs: at, label }].sort((a, b) => a.atMs - b.atMs));
    setName('');
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.posts.setHighlights(
        post.id,
        list.map((h) => ({ ...h, label: h.label.trim() })).filter((h) => h.label),
      );
      onSaved(post, r.highlights);
      toast(t('reel.highlights.saved'));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet open onClose={onClose} title={t('reel.highlights.edit')}>
      <div className="reel-sheet">
        <p className="muted reel-sheet__note">{t('reel.highlights.hint')}</p>
        {list.length ? (
          <ul className="reel-marks-edit">
            {list.map((h, i) => (
              <li key={h.atMs}>
                <button
                  type="button"
                  className="reel-marks-edit__time"
                  onClick={() => onSeek(h.atMs)}
                  aria-label={t('reel.moment.seek', { time: formatReelTime(h.atMs) })}
                >
                  {formatReelTime(h.atMs)}
                </button>
                <input
                  className="yp-input"
                  value={h.label}
                  maxLength={REEL_HIGHLIGHT_LABEL_MAX}
                  aria-label={`${t('reel.highlights.name')}, ${formatReelTime(h.atMs)}`}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setList((l) => l.map((x, j) => (j === i ? { ...x, label: v } : x)));
                  }}
                />
                <button
                  type="button"
                  className="reel-marks-edit__remove"
                  onClick={() => setList((l) => l.filter((_, j) => j !== i))}
                  aria-label={t('reel.highlights.remove', { label: h.label || formatReelTime(h.atMs) })}
                >
                  <Icon name="x" size={18} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted reel-sheet__note">{t('reel.highlights.none')}</p>
        )}
        {full ? (
          <p className="muted reel-sheet__note">{t('reel.highlights.full')}</p>
        ) : (
          <form
            className="reel-marks-edit__add"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <label className="yp-visually-hidden" htmlFor="reel-highlight-name">
              {t('reel.highlights.name')}
            </label>
            <input
              id="reel-highlight-name"
              className="yp-input"
              value={name}
              maxLength={REEL_HIGHLIGHT_LABEL_MAX}
              placeholder={t('reel.highlights.placeholder')}
              onFocus={() => setAt(currentMs())}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Button type="submit" size="sm" variant="secondary" disabled={!name.trim() || tooClose}>
              {t('reel.highlights.addAt', { time: formatReelTime(at) })}
            </Button>
          </form>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
