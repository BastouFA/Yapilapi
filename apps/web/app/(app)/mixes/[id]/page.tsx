'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, Icon, Menu, Skeleton, type MenuAction } from '@yapilapi/design-system';
import { mixPlayMs, type MixDetail } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import {
  AddSongs,
  MIX_VISIBILITY_LABEL,
  MiniPlayer,
  MixEditor,
  MixHeaderCover,
  PostMixSheet,
  ShareToChatSheet,
  SongList,
  useMixPlayer,
} from '@/components/Mixes';
import { ReportSheet } from '@/components/PostList';
import { useRealtime, useSession } from '../../../providers';

/**
 * A mix: its cover, name and who made it, its songs in order, and a mini player that plays each
 * song's allowed part one after another (only when you press play). The owner edits, shares into a
 * chat, shares as a post and deletes; people in a chat it's shared into add and reorder songs.
 */
export default function MixPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t, tp, me, toast } = useSession();
  const [mix, setMix] = useState<MixDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [sheet, setSheet] = useState<'edit' | 'chat' | 'post' | 'report' | null>(null);
  const player = useMixPlayer(mix?.songs ?? []);

  const load = () =>
    api.mixes.get(id).then(
      (r) => setMix(r.mix),
      () => setMissing(true),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // Someone in a chat added or moved songs: load it again.
  useRealtime((e) => {
    if (e.type === 'mix.updated' && e.data.mixId === id) void load();
  });

  if (missing) return <EmptyState title={t('mixes.missing.title')} body={t('mixes.missing.body')} />;
  if (!mix) return <Skeleton height={200} />;
  const own = mix.role === 'owner';

  async function toggle(kind: 'like' | 'save') {
    if (!mix) return;
    try {
      if (kind === 'like') {
        const r = await api.mixes.like(mix.id, !mix.liked);
        setMix({ ...mix, liked: r.liked, likeCount: r.likeCount });
      } else {
        const r = await api.mixes.save(mix.id, !mix.saved);
        setMix({ ...mix, saved: r.saved });
        toast(t(r.saved ? 'mixes.saved' : 'mixes.unsaved'));
      }
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  const actions: MenuAction[] = [];
  if (own) {
    actions.push({ label: t('mixes.edit'), icon: 'edit', onSelect: () => setSheet('edit') });
    if (mix.visibility !== 'private') actions.push({ label: t('mixes.share.title'), icon: 'message', onSelect: () => setSheet('chat') });
  }
  if (me && (mix.visibility === 'public' || (own && mix.visibility !== 'private')))
    actions.push({ label: t('mixes.post.title'), icon: 'repost', onSelect: () => setSheet('post') });
  if (own)
    for (const c of mix.chats)
      actions.push({
        label: t('mixes.unshare', { name: c.title ?? t('mixes.share.chat') }),
        icon: 'x',
        onSelect: async () => {
          try {
            setMix((await api.mixes.unshare(mix.id, c.conversationId)).mix);
          } catch (e) {
            toast(errorMessage(e));
          }
        },
      });
  if (!own && me) actions.push({ label: t('mixes.report'), icon: 'flag', danger: true, onSelect: () => setSheet('report') });
  if (own)
    actions.push({
      label: t('mixes.delete'),
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        if (!confirm(t('mixes.deleteConfirm', { title: mix.title }))) return;
        try {
          await api.mixes.remove(mix.id);
          toast(t('mixes.deleted'));
          router.push('/mixes');
        } catch (e) {
          toast(errorMessage(e));
        }
      },
    });

  const minutes = Math.round(mixPlayMs(mix.songs) / 60_000);
  return (
    <div className="yp-shell__inner mix-page">
      <header className="mix-head">
        <MixHeaderCover covers={mix.covers} />
        <div className="mix-head__text">
          <p className="mix-head__kind">
            <Icon name="mix" size={14} /> {t('mixes.card.kind')} · {t(MIX_VISIBILITY_LABEL[mix.visibility])}
          </p>
          <h1 className="mix-head__title">
            <bdi>{mix.title}</bdi>
          </h1>
          <Link href={`/u/${mix.owner.username}`} className="mix-head__owner">
            <Avatar name={mix.owner.displayName} src={mix.owner.avatarUrl} size="sm" /> <bdi>{mix.owner.displayName}</bdi>
          </Link>
          <p className="mix-head__meta">
            {tp('mixes.songs', mix.songCount)}
            {minutes ? ` · ${t('mixes.minutes', { n: minutes })}` : ''}
            {mix.likeCount ? ` · ${tp('mixes.likes', mix.likeCount)}` : ''}
          </p>
          {mix.chats.length ? (
            <p className="mix-head__meta">{t('mixes.sharedIn', { names: mix.chats.map((c) => c.title ?? t('mixes.share.chat')).join(', ') })}</p>
          ) : null}
        </div>
      </header>
      {mix.description ? <p className="mix-description">{mix.description}</p> : null}
      <div className="mix-actions">
        {mix.canAdd ? <AddSongs mix={mix} onMix={setMix} /> : null}
        {me ? (
          <>
            <Button size="sm" variant="ghost" icon="heart" aria-pressed={mix.liked} onClick={() => void toggle('like')}>
              {t(mix.liked ? 'mixes.liked' : 'mixes.like')}
            </Button>
            <Button size="sm" variant="ghost" icon="bookmark" aria-pressed={mix.saved} onClick={() => void toggle('save')}>
              {t(mix.saved ? 'mixes.savedLabel' : 'mixes.save')}
            </Button>
          </>
        ) : null}
        {actions.length ? <Menu label={t('mixes.more')} actions={actions} /> : null}
      </div>
      <SongList mix={mix} player={player} onMix={setMix} />
      <MiniPlayer player={player} songs={mix.songs} />
      {own ? (
        <MixEditor
          open={sheet === 'edit'}
          mix={mix}
          onClose={() => setSheet(null)}
          onSaved={(m) => {
            setMix(m);
            setSheet(null);
          }}
        />
      ) : null}
      {own ? <ShareToChatSheet mix={mix} open={sheet === 'chat'} onClose={() => setSheet(null)} onShared={() => void load()} /> : null}
      <PostMixSheet mix={mix} open={sheet === 'post'} onClose={() => setSheet(null)} />
      <ReportSheet target={sheet === 'report' ? { type: 'mix', id: mix.id } : null} onClose={() => setSheet(null)} />
    </div>
  );
}
