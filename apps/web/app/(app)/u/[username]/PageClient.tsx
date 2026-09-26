'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Badge, Button, EmptyState, Menu, PlusBadge, Segments, Skeleton } from '@yapilapi/design-system';
import { FollowList } from '@/components/FollowList';
import type { Profile } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PostList, ReportSheet } from '@/components/PostList';
import { SupportCreator } from '@/components/SupportCreator';
import { JoinNote, NeedsAccount, useSignIn } from '@/components/SignedOut';
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
  const [list, setList] = useState<'followers' | 'following' | null>(null);
  const [tab, setTab] = useState<'posts' | 'reposts'>('posts');
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
  const loadReposts = useCallback((cursor?: string) => api.users.reposts(profile?.id ?? '', cursor), [profile?.id]);

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
    <div className="yp-shell__inner">
      <div className="profile__cover" style={profile.coverUrl ? { backgroundImage: `url(${profile.coverUrl})` } : undefined} />
      <div className="profile__head">
        <Avatar name={profile.displayName} src={profile.avatarUrl} size="xl" />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="stack-sm" style={{ gap: 2 }}>
            <h1 className="profile__name">
              {profile.displayName}
              {profile.plus ? <PlusBadge label={t('plus.badge.label')} /> : null}
            </h1>
            <span className="muted">
              @{profile.username} {profile.mode !== 'personal' ? <Badge tone="neutral">{profile.mode}</Badge> : null}{' '}
              {profile.isPrivate ? <Badge tone="neutral">Private</Badge> : null}
            </span>
          </div>
          {rel.isSelf ? (
            <div className="row">
              <Link href="/settings" className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('profile.edit')}
              </Link>
              <Link href="/studio" className="yp-btn yp-btn--ghost yp-btn--sm">
                Studio
              </Link>
              {flags.MEMORY ? (
                <Link href="/memories" className="yp-btn yp-btn--ghost yp-btn--sm">
                  Memories
                </Link>
              ) : null}
              <Link href="/invite" className="yp-btn yp-btn--ghost yp-btn--sm">
                {t('invite.title')}
              </Link>
              <Link href="/plus" className="yp-btn yp-btn--ghost yp-btn--sm">
                {t('plus.short')}
              </Link>
            </div>
          ) : signedOut ? (
            <div className="row">
              <Button size="sm" onClick={signIn}>
                {t('profile.follow')}
              </Button>
              <Button size="sm" variant="secondary" icon="message" onClick={signIn}>
                {t('profile.message')}
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
        {profile.links.length ? (
          <div className="row">
            {profile.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="yp-chip">
                {l.label}
              </a>
            ))}
          </div>
        ) : null}
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
      {signedOut ? <JoinNote text={`Join YAPILAPI to follow ${profile.displayName} and see more from the people you care about.`} /> : null}
      {!rel.isSelf && !signedOut ? <SupportCreator userId={profile.id} name={profile.displayName} isCreator={profile.mode === 'creator'} /> : null}
      <Segments
        label="Show"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'posts', label: 'Posts' },
          { id: 'reposts', label: 'Reposts' },
        ]}
      />
      {tab === 'posts' ? (
        <PostList load={load} reloadKey={username} empty={rel.isSelf ? 'Share your first post from Create.' : 'No posts yet.'} />
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
    </div>
  );
}
