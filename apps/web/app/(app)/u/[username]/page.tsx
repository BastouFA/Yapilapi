'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Badge, Button, EmptyState, Menu, Skeleton } from '@yapilapi/design-system';
import type { Profile } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PostList, ReportSheet } from '@/components/PostList';
import { useSession } from '../../../providers';

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { me, t, toast, setMe, flags } = useSession();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [missing, setMissing] = useState(false);
  const [reporting, setReporting] = useState(false);

  const reload = useCallback(
    () =>
      api.users.get(username).then(
        (r) => setProfile(r.profile),
        () => setMissing(true),
      ),
    [username],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const load = useCallback((cursor?: string) => api.users.posts(username, cursor), [username]);

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
            <h1 className="profile__name">{profile.displayName}</h1>
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
            <strong>{profile.counts.posts}</strong> {t('profile.posts')}
          </span>
          <span>
            <strong>{profile.counts.followers}</strong> {t('profile.followers')}
          </span>
          <span>
            <strong>{profile.counts.following}</strong> {t('profile.following')}
          </span>
          <span>
            <strong>{profile.counts.friends}</strong> {t('profile.friends')}
          </span>
        </div>
        {profile.interests.length ? (
          <div className="row">
            {profile.interests.map((i) => (
              <Link key={i} href={`/discover?q=${encodeURIComponent(i)}`} className="yp-chip">
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
      <PostList load={load} reloadKey={username} empty={rel.isSelf ? 'Share your first post from Create.' : 'No posts yet.'} />
      <ReportSheet target={reporting ? { type: 'user', id: profile.id } : null} onClose={() => setReporting(false)} />
    </div>
  );
}
