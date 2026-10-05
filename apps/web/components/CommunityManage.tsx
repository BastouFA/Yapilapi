'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, List, ListItem, Select, Skeleton, Tabs, TextField } from '@yapilapi/design-system';
import type { FaqEntry } from '@yapilapi/api-client';
import { COMMUNITY_ROLE_RANK, type Community, type CommunityRole, type MessageKey, type PublicUser } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors, isGone } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '@/app/providers';

type Section = 'details' | 'members' | 'requests' | 'banned' | 'faq';
type Member = { user: PublicUser; role: string; joinedAt?: string };
type Assignable = 'admin' | 'moderator' | 'organizer' | 'member' | 'guest';
const ASSIGNABLE: Assignable[] = ['admin', 'moderator', 'organizer', 'member', 'guest'];

export const ROLE_LABEL: Record<CommunityRole, MessageKey> = {
  owner: 'm.role.owner',
  admin: 'm.role.admin',
  moderator: 'm.role.moderator',
  organizer: 'm.role.organizer',
  member: 'm.role.member',
  guest: 'm.role.guest',
};
const rank = (role: string | null | undefined) => (role && role in COMMUNITY_ROLE_RANK ? COMMUNITY_ROLE_RANK[role as CommunityRole] : -1);

/**
 * Running a community on the web, for its owner, admins and moderators: the details (admins and
 * the owner), members and their roles, requests to join, bans and the FAQ. Everyone manages only
 * people below them and gives only roles below their own, as the API checks; the owner can hand
 * the community to another member.
 */
export function CommunityManage({ slug, initialSection }: { slug: string; initialSection?: string | null }) {
  const { t } = useSession();
  const [community, setCommunity] = useState<Community | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section | null>(
    (['details', 'members', 'requests', 'banned', 'faq'] as const).find((x) => x === initialSection) ?? null,
  );

  const load = useCallback(() => {
    setLoadError(null);
    api.communities.get(slug).then(
      (r) => setCommunity(r.community),
      (e) => (isGone(e) ? setCommunity(null) : setLoadError(errorMessage(e))),
    );
  }, [slug]);
  useEffect(() => {
    load();
  }, [load]);

  if (community === undefined)
    return loadError ? <EmptyState level={1} title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} /> : <Skeleton height={240} />;
  const mine = rank(community?.myRole);
  if (!community || mine < COMMUNITY_ROLE_RANK.moderator) return <EmptyState level={1} title={t('m.manage.noAccess')} body={t('m.manage.noAccessBody')} />;

  const sections: { id: Section; label: string }[] = [
    ...(mine >= COMMUNITY_ROLE_RANK.admin ? [{ id: 'details' as const, label: t('m.manage.details') }] : []),
    { id: 'members', label: t('m.community.membersTab') },
    { id: 'requests', label: t('m.manage.requests') },
    { id: 'banned', label: t('m.manage.banned') },
    { id: 'faq', label: t('m.community.faq') },
  ];
  const current = sections.find((x) => x.id === section)?.id ?? sections[0]!.id;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <div className="stack-sm" style={{ gap: 2 }}>
          <Link href={`/c/${community.slug}`} className="muted">
            {community.name}
          </Link>
          <h1>{t('m.manage.title')}</h1>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('m.manage.youAre', { role: t(ROLE_LABEL[community.myRole as CommunityRole] ?? 'm.role.member') })}
      </p>
      <Tabs id="manage-tabs" panelId="manage-panel" value={current} onChange={(id) => setSection(id as Section)} tabs={sections} />
      <div role="tabpanel" id="manage-panel" aria-labelledby={`manage-tabs-${current}`} className="stack">
        {current === 'details' ? (
          <Details community={community} onSaved={setCommunity} />
        ) : current === 'members' ? (
          <Members slug={community.slug} myRole={community.myRole as CommunityRole} onOwnerChanged={load} />
        ) : current === 'requests' ? (
          <Requests slug={community.slug} />
        ) : current === 'banned' ? (
          <Banned slug={community.slug} />
        ) : (
          <FaqManager slug={community.slug} />
        )}
      </div>
    </div>
  );
}

function Details({ community, onSaved }: { community: Community; onSaved: (c: Community) => void }) {
  const { t, toast } = useSession();
  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description);
  const [visibility, setVisibility] = useState(community.visibility);
  const [topics, setTopics] = useState(community.topics.join(', '));
  const [rules, setRules] = useState(community.rules.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setFields({});
        try {
          const r = await api.communities.update(community.slug, {
            name: name.trim(),
            description: description.trim(),
            visibility,
            topics: topics
              .split(/[,\s#]+/)
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 5),
            rules: rules
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 20),
          });
          onSaved(r.community);
          toast(t('m.manage.saved'));
        } catch (err) {
          setError(errorMessage(err));
          setFields(fieldErrors(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('m.communityForm.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} required maxLength={80} error={fields.name} />
      <TextField
        label={t('m.communityForm.about')}
        multiline
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        maxLength={2000}
        error={fields.description}
      />
      <Select label={t('m.communityForm.whoJoins')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as Community['visibility'])}>
        <option value="public">{t('m.communityForm.publicHint')}</option>
        <option value="private">{t('m.communityForm.privateHint')}</option>
      </Select>
      <TextField label={t('m.communityForm.topics')} value={topics} onChange={(e) => setTopics(e.currentTarget.value)} hint={t('compose.topicsHint')} />
      <TextField
        label={t('m.communityForm.rules')}
        multiline
        value={rules}
        onChange={(e) => setRules(e.currentTarget.value)}
        hint={t('m.communityForm.rulesHint')}
        error={fields.rules ?? fields['rules.0']}
      />
      <div>
        <Button type="submit" loading={busy} disabled={!name.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** One list of people (members, requests or bans), with a way to act on each and reload. */
function usePeople(slug: string, status: 'active' | 'pending' | 'banned') {
  const [items, setItems] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      setItems((await api.communities.members(slug, status)).items);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [slug, status]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      await reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  return { items, loadError, error, act, reload };
}

function PeopleState({ loadError, reload }: { loadError: string | null; reload: () => void }) {
  const { t } = useSession();
  return loadError ? <EmptyState title={loadError} action={<Button onClick={reload}>{t('m.common.retry')}</Button>} /> : <Skeleton height={160} />;
}

function Person({ m, end, showRole = true }: { m: Member; end?: ReactNode; showRole?: boolean }) {
  const { t } = useSession();
  return (
    <ListItem
      start={<Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />}
      primary={
        <Link href={`/u/${m.user.username}`} aria-label={t('m.manage.openProfile', { name: m.user.displayName })}>
          {m.user.displayName}
        </Link>
      }
      secondary={
        <>
          @{m.user.username}
          {showRole && m.role !== 'member' ? (
            <>
              {' '}
              <Badge tone={m.role === 'owner' ? 'success' : 'neutral'}>{t(ROLE_LABEL[m.role as CommunityRole] ?? 'm.role.member')}</Badge>
            </>
          ) : null}
        </>
      }
      end={end}
      linkAs={NextLink}
    />
  );
}

function Members({ slug, myRole, onOwnerChanged }: { slug: string; myRole: CommunityRole; onOwnerChanged: () => void }) {
  const { t, me, toast } = useSession();
  const { items, loadError, error, act, reload } = usePeople(slug, 'active');
  const [banning, setBanning] = useState<Member | null>(null);
  const [handing, setHanding] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = rank(myRole);
  if (!items) return <PeopleState loadError={loadError} reload={() => void reload()} />;
  return (
    <div className="stack-sm manage-people">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p className="muted" style={{ margin: 0 }}>
        {t('m.manage.membersHint')}
      </p>
      <List label={t('m.community.membersTab')}>
        {items.map((m) => {
          const canManage = m.user.id !== me?.id && rank(m.role) < mine;
          return (
            <Person
              key={m.user.id}
              m={m}
              end={
                canManage ? (
                  <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {mine >= COMMUNITY_ROLE_RANK.admin ? (
                      <Select
                        label={t('m.manage.role')}
                        className="manage__role"
                        value={ASSIGNABLE.includes(m.role as Assignable) ? m.role : 'member'}
                        onChange={(e) => {
                          const role = e.currentTarget.value as Assignable;
                          void act(() => api.communities.setRole(slug, m.user.id, role));
                        }}
                      >
                        {ASSIGNABLE.filter((r) => COMMUNITY_ROLE_RANK[r] < mine).map((r) => (
                          <option key={r} value={r}>
                            {t(ROLE_LABEL[r])}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                    {myRole === 'owner' && m.role !== 'guest' ? (
                      <Button size="sm" variant="secondary" onClick={() => setHanding(m)}>
                        {t('m.manage.makeOwner')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => setBanning(m)}>
                      {t('m.manage.ban')}
                    </Button>
                  </div>
                ) : null
              }
            />
          );
        })}
      </List>
      <Dialog
        open={!!banning}
        onClose={() => setBanning(null)}
        title={banning ? t('m.manage.banTitle', { name: banning.user.displayName }) : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBanning(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                if (!banning) return;
                setBusy(true);
                await act(() => api.communities.ban(slug, banning.user.id));
                setBusy(false);
                setBanning(null);
              }}
            >
              {t('m.manage.ban')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('m.manage.banBody')}</p>
      </Dialog>
      <Dialog
        open={!!handing}
        onClose={() => setHanding(null)}
        title={handing ? t('m.manage.makeOwnerTitle', { name: handing.user.displayName }) : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setHanding(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                if (!handing) return;
                setBusy(true);
                const ok = await act(() => api.communities.makeOwner(slug, handing.user.id));
                setBusy(false);
                if (ok) {
                  toast(t('m.manage.ownerChanged', { name: handing.user.displayName }));
                  onOwnerChanged();
                }
                setHanding(null);
              }}
            >
              {t('m.manage.makeOwner')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('m.manage.makeOwnerBody')}</p>
      </Dialog>
    </div>
  );
}

function Requests({ slug }: { slug: string }) {
  const { t } = useSession();
  const { items, loadError, error, act, reload } = usePeople(slug, 'pending');
  if (!items) return <PeopleState loadError={loadError} reload={() => void reload()} />;
  return (
    <div className="stack-sm manage-people">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {items.length ? (
        <List label={t('m.manage.requests')}>
          {items.map((m) => (
            <Person
              key={m.user.id}
              m={m}
              showRole={false}
              end={
                <div className="row">
                  <Button size="sm" onClick={() => void act(() => api.communities.approve(slug, m.user.id))}>
                    {t('m.common.accept')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void act(() => api.communities.decline(slug, m.user.id))}>
                    {t('m.common.decline')}
                  </Button>
                </div>
              }
            />
          ))}
        </List>
      ) : (
        <EmptyState title={t('m.manage.noRequests')} body={t('m.manage.noRequestsBody')} />
      )}
    </div>
  );
}

function Banned({ slug }: { slug: string }) {
  const { t } = useSession();
  const { items, loadError, error, act, reload } = usePeople(slug, 'banned');
  if (!items) return <PeopleState loadError={loadError} reload={() => void reload()} />;
  return (
    <div className="stack-sm manage-people">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {items.length ? (
        <List label={t('m.manage.banned')}>
          {items.map((m) => (
            <Person
              key={m.user.id}
              m={m}
              showRole={false}
              end={
                <Button size="sm" variant="secondary" onClick={() => void act(() => api.communities.unban(slug, m.user.id))}>
                  {t('m.manage.unban')}
                </Button>
              }
            />
          ))}
        </List>
      ) : (
        <EmptyState title={t('m.manage.noBans')} body={t('m.manage.noBansBody')} />
      )}
    </div>
  );
}

function FaqManager({ slug }: { slug: string }) {
  const { t } = useSession();
  const [items, setItems] = useState<FaqEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FaqEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      setItems((await api.communities.faq(slug)).items);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [slug]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  /** Moves one question up or down: every question gets its place in the new order. */
  const move = (from: number, to: number) =>
    run(async () => {
      if (!items) return;
      const next = [...items];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x!);
      for (const [i, f] of next.entries()) if (f.position !== i) await api.communities.updateFaq(slug, f.id, { position: i });
    });

  if (!items) return <PeopleState loadError={loadError} reload={() => void reload()} />;
  return (
    <div className="stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {items.length ? null : <EmptyState title={t('m.community.noFaq.title')} body={t('m.community.noFaq.editor')} />}
      {items.map((f, i) =>
        editing === f.id ? (
          <FaqForm
            key={f.id}
            title={t('m.manage.editQuestion')}
            initial={f}
            onCancel={() => setEditing(null)}
            onSave={async (b) => {
              await api.communities.updateFaq(slug, f.id, b);
              setEditing(null);
              await reload();
            }}
          />
        ) : (
          <Card key={f.id} title={f.question}>
            <div className="stack-sm">
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{f.answer}</p>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Button size="sm" variant="secondary" onClick={() => setEditing(f.id)}>
                  {t('m.manage.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="chevron-up"
                  aria-label={t('m.manage.moveUp')}
                  disabled={busy || i === 0}
                  onClick={() => void move(i, i - 1)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="chevron-down"
                  aria-label={t('m.manage.moveDown')}
                  disabled={busy || i === items.length - 1}
                  onClick={() => void move(i, i + 1)}
                />
                <Button size="sm" variant="ghost" onClick={() => setRemoving(f)}>
                  {t('m.common.remove')}
                </Button>
              </div>
            </div>
          </Card>
        ),
      )}
      <FaqForm
        key={`new-${items.length}`}
        title={t('m.faq.add.title')}
        onSave={async (b) => {
          await api.communities.addFaq(slug, b);
          await reload();
        }}
      />
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t('m.manage.removeQuestion')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                const f = removing;
                setRemoving(null);
                if (f) await run(() => api.communities.deleteFaq(slug, f.id));
              }}
            >
              {t('m.common.remove')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{removing?.question}</p>
      </Dialog>
    </div>
  );
}

function FaqForm({
  title,
  initial,
  onSave,
  onCancel,
}: {
  title: string;
  initial?: FaqEntry;
  onSave: (b: { question: string; answer: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useSession();
  const [q, setQ] = useState(initial?.question ?? '');
  const [a, setA] = useState(initial?.answer ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title={title}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await onSave({ question: q.trim(), answer: a.trim() });
            if (!initial) {
              setQ('');
              setA('');
            }
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField label={t('m.faq.question')} value={q} onChange={(e) => setQ(e.currentTarget.value)} minLength={5} maxLength={300} required />
        <TextField label={t('m.faq.answer')} multiline value={a} onChange={(e) => setA(e.currentTarget.value)} maxLength={4000} required />
        <div className="row">
          <Button type="submit" size="sm" loading={saving} disabled={q.trim().length < 5 || !a.trim()}>
            {initial ? t('common.save') : t('m.faq.add')}
          </Button>
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
