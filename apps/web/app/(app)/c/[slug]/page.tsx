'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AIPanel, Alert, Avatar, Badge, Button, EmptyState, EventCard, List, ListItem, Skeleton, Tabs } from '@yapilapi/design-system';
import type { Community, EventItem, PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { PostList } from '@/components/PostList';
import { useSession } from '../../../providers';

export default function CommunityPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, toast, locale } = useSession();
  const [c, setC] = useState<(Community & { membershipStatus: string | null }) | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [members, setMembers] = useState<{ user: PublicUser; role: string }[] | null>(null);
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [summary, setSummary] = useState<{ text: string; notice?: string } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [tab, setTab] = useState('posts');

  const reload = useCallback(
    () =>
      api.communities.get(slug).then(
        (r) => {
          setC(r.community);
          setChatId(r.chatConversationId);
        },
        () => setMissing(true),
      ),
    [slug],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!c) return;
    if (tab === 'members' && !members) api.communities.members(slug).then((r) => setMembers(r.items), (e) => (setMembers([]), toast(errorMessage(e))));
    if (tab === 'events' && !events) api.raw.get<{ items: EventItem[] }>(`/v1/events?communityId=${c.id}`).then((r) => setEvents(r.items), () => setEvents([]));
  }, [tab, c, slug, members, events, toast]);
  const load = useCallback((cursor?: string) => api.communities.posts(slug, cursor), [slug]);

  if (missing) return <EmptyState title="Community not found" body="It may have been removed or renamed." />;
  if (!c) return <Skeleton height={200} />;

  const isMember = !!c.myRole;
  const canOrganize = ['owner', 'admin', 'moderator', 'organizer'].includes(c.myRole ?? '');

  return (
    <div className="yp-shell__inner">
      <div className="stack-sm">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1 className="profile__name">{c.name}</h1>
          {isMember ? (
            c.myRole === 'owner' ? (
              <Badge tone="success">Owner</Badge>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await api.communities.leave(slug).catch((e) => toast(errorMessage(e)));
                  await reload();
                }}
              >
                {t('communities.leave')}
              </Button>
            )
          ) : c.membershipStatus === 'pending' ? (
            <Badge tone="warning">Request sent</Badge>
          ) : (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const r = await api.communities.join(slug);
                  toast(r.status === 'pending' ? 'Request sent to the moderators' : `Welcome to ${c.name}`);
                  await reload();
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {c.visibility === 'private' ? 'Request to join' : t('communities.join')}
            </Button>
          )}
        </div>
        <span className="muted">
          {c.memberCount.toLocaleString()} {t('communities.members')} · {c.visibility === 'private' ? 'Private' : 'Public'}
          {c.myRole && c.myRole !== 'member' ? ` · You're ${c.myRole === 'admin' ? 'an' : 'a'} ${c.myRole}` : ''}
        </span>
        {c.description ? <p style={{ margin: 0 }}>{c.description}</p> : null}
        <div className="row">
          {isMember ? (
            <Link href={`/create?community=${c.id}`} className="yp-btn yp-btn--primary yp-btn--sm">
              Post here
            </Link>
          ) : null}
          {chatId ? (
            <Link href={`/inbox/${chatId}`} className="yp-btn yp-btn--secondary yp-btn--sm">
              Community chat
            </Link>
          ) : null}
          {canOrganize ? (
            <Link href={`/events/new?community=${c.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
              {t('events.create')}
            </Link>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon="sparkle"
            loading={summarizing}
            onClick={async () => {
              setSummarizing(true);
              try {
                const r = await api.ai.assist({ task: 'summarize_community', communityId: c.id });
                setSummary({ text: String(r.output ?? ''), notice: r.notice });
              } catch (e) {
                toast(errorMessage(e));
              } finally {
                setSummarizing(false);
              }
            }}
          >
            Catch me up
          </Button>
        </div>
        {c.rules.length ? (
          <details>
            <summary>Community rules</summary>
            <ol>
              {c.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>

      {summary ? (
        <AIPanel title="What's been happening" notice={`${summary.notice ?? ''} Summaries report what members said; they never make decisions for the community.`.trim()} actions={<Button size="sm" variant="ghost" onClick={() => setSummary(null)}>Close</Button>}>
          {summary.text}
        </AIPanel>
      ) : null}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'posts', label: 'Posts' },
          { id: 'events', label: 'Events' },
          { id: 'members', label: 'Members', count: c.memberCount },
        ]}
      />
      {tab === 'posts' ? (
        c.visibility === 'private' && !isMember ? <Alert tone="info">Join this private community to see its posts.</Alert> : <PostList load={load} reloadKey={slug} empty="No posts yet. Start the first discussion." />
      ) : tab === 'events' ? (
        events === null ? <Skeleton height={80} /> : events.length ? <div className="yp-grid">{events.map((e) => <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />)}</div> : <p className="muted">No upcoming events.</p>
      ) : members === null ? (
        <Skeleton height={120} />
      ) : (
        <List>
          {members.map((m) => (
            <ListItem key={m.user.id} href={`/u/${m.user.username}`} linkAs={NextLink} start={<Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />} primary={m.user.displayName} end={m.role !== 'member' ? <Badge tone="neutral">{m.role}</Badge> : null} />
          ))}
        </List>
      )}
    </div>
  );
}
