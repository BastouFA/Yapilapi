'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Badge, Button, EmptyState, Menu, PlusBadge, Segments, Skeleton } from '@yapilapi/design-system';
import { FollowList } from '@/components/FollowList';
import type { Profile, ProfileTab } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PostList, ReportSheet } from '@/components/PostList';
import { SupportCreator, TipSheet } from '@/components/SupportCreator';
import { Shop } from '@/components/Shop';
import { ChaptersRow } from '@/components/Chapters';
import { ProfileBoards } from '@/components/Boards';
import { JoinNote, NeedsAccount, useSignIn } from '@/components/SignedOut';
import { CoverSheet, NowStatusLine, NowStatusSheet, ProfileCover, ShareProfileSheet } from '@/components/ProfilePlus';
import { ProfileAccountActions } from '@/components/AccountMenu';
import { ReelGrid } from '@/components/ReelGrid';
import { AccentScope, FeaturedRow, ProfileAbout, ProfileLinks, ProfileSongChip, Pronouns, tabLabel } from '@/components/ProfileStyle';
import { useSession } from '../../../providers';

/**
 * A profile. Without an account, a public profile and its posts are readable, and following,
 * messaging and the rest lead to sign in; other profiles ask the person to sign in.
 */
export default function ProfilePageClient({ isPublic }: { isPublic: boolean }) {
  const { username } = useParams<{ username: string }>();
  const { me, t, toast, setMe, flags, locale } = useSession();
  const signIn = useSignIn();
  const signedOut = !me;
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [missing, setMissing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [sheet, setSheet] = useState<'cover' | 'status' | 'share' | null>(null);
  const [list, setList] = useState<'followers' | 'following' | null>(null);
  // null: the first tab the person chose to show.
  const [tab, setTab] = useState<ProfileTab | null>(null);
  // Tagged posts of a private profile you don't follow stay hidden.
  const [taggedHidden, setTaggedHidden] = useState(false);
  // Bumped when you subscribe, so posts for subscribers reload unlocked.
  const [version, setVersion] = useState(0);
  // Links from a locked post (?subscribe=1), to the shop (?shop=1, with &product=<id> for one item),
  // and to tip (?tip=1, with &post=<id> for a tip on a post). The phone app opens these for checkout.
  const [intent, setIntent] = useState<'subscribe' | 'shop' | 'tip' | null>(null);
  const [focus, setFocus] = useState<{ product?: string; post?: string }>({});
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = (k: string) => {
      const v = q.get(k);
      return v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined;
    };
    if (q.has('subscribe')) setIntent('subscribe');
    else if (q.has('tip')) {
      setIntent('tip');
      setFocus({ post: id('post') });
    } else if (q.has('shop')) {
      setIntent('shop');
      setTab('shop');
      setFocus({ product: id('product') });
    }
  }, []);
  useEffect(() => {
    if (intent === 'subscribe' && profile) document.getElementById('subscribe')?.scrollIntoView({ block: 'center' });
  }, [intent, profile]);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

  const reload = useCallback(
    () =>
      api.users.get(username).then(
        (r) => setProfile(r.profile),
        () => setMissing(true),
      ),
    [username],
  );
  useEffect(() => {
    if (signedOut && !isPublic) return;
    void reload();
  }, [reload, signedOut, isPublic]);
  const load = useCallback((cursor?: string) => api.users.posts(username, cursor), [username]);
  const loadReels = useCallback((cursor?: string) => api.users.posts(username, cursor, { format: 'reel' }), [username]);
  const loadReposts = useCallback((cursor?: string) => api.users.reposts(profile?.id ?? '', cursor), [profile?.id]);
  const loadTagged = useCallback(
    (cursor?: string) =>
      api.users.tagged(username, cursor).then((r) => {
        setTaggedHidden(!!r.hidden);
        return r;
      }),
    [username],
  );

  if (signedOut && !isPublic) return <NeedsAccount title="Sign in to see this profile" body="Some profiles are only visible to people with an account." />;
  if (missing) return <EmptyState title="This profile isn't available" body="It may have been removed, or you may not be able to see it." />;
  if (!profile)
    return (
      <div className="yp-shell__inner">
        <Skeleton height={160} />
        <Skeleton height={120} />
      </div>
    );

  const rel = profile.relationship;
  // The tabs they chose, in their order; a link to the shop still opens it.
  const tabs: ProfileTab[] = tab && !profile.tabs.includes(tab) ? [...profile.tabs, tab] : profile.tabs;
  const current: ProfileTab = tab ?? tabs[0] ?? 'posts';
  const act = (fn: () => Promise<unknown>, done?: string) => async () => {
    try {
      await fn();
      if (done) toast(done);
      await reload();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <AccentScope accent={profile.style.accent} className={`yp-shell__inner profile--${profile.style.header}`}>
      {rel.isSelf ? (
        <div className="profile__bar">
          <span className="profile__bar-handle">@{profile.username}</span>
          <ProfileAccountActions />
        </div>
      ) : null}
      <ProfileCover profile={profile} onEdit={rel.isSelf ? () => setSheet('cover') : undefined} />
      <div className="profile__head">
        <Avatar name={profile.displayName} src={profile.avatarUrl} size="xl" />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="stack-sm" style={{ gap: 2 }}>
            <h1 className="profile__name">
              {profile.displayName}
              {profile.plus ? <PlusBadge label={t('plus.badge.label')} /> : null}
              {profile.pronouns ? <Pronouns value={profile.pronouns} /> : null}
            </h1>
            <span className="muted">
              @{profile.username} {profile.mode !== 'personal' ? <Badge tone="neutral">{profile.mode}</Badge> : null}{' '}
              {profile.isPrivate ? <Badge tone="neutral">Private</Badge> : null}
            </span>
            {profile.nowStatus ? <NowStatusLine status={profile.nowStatus} /> : null}
            {rel.isSelf ? (
              <Button size="sm" variant="ghost" icon={profile.nowStatus ? undefined : 'plus'} className="now-status__edit" onClick={() => setSheet('status')}>
                {profile.nowStatus ? 'Edit status' : 'Set a status'}
              </Button>
            ) : null}
          </div>
          {rel.isSelf ? (
            <div className="row">
              <Link href="/settings/account" className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('profile.edit')}
              </Link>
              <Link href="/saved" className="yp-btn yp-btn--ghost yp-btn--sm">
                Saved
              </Link>
              <Link href="/studio" className="yp-btn yp-btn--ghost yp-btn--sm">
                Studio
              </Link>
              <Link href="/drafts" className="yp-btn yp-btn--ghost yp-btn--sm">
                Drafts
              </Link>
              {flags.MEMORY ? (
                <Link href="/memories" className="yp-btn yp-btn--ghost yp-btn--sm">
                  Memories
                </Link>
              ) : null}
              <Link href="/find-friends" className="yp-btn yp-btn--ghost yp-btn--sm">
                {t('friends.title')}
              </Link>
              <Link href="/invite" className="yp-btn yp-btn--ghost yp-btn--sm">
                {t('invite.title')}
              </Link>
              <Link href="/plus" className="yp-btn yp-btn--ghost yp-btn--sm">
                {t('plus.short')}
              </Link>
              <Link href="/circles" className="yp-btn yp-btn--ghost yp-btn--sm">
                Circles
              </Link>
              <Button size="sm" variant="ghost" icon="link" onClick={() => setSheet('share')}>
                Share profile
              </Button>
            </div>
          ) : signedOut ? (
            <div className="row">
              <Button size="sm" onClick={signIn}>
                {t('profile.follow')}
              </Button>
              <Button size="sm" variant="secondary" icon="message" onClick={signIn}>
                {t('profile.message')}
              </Button>
              <Button size="sm" variant="ghost" icon="link" onClick={() => setSheet('share')}>
                Share profile
              </Button>
            </div>
          ) : (
            <div className="row">
              {rel.following ? (
                <Button size="sm" variant="secondary" onClick={act(() => api.users.unfollow(profile.id))}>
                  {t('profile.unfollow')}
                </Button>
              ) : (
                <Button size="sm" onClick={act(() => api.users.follow(profile.id))} disabled={rel.blocked}>
                  {t('profile.follow')}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                icon="message"
                disabled={rel.blocked}
                onClick={async () => {
                  try {
                    const { conversation } = await api.conversations.create([profile.id]);
                    router.push(`/inbox/${conversation.id}`);
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {t('profile.message')}
              </Button>
              <Menu
                label="More"
                actions={[
                  { label: 'Share profile', icon: 'link', onSelect: () => setSheet('share') },
                  rel.friends
                    ? { label: 'Remove friend', icon: 'users', onSelect: act(() => api.users.unfriend(profile.id), 'Removed from friends') }
                    : rel.friendRequest === 'sent'
                      ? { label: t('profile.requestSent'), icon: 'check', onSelect: () => {} }
                      : {
                          label: rel.friendRequest === 'received' ? t('profile.acceptFriend') : t('profile.addFriend'),
                          icon: 'users',
                          onSelect: act(() => api.users.friendRequest(profile.id)),
                        },
                  {
                    label: rel.muted ? 'Unmute' : 'Mute',
                    icon: 'bell',
                    onSelect: act(
                      () => (rel.muted ? api.raw.del(`/v1/users/${profile.id}/mute`) : api.users.mute(profile.id)),
                      rel.muted ? 'Unmuted' : 'Muted',
                    ),
                  },
                  {
                    label: rel.blocked ? t('profile.unblock') : t('profile.block'),
                    icon: 'shield',
                    danger: !rel.blocked,
                    onSelect: act(() => (rel.blocked ? api.users.unblock(profile.id) : api.users.block(profile.id)), rel.blocked ? 'Unblocked' : 'Blocked'),
                  },
                  { label: 'Report', icon: 'flag', danger: true, onSelect: () => setReporting(true) },
                ]}
              />
            </div>
          )}
        </div>
        {profile.bio ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{profile.bio}</p> : null}
        {profile.song ? <ProfileSongChip song={profile.song} /> : null}
        <ProfileLinks links={profile.links} />
        <ProfileAbout profile={profile} />
        <div className="profile__counts">
          <span>
            <strong>{compact.format(profile.counts.posts)}</strong> {t('profile.posts')}
          </span>
          <button type="button" className="profile__count" onClick={() => (signedOut ? signIn() : setList('followers'))}>
            <strong>{compact.format(profile.counts.followers)}</strong> {t('profile.followers')}
          </button>
          <button type="button" className="profile__count" onClick={() => (signedOut ? signIn() : setList('following'))}>
            <strong>{compact.format(profile.counts.following)}</strong> {t('profile.following')}
          </button>
          <span>
            <strong>{profile.counts.friends}</strong> {t('profile.friends')}
          </span>
        </div>
        {profile.interests.length ? (
          <div className="row">
            {profile.interests.map((i) => (
              <Link key={i} href={`/t/${encodeURIComponent(i)}`} className="yp-chip">
                #{i}
              </Link>
            ))}
          </div>
        ) : null}
        {rel.isSelf && me && !me.emailVerified ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.auth.resendVerification();
              toast('Verification email sent');
              setMe({ ...me });
            }}
          >
            Confirm your email
          </Button>
        ) : null}
      </div>
      {signedOut ? (
        <JoinNote
          text={
            intent === 'subscribe'
              ? `Join YAPILAPI to subscribe to ${profile.displayName} and see posts for subscribers.`
              : `Join YAPILAPI to follow ${profile.displayName} and see more from the people you care about.`
          }
        />
      ) : null}
      {!rel.isSelf && !signedOut ? (
        <div id="subscribe" className={intent === 'subscribe' ? 'profile__subscribe profile__subscribe--focus' : 'profile__subscribe'}>
          <SupportCreator userId={profile.id} name={profile.displayName} isCreator={profile.mode === 'creator'} onSubscribed={() => setVersion((v) => v + 1)} />
        </div>
      ) : null}
      <FeaturedRow posts={profile.featured} />
      {tabs.length > 1 ? (
        <Segments label={t('ps.tabs.title')} value={current} onChange={setTab} options={tabs.map((id) => ({ id, label: t(tabLabel(id)) }))} />
      ) : (
        <h2 className="section-title" style={{ margin: 0 }}>
          {t(tabLabel(current))}
        </h2>
      )}
      {current === 'posts' ? (
        <PostList load={load} reloadKey={`${username}-${version}`} empty={rel.isSelf ? 'Share your first post from Create.' : 'No posts yet.'} />
      ) : current === 'reels' ? (
        <ReelGrid load={loadReels} reloadKey={`${username}-reels`} empty={t('ps.empty.reels')} />
      ) : current === 'chapters' ? (
        <ChaptersRow userId={profile.id} isSelf={rel.isSelf} emptyText={t('ps.empty.chapters')} />
      ) : current === 'tagged' ? (
        <PostList
          load={loadTagged}
          reloadKey={`${username}-tagged`}
          emptyTitle={taggedHidden ? 'This account is private' : 'No tagged posts yet'}
          empty={
            taggedHidden
              ? `Follow ${profile.displayName} to see photos they're tagged in.`
              : rel.isSelf
                ? 'Photos people tag you in show up here.'
                : `Photos ${profile.displayName} is tagged in show up here.`
          }
        />
      ) : current === 'boards' ? (
        <ProfileBoards username={profile.username} name={profile.displayName} isSelf={rel.isSelf} />
      ) : current === 'shop' ? (
        <Shop userId={profile.id} name={profile.displayName} isSelf={rel.isSelf} focusId={focus.product} />
      ) : (
        <PostList
          load={loadReposts}
          reloadKey={`${username}-reposts`}
          empty={rel.isSelf ? 'Posts and reels you repost show up here.' : `${profile.displayName} hasn't reposted anything yet.`}
        />
      )}
      <FollowList
        userId={profile.id}
        name={profile.displayName}
        initial={list ?? 'followers'}
        open={list !== null}
        onClose={() => setList(null)}
        onFollowChange={reload}
      />
      <ReportSheet target={reporting ? { type: 'user', id: profile.id } : null} onClose={() => setReporting(false)} />
      {!rel.isSelf && !signedOut && flags.COMMERCE !== false ? (
        <TipSheet open={intent === 'tip'} onClose={() => setIntent(null)} userId={profile.id} name={profile.displayName} postId={focus.post} />
      ) : null}
      <ShareProfileSheet open={sheet === 'share'} onClose={() => setSheet(null)} profile={profile} />
      {rel.isSelf ? (
        <>
          <CoverSheet open={sheet === 'cover'} onClose={() => setSheet(null)} profile={profile} onSaved={setProfile} />
          <NowStatusSheet
            open={sheet === 'status'}
            onClose={() => setSheet(null)}
            current={profile.nowStatus}
            onSaved={(nowStatus) => setProfile({ ...profile, nowStatus })}
          />
        </>
      ) : null}
    </AccentScope>
  );
}
