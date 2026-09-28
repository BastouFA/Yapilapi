import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { ApiError, type FaqEntry } from '../../../packages/api-client/src/index';
import { COMMUNITY_ROLE_RANK, type CommunityRole } from '../../../packages/shared/src/constants';
import type { Community, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage, isGone } from '../lib/api';
import { Chip, ChipRow } from '../lib/chips';
import { ChoiceField, FieldError, Pill, splitRules, TopicsField } from '../lib/forms';
import { ROLE_LABEL, roleName, roleRank as rank } from '../lib/community-roles';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Avatar, Button, Card, EmptyState, Field, Icon, KeyboardAvoid, Loading, Notice, ScreenError, Title, useColors, userText } from '../lib/ui';

type Section = 'details' | 'members' | 'requests' | 'banned' | 'faq';
type Member = { user: PublicUser; role: string; joinedAt?: string };
type Assignable = 'admin' | 'moderator' | 'organizer' | 'member' | 'guest';

const ASSIGNABLE: Assignable[] = ['admin', 'moderator', 'organizer', 'member', 'guest'];

/**
 * Running a community, for its owner, admins and moderators: the details (admins and the owner),
 * members and their roles, requests to join, bans, and the FAQ. Everyone manages only people
 * below them and gives only roles below their own, as the API checks.
 */
export default function CommunitySettings() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const c = useColors();
  const { t } = useT();
  const [community, setCommunity] = useState<Community | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section | null>(null);

  const load = useCallback(async () => {
    try {
      setCommunity((await (await client()).communities.get(slug)).community);
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setCommunity(null);
      else setLoadError(errorMessage(e));
    }
  }, [slug]);
  useEffect(() => {
    void load();
  }, [load]);

  if (community === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  const myRank = rank(community?.myRole);
  if (!community || myRank < COMMUNITY_ROLE_RANK.moderator)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.manage.noAccess')} body={t('m.manage.noAccessBody')} />
      </View>
    );

  const sections: { id: Section; label: string }[] = [
    ...(myRank >= COMMUNITY_ROLE_RANK.admin ? [{ id: 'details' as const, label: t('m.manage.details') }] : []),
    { id: 'members', label: t('m.community.membersTab') },
    { id: 'requests', label: t('m.manage.requests') },
    { id: 'banned', label: t('m.manage.banned') },
    { id: 'faq', label: t('m.community.faq') },
  ];
  const current = section ?? sections[0]!.id;

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Title sub={t('m.manage.youAre', { role: roleName(community.myRole ?? '', t) })}>{community.name}</Title>
        <ChipRow scroll tabs label={t('m.manage.sections')}>
          {sections.map((s) => (
            <Chip key={s.id} label={s.label} selected={s.id === current} onPress={() => setSection(s.id)} />
          ))}
        </ChipRow>
        {current === 'details' ? (
          <Details community={community} onSaved={(next) => setCommunity(next)} />
        ) : current === 'members' ? (
          <Members slug={slug} myRole={community.myRole!} />
        ) : current === 'requests' ? (
          <Requests slug={slug} />
        ) : current === 'banned' ? (
          <Banned slug={slug} />
        ) : (
          <FaqManager slug={slug} />
        )}
      </ScrollView>
    </KeyboardAvoid>
  );
}

function Details({ community, onSaved }: { community: Community; onSaved: (c: Community) => void }) {
  const { t } = useT();
  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description);
  const [visibility, setVisibility] = useState(community.visibility);
  const [topics, setTopics] = useState(community.topics);
  const [rules, setRules] = useState(community.rules.join('\n'));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function save() {
    setBusy(true);
    setNote(null);
    setError(null);
    setFields({});
    try {
      const r = await (
        await client()
      ).communities.update(community.slug, { name: name.trim(), description: description.trim(), visibility, topics, rules: splitRules(rules) });
      onSaved(r.community);
      setNote(t('m.manage.saved'));
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.fields) setFields(e.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: space[3] }}>
      <Card style={{ gap: space[3] }}>
        <Field label={t('m.communityForm.name')} value={name} onChangeText={setName} maxLength={80} />
        <FieldError text={fields.name} />
        <Field
          label={t('m.communityForm.about')}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={2000}
          style={{ minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }}
        />
        <ChoiceField
          label={t('m.communityForm.whoJoins')}
          value={visibility}
          onChange={setVisibility}
          hint={visibility === 'public' ? t('m.communityForm.publicHint') : t('m.communityForm.privateHint')}
          options={[
            { id: 'public', label: t('m.community.public'), icon: 'earth-outline' },
            { id: 'private', label: t('m.community.private'), icon: 'lock-closed-outline' },
          ]}
        />
      </Card>
      <Card style={{ gap: space[3] }}>
        <TopicsField label={t('m.communityForm.topics')} hint={t('m.communityForm.topicsHint')} value={topics} onChange={setTopics} />
        <Field
          label={t('m.communityForm.rules')}
          value={rules}
          onChangeText={setRules}
          multiline
          style={{ minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }}
        />
        <FieldError text={fields.rules ?? fields['rules.0']} />
      </Card>
      {note ? <Notice>{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button label={busy ? t('m.common.saving') : t('common.save')} disabled={!name.trim() || busy} onPress={() => save()} />
    </View>
  );
}

/** Loads one list of people (members, requests or bans), with a way to act on each and reload. */
function usePeople(slug: string, status: 'active' | 'pending' | 'banned') {
  const [items, setItems] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setItems((await (await client()).communities.members(slug, status)).items);
    } catch (e) {
      setItems([]);
      setError(errorMessage(e));
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
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return { items, error, act };
}

function Members({ slug, myRole }: { slug: string; myRole: CommunityRole }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const { items, error, act } = usePeople(slug, 'active');
  const [open, setOpen] = useState<string | null>(null);
  const mine = rank(myRole);
  if (!items) return <Loading />;
  return (
    <View style={{ gap: space[2] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.manage.membersHint')}</Text>
      {items.map((m) => {
        const theirs = rank(m.role);
        const canManage = m.user.id !== me?.id && theirs < mine;
        return (
          <PersonCard
            key={m.user.id}
            member={m}
            expanded={open === m.user.id}
            onToggle={canManage ? () => setOpen(open === m.user.id ? null : m.user.id) : undefined}
          >
            {mine >= COMMUNITY_ROLE_RANK.admin ? (
              <ChoiceField<Assignable>
                label={t('m.manage.role')}
                value={(ASSIGNABLE.includes(m.role as Assignable) ? m.role : 'member') as Assignable}
                onChange={(role) => void act(async () => (await client()).communities.setRole(slug, m.user.id, role))}
                options={ASSIGNABLE.filter((r) => COMMUNITY_ROLE_RANK[r] < mine).map((r) => ({ id: r, label: t(ROLE_LABEL[r]) }))}
              />
            ) : null}
            <Button
              label={t('m.manage.ban')}
              variant="danger"
              size="sm"
              icon="ban-outline"
              style={{ alignSelf: 'flex-start' }}
              onPress={() =>
                Alert.alert(t('m.manage.banTitle', { name: m.user.displayName }), t('m.manage.banBody'), [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('m.manage.ban'),
                    style: 'destructive',
                    onPress: () => void act(async () => (await client()).communities.ban(slug, m.user.id)),
                  },
                ])
              }
            />
          </PersonCard>
        );
      })}
    </View>
  );
}

function Requests({ slug }: { slug: string }) {
  const { t } = useT();
  const { items, error, act } = usePeople(slug, 'pending');
  if (!items) return <Loading />;
  return (
    <View style={{ gap: space[2] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items.length ? (
        items.map((m) => (
          <PersonCard key={m.user.id} member={m} hideRole>
            <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
              <Button
                label={t('m.common.accept')}
                size="sm"
                icon="checkmark"
                onPress={() => act(async () => (await client()).communities.approve(slug, m.user.id))}
              />
              <Button
                label={t('m.common.decline')}
                size="sm"
                variant="secondary"
                onPress={() => act(async () => (await client()).communities.decline(slug, m.user.id))}
              />
            </View>
          </PersonCard>
        ))
      ) : (
        <EmptyState title={t('m.manage.noRequests')} body={t('m.manage.noRequestsBody')} />
      )}
    </View>
  );
}

function Banned({ slug }: { slug: string }) {
  const { t } = useT();
  const { items, error, act } = usePeople(slug, 'banned');
  if (!items) return <Loading />;
  return (
    <View style={{ gap: space[2] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items.length ? (
        items.map((m) => (
          <PersonCard key={m.user.id} member={m} hideRole>
            <Button
              label={t('m.manage.unban')}
              size="sm"
              variant="secondary"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => act(async () => (await client()).communities.unban(slug, m.user.id))}
            />
          </PersonCard>
        ))
      ) : (
        <EmptyState title={t('m.manage.noBans')} body={t('m.manage.noBansBody')} />
      )}
    </View>
  );
}

/** A person in a list, with the actions on them always shown, or shown when `onToggle` opens them. */
function PersonCard({
  member,
  children,
  expanded,
  onToggle,
  hideRole,
}: {
  member: Member;
  children?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  hideRole?: boolean;
}) {
  const c = useColors();
  const { t } = useT();
  const collapsible = expanded !== undefined;
  const showActions = collapsible ? !!expanded && !!onToggle : true;
  return (
    <Card style={{ gap: space[3], padding: space[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('m.manage.openProfile', { name: member.user.displayName })}
          onPress={() => router.push(`/u/${encodeURIComponent(member.user.username)}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], flex: 1, minHeight: 44 }}
        >
          <Avatar name={member.user.displayName} url={member.user.avatarUrl} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 15 }, userText]} numberOfLines={1}>
              {member.user.displayName}
            </Text>
            <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
              @{member.user.username}
            </Text>
          </View>
        </Pressable>
        {hideRole ? null : <Pill text={roleName(member.role, t)} tone={member.role === 'member' ? 'neutral' : 'good'} />}
        {collapsible && onToggle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.manage.manageMember', { name: member.user.displayName })}
            accessibilityState={{ expanded: !!expanded }}
            onPress={onToggle}
            hitSlop={4}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={expanded ? 'chevron-up' : 'ellipsis-horizontal'} size={20} color={c.inkMuted} />
          </Pressable>
        ) : null}
      </View>
      {showActions && children ? <View style={{ gap: space[3] }}>{children}</View> : null}
    </Card>
  );
}

function FaqManager({ slug }: { slug: string }) {
  const c = useColors();
  const { t } = useT();
  const [items, setItems] = useState<FaqEntry[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setItems((await (await client()).communities.faq(slug)).items);
    } catch (e) {
      setItems([]);
      setError(errorMessage(e));
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
      const api = await client();
      for (const [i, f] of next.entries()) if (f.position !== i) await api.communities.updateFaq(slug, f.id, { position: i });
    });

  if (!items) return <Loading />;
  return (
    <View style={{ gap: space[3] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items.length ? null : <EmptyState title={t('m.community.noFaq.title')} body={t('m.community.noFaq.editor')} />}
      {items.map((f, i) =>
        editing === f.id ? (
          <FaqForm
            key={f.id}
            title={t('m.manage.editQuestion')}
            initial={f}
            onCancel={() => setEditing(null)}
            onSave={async (b) => {
              await (await client()).communities.updateFaq(slug, f.id, b);
              setEditing(null);
              await reload();
            }}
          />
        ) : (
          <Card key={f.id} style={{ gap: space[2] }}>
            <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]}>{f.question}</Text>
            <Text style={[{ color: c.inkMuted, lineHeight: 20 }, userText]} numberOfLines={3}>
              {f.answer}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              <Button label={t('m.manage.edit')} size="sm" variant="secondary" icon="create-outline" onPress={() => setEditing(f.id)} />
              <IconButton icon="arrow-up" label={t('m.manage.moveUp')} disabled={busy || i === 0} onPress={() => void move(i, i - 1)} />
              <IconButton icon="arrow-down" label={t('m.manage.moveDown')} disabled={busy || i === items.length - 1} onPress={() => void move(i, i + 1)} />
              <Button
                label={t('m.common.remove')}
                size="sm"
                variant="ghost"
                onPress={() =>
                  Alert.alert(t('m.manage.removeQuestion'), f.question, [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('m.common.remove'),
                      style: 'destructive',
                      onPress: () => void run(async () => (await client()).communities.deleteFaq(slug, f.id)),
                    },
                  ])
                }
              />
            </View>
          </Card>
        ),
      )}
      <FaqForm
        key={`new-${items.length}`}
        title={t('m.faq.add.title')}
        onSave={async (b) => {
          await (await client()).communities.addFaq(slug, b);
          await reload();
        }}
      />
    </View>
  );
}

function IconButton({ icon, label, disabled, onPress }: { icon: 'arrow-up' | 'arrow-down'; label: string; disabled?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 36,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: c.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
      hitSlop={4}
    >
      <Icon name={icon} size={18} color={c.ink} />
    </Pressable>
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
  const { t } = useT();
  const [q, setQ] = useState(initial?.question ?? '');
  const [a, setA] = useState(initial?.answer ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={{ gap: space[3] }}>
      <Title>{title}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field label={t('m.faq.question')} value={q} onChangeText={setQ} maxLength={300} />
      <Field
        label={t('m.faq.answer')}
        value={a}
        onChangeText={setA}
        multiline
        maxLength={4000}
        style={{ minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }}
      />
      <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
        <Button
          label={saving ? t('m.common.saving') : initial ? t('common.save') : t('m.faq.add')}
          disabled={q.trim().length < 5 || !a.trim() || saving}
          onPress={async () => {
            setSaving(true);
            setError(null);
            try {
              await onSave({ question: q.trim(), answer: a.trim() });
              if (!initial) {
                setQ('');
                setA('');
              }
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setSaving(false);
            }
          }}
        />
        {onCancel ? <Button label={t('common.cancel')} variant="secondary" onPress={onCancel} /> : null}
      </View>
    </Card>
  );
}
