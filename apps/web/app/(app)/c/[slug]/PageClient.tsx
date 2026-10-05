'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AIPanel, Alert, Avatar, Badge, Button, EmptyState, EventCard, List, ListItem, Skeleton, Tabs } from '@yapilapi/design-system';
import type { Community, EventItem, MessageKey, PublicUser, RoomSummary } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { PostList } from '@/components/PostList';
import { CommunityFaq } from '@/components/CommunityExtras';
import { CommunityRooms } from '@/components/RoomView';
import { JoinNote, NeedsAccount, useSignIn } from '@/components/SignedOut';
import { useSession } from '../../../providers';

/** Community roles with a name in the catalog; any other role shows as it comes. */
const ROLE_LABEL: Record<string, MessageKey> = {
  owner: 'm.role.owner',
  admin: 'm.role.admin',
  moderator: 'm.role.moderator',
  organizer: 'm.role.organizer',
  member: 'm.role.member',
  guest: 'm.role.guest',
};
/** "You're a moderator" and so on, one whole sentence per role. */
const YOU_ARE: Record<string, MessageKey> = {
  owner: 'communityPage.youAre.owner',
  admin: 'communityPage.youAre.admin',
  moderator: 'communityPage.youAre.moderator',
  organizer: 'communityPage.youAre.organizer',
};

/** A community. Without an account, a public community's posts and events are readable and joining leads to sign in. */
export default function CommunityPageClient({ isPublic }: { isPublic: boolean }) {
  const { slug } = useParams<{ slug: string }>();
  const { t, tp, toast, locale, me } = useSession();
  const signIn = useSignIn();
  const signedOut = !me;
  const [c, setC] = useState<(Community & { membershipStatus: string | null }) | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone; a community already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [members, setMembers] = useState<{ user: PublicUser; role: string }[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [summary, setSummary] = useState<{ text: string; dev: boolean } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [tab, setTab] = useState('posts');
  const [liveRoom, setLiveRoom] = useState<RoomSummary | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    return api.communities.get(slug).then(
      (r) => {
        setC(r.community);
        setChatId(r.chatConversationId);
      },
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
  }, [slug]);
  useEffect(() => {
    if (signedOut && !isPublic) return;
    void reload();
  }, [reload, signedOut, isPublic]);
  const locked = !!c && c.visibility === 'private' && !c.myRole;
  const loadMembers = useCallback(() => {
    setMembersError(null);
    api.communities.members(slug).then(
      (r) => setMembers(r.items),
      (e) => setMembersError(errorMessage(e)),
    );
  }, [slug]);
  const loadEvents = useCallback((communityId: string) => {
    setEventsError(null);
    api.raw.get<{ items: EventItem[] }>(`/v1/events?communityId=${communityId}`).then(
      (r) => setEvents(r.items),
      (e) => setEventsError(errorMessage(e)),
    );
  }, []);
  useEffect(() => {
    if (!c || locked) return;
    if (tab === 'members' && !members && !membersError) loadMembers();
    if (tab === 'events' && !events && !eventsError) loadEvents(c.id);
  }, [tab, c, locked, members, membersError, events, eventsError, loadMembers, loadEvents]);
  // Joining or leaving changes who is listed.
  useEffect(() => {
    setMembers(null);
    setEvents(null);
  }, [c?.myRole]);
  // A live room shows above the tabs.
  useEffect(() => {
    if (!c || signedOut) return;
    api.communities.rooms(slug).then(
      (r) => setLiveRoom(r.items.find((x) => x.status === 'live') ?? null),
      () => setLiveRoom(null),
    );
  }, [c, slug, signedOut]);
  const load = useCallback((cursor?: string) => api.communities.posts(slug, cursor), [slug]);

  if (signedOut && !isPublic) return <NeedsAccount title={t('communityPage.signIn.title')} body={t('communityPage.signIn.body')} />;
  if (missing) return <EmptyState level={1} title={t('m.community.notFound.title')} body={t('m.community.notFound.body')} />;
  if (!c && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={() => void reload()}>{t('m.common.retry')}</Button>} />;
  if (!c) return <Skeleton height={200} />;

  const isMember = !!c.myRole;
  const canOrganize = ['owner', 'admin', 'moderator', 'organizer'].includes(c.myRole ?? '');
  const canManage = ['owner', 'admin', 'moderator'].includes(c.myRole ?? '');
  const roleLabel = (role: string) => (ROLE_LABEL[role] ? t(ROLE_LABEL[role]) : role);

  return (
    <div className="yp-shell__inner">
      <div className="stack-sm">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1 className="profile__name">{c.name}</h1>
          {isMember ? (
            c.myRole === 'owner' ? (
              <Badge tone="success">{t('m.role.owner')}</Badge>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={leaving}
                onClick={async () => {
                  setLeaving(true);
                  await api.communities.leave(slug).catch((e) => toast(errorMessage(e)));
                  await reload();
                  setLeaving(false);
                }}
              >
                {t('communities.leave')}
              </Button>
            )
          ) : c.membershipStatus === 'pending' ? (
            <div className="row">
              <Badge tone="warning">{t('profile.requestSent')}</Badge>
              <Button
                size="sm"
                variant="ghost"
                loading={leaving}
                onClick={async () => {
                  setLeaving(true);
                  try {
                    await api.communities.leave(slug);
                    toast(t('profile.requestWithdrawn'));
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                  await reload();
                  setLeaving(false);
                }}
              >
                {t('m.community.withdraw')}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              onClick={async () => {
                if (signedOut) return signIn();
                try {
                  const r = await api.communities.join(slug);
                  toast(r.status === 'pending' ? t('m.community.requestSent') : t('m.community.welcome', { name: c.name }));
                  await reload();
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {c.visibility === 'private' ? t('m.community.requestJoin') : t('communities.join')}
            </Button>
          )}
        </div>
        <span className="muted">
          {c.memberCount.toLocaleString()} {t('communities.members')} · {c.visibility === 'private' ? t('m.community.private') : t('m.community.public')}
          {c.myRole && c.myRole !== 'member' ? ` · ${YOU_ARE[c.myRole] ? t(YOU_ARE[c.myRole]) : roleLabel(c.myRole)}` : ''}
        </span>
        {c.description ? <p style={{ margin: 0 }}>{c.description}</p> : null}
        <div className="row">
          {isMember && c.myRole !== 'guest' ? (
            <Link href={`/create?community=${c.id}`} className="yp-btn yp-btn--primary yp-btn--sm">
              {t('communityPage.postHere')}
            </Link>
          ) : null}
          {chatId ? (
            <Link href={`/inbox/${chatId}`} className="yp-btn yp-btn--secondary yp-btn--sm">
              {t('communityPage.chat')}
            </Link>
          ) : null}
          {canOrganize ? (
            <Link href={`/events/new?community=${c.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
              {t('events.create')}
            </Link>
          ) : null}
          {canManage ? (
            <Link href={`/c/${c.slug}/manage`} className="yp-btn yp-btn--secondary yp-btn--sm">
              {t('m.manage.title')}
            </Link>
          ) : null}
          {signedOut || locked ? null : (
            <Button
              size="sm"
              variant="ghost"
              icon="sparkle"
              loading={summarizing}
              onClick={async () => {
                setSummarizing(true);
                try {
                  const r = await api.ai.assist({ task: 'summarize_community', communityId: c.id });
                  setSummary({ text: String(r.output ?? ''), dev: r.provider === 'dev' });
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setSummarizing(false);
                }
              }}
            >
              {t('community.catchUp')}
            </Button>
          )}
        </div>
        {c.rules.length ? (
          <details>
            <summary>{t('communityPage.rules')}</summary>
            <ol>
              {c.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>

      {signedOut ? <JoinNote text={t('communityPage.joinNote', { name: c.name })} /> : null}

      {summary ? (
        <AIPanel
          title={t('community.catchUp.title')}
          label={t('ai.label')}
          notice={[summary.dev ? t('ai.devNotice') : null, t('community.catchUp.note')].filter(Boolean).join(' ')}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setSummary(null)}>
              {t('m.common.close')}
            </Button>
          }
        >
          {summary.text}
        </AIPanel>
      ) : null}

      {liveRoom && tab !== 'rooms' ? (
        <Link href={`/rooms/${liveRoom.id}`} className="room-banner">
          <Badge tone="danger">{t('m.rooms.live')}</Badge>
          <span className="room-banner__title">{liveRoom.title}</span>
          <span className="muted">{tp('m.rooms.listening', liveRoom.listenerCount)}</span>
        </Link>
      ) : null}

      <Tabs
        id="community-tabs"
        panelId="community-panel"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'posts', label: t('profile.posts') },
          { id: 'faq', label: t('m.community.faq') },
          { id: 'rooms', label: t('m.rooms.tab') },
          { id: 'events', label: t('events.title') },
          ...(signedOut ? [] : [{ id: 'members', label: t('m.community.membersTab'), count: c.memberCount }]),
        ]}
      />
      <div role="tabpanel" id="community-panel" aria-labelledby={`community-tabs-${tab}`}>
        {tab === 'posts' ? (
          c.visibility === 'private' && !isMember ? (
            <Alert tone="info">{t('m.community.locked.posts')}</Alert>
          ) : (
            <PostList load={load} reloadKey={slug} empty={t('communityPage.noPosts')} />
          )
        ) : tab === 'faq' ? (
          c.visibility === 'private' && !isMember ? (
            <Alert tone="info">{t('m.community.locked.faq')}</Alert>
          ) : (
            <CommunityFaq slug={slug} />
          )
        ) : tab === 'rooms' ? (
          signedOut ? (
            <Alert tone="info">{t('communityPage.roomsSignIn')}</Alert>
          ) : (
            <CommunityRooms slug={slug} isMember={isMember} />
          )
        ) : tab === 'events' ? (
          locked ? (
            <Alert tone="info">{t('m.community.locked.events')}</Alert>
          ) : eventsError ? (
            <EmptyState title={eventsError} action={<Button onClick={() => loadEvents(c.id)}>{t('m.common.retry')}</Button>} />
          ) : events === null ? (
            <Skeleton height={80} />
          ) : events.length ? (
            <div className="yp-grid">
              {events.map((e) => (
                <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
              ))}
            </div>
          ) : (
            <p className="muted">{t('communityPage.noEvents')}</p>
          )
        ) : locked ? (
          <Alert tone="info">{t('m.community.locked.members')}</Alert>
        ) : membersError ? (
          <EmptyState title={membersError} action={<Button onClick={loadMembers}>{t('m.common.retry')}</Button>} />
        ) : members === null ? (
          <Skeleton height={120} />
        ) : (
          <List>
            {members.map((m) => (
              <ListItem
                key={m.user.id}
                href={`/u/${m.user.username}`}
                linkAs={NextLink}
                start={<Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />}
                primary={m.user.displayName}
                end={m.role !== 'member' ? <Badge tone="neutral">{roleLabel(m.role)}</Badge> : null}
              />
            ))}
          </List>
        )}
      </div>
    </div>
  );
}
