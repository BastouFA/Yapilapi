import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client } from './api';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Avatar, Button, Field, Icon, useColors, userText } from './ui';

// Same limits as MAX_COLLABORATORS and MAX_PHOTO_TAGS in packages/shared/src/schemas.ts (not imported, to keep zod out of the app bundle).
const MAX_COLLABORATORS = 3;
const MAX_PHOTO_TAGS = 20;

type Person = { user: PublicUser; canTag: boolean };

/** People matching `q` in a suggest scope, debounced (~200 ms); answers to older queries are dropped. */
function usePeople(q: string, scope: 'mutuals' | undefined, enabled: boolean, limit = 6) {
  const [items, setItems] = useState<Person[] | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    if (!enabled) return;
    const timer = setTimeout(() => {
      void client()
        .then((api) => api.people.suggest(q.trim().replace(/^@/, ''), limit, scope))
        .then(
          (r) => id === seq.current && setItems(r.items.map((x) => ({ user: x.user, canTag: x.canTag }))),
          () => id === seq.current && setItems([]),
        );
    }, 200);
    return () => clearTimeout(timer);
  }, [q, scope, enabled, limit]);
  return items;
}

function PersonRow({ user, note, disabled, onPress }: { user: PublicUser; note?: string; disabled?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={note ? `${user.displayName}, @${user.username}, ${note}` : `${user.displayName}, @${user.username}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        minHeight: 44,
        paddingHorizontal: space[2],
        borderRadius: radius.md,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
      })}
    >
      <Avatar name={user.displayName} url={user.avatarUrl} size={30} />
      <View style={{ flex: 1 }}>
        <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
          {user.displayName}
        </Text>
        <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
          @{user.username}
          {note ? ` · ${note}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * "Invite co-authors" in the composer: people you follow who follow you back, up to 3, shown as
 * removable chips. Each of them accepts or declines after the post is shared.
 */
export function CoauthorPicker({ value, onChange }: { value: PublicUser[]; onChange: (v: PublicUser[]) => void }) {
  const c = useColors();
  const { t } = useT();
  const [open, setOpen] = useState(value.length > 0);
  const [q, setQ] = useState('');
  const full = value.length >= MAX_COLLABORATORS;
  const people = usePeople(q, 'mutuals', open && !full);
  const shown = (people ?? []).filter((p) => !value.some((u) => u.id === p.user.id));

  if (!open)
    return (
      <Button
        label={t('m.collab.inviteTitle')}
        icon="people-outline"
        variant="ghost"
        size="sm"
        onPress={() => setOpen(true)}
        style={{ alignSelf: 'flex-start' }}
      />
    );

  return (
    <View style={{ gap: space[2] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '600' }}>
        {t('m.collab.inviteTitle')}
      </Text>
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.collab.inviteHint')}</Text>
      {value.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {value.map((u) => (
            <View
              key={u.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: c.yapiSoft,
                borderRadius: radius.full,
                paddingStart: 4,
                paddingEnd: 8,
                height: 34,
              }}
            >
              <Avatar name={u.displayName} url={u.avatarUrl} size={26} />
              <Text style={[{ color: c.ink, fontWeight: '600', maxWidth: 140 }, userText]} numberOfLines={1}>
                {u.displayName}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.collab.removeInvite', { name: u.displayName })}
                // A 16pt cross in a 34pt chip: 14pt more each way reaches 44 and stays clear of the chips around it.
                hitSlop={14}
                onPress={() => onChange(value.filter((x) => x.id !== u.id))}
              >
                <Icon name="close" size={16} color={c.inkMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {full ? (
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.collab.max', { count: MAX_COLLABORATORS })}</Text>
      ) : (
        <>
          <Field
            label={t('m.collab.search')}
            hideLabel
            placeholder={t('m.collab.search')}
            value={q}
            onChangeText={setQ}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View accessibilityRole="list" accessibilityLabel={t('m.ac.people')}>
            {people === null ? null : shown.length ? (
              shown.map((p) => (
                <PersonRow
                  key={p.user.id}
                  user={p.user}
                  onPress={() => {
                    onChange([...value, p.user]);
                    setQ('');
                  }}
                />
              ))
            ) : (
              <Text style={{ color: c.inkMuted, fontSize: 13, paddingVertical: space[2] }}>{t('m.collab.noneFound')}</Text>
            )}
          </View>
        </>
      )}
    </View>
  );
}

export type DraftTag = { user: PublicUser; x: number; y: number };

/**
 * Tag people in the photo being posted: tap where someone is, then choose who it is. People who
 * don't allow tags from you show but can't be picked.
 */
export function PhotoTagger({ uri, value, onChange }: { uri: string; value: DraftTag[]; onChange: (v: DraftTag[]) => void }) {
  const c = useColors();
  const { t, tp } = useT();
  const [open, setOpen] = useState(value.length > 0);
  const [ratio, setRatio] = useState(1);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const [q, setQ] = useState('');
  const people = usePeople(q, undefined, !!spot, 8);

  useEffect(() => {
    Image.getSize(
      uri,
      (w, h) => w && h && setRatio(Math.max(0.6, Math.min(1.9, w / h))),
      () => {},
    );
  }, [uri]);

  if (!open)
    return (
      <Button
        label={value.length ? tp('m.tags.count', value.length) : t('m.tags.add')}
        icon="person-add-outline"
        variant="ghost"
        size="sm"
        onPress={() => setOpen(true)}
        style={{ alignSelf: 'flex-start' }}
      />
    );

  const full = value.length >= MAX_PHOTO_TAGS;
  return (
    <View style={{ gap: space[2] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '600' }}>
        {t('m.tags.add')}
      </Text>
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.tags.addHint')}</Text>
      <View
        style={{ borderRadius: radius.md, overflow: 'hidden' }}
        onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.tags.tapPhoto')}
          disabled={full}
          onPress={(e) => {
            if (!size) return;
            // A screen reader activates the middle of the photo, which is a fine spot too.
            const lx = Number.isFinite(e.nativeEvent.locationX) ? e.nativeEvent.locationX : size.width / 2;
            const ly = Number.isFinite(e.nativeEvent.locationY) ? e.nativeEvent.locationY : size.height / 2;
            setSpot({ x: Math.min(1, Math.max(0, lx / size.width)), y: Math.min(1, Math.max(0, ly / size.height)) });
            setQ('');
          }}
        >
          <Image source={{ uri }} style={{ width: '100%', aspectRatio: ratio, backgroundColor: c.surfaceSunken }} resizeMode="cover" />
        </Pressable>
        {size
          ? value.map((tag) => (
              <View
                key={tag.user.id}
                pointerEvents="box-none"
                style={{
                  position: 'absolute',
                  left: Math.min(Math.max(tag.x * size.width, 56), Math.max(56, size.width - 56)) - 100,
                  top: Math.min(Math.max(tag.y * size.height - 14, 4), Math.max(4, size.height - 36)),
                  width: 200,
                  alignItems: 'center',
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    backgroundColor: 'rgba(0,0,0,0.78)',
                    borderRadius: 999,
                    paddingHorizontal: 10,
                    minHeight: 28,
                  }}
                >
                  <Text style={[{ color: '#FFFFFF', fontWeight: '700', fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
                    {tag.user.displayName}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('m.tags.remove', { name: tag.user.displayName })}
                    // A 14pt cross: the touch area reaches 44.
                    hitSlop={15}
                    onPress={() => onChange(value.filter((x) => x.user.id !== tag.user.id))}
                  >
                    <Icon name="close" size={14} color="#FFFFFF" />
                  </Pressable>
                </View>
              </View>
            ))
          : null}
        {spot && size ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: spot.x * size.width - 12,
              top: spot.y * size.height - 12,
              width: 24,
              height: 24,
              borderRadius: 12,
              borderWidth: 3,
              borderColor: '#FFFFFF',
              backgroundColor: 'rgba(0,0,0,0.3)',
            }}
          />
        ) : null}
      </View>
      {full ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.tags.max', { count: MAX_PHOTO_TAGS })}</Text> : null}
      {spot ? (
        <View style={{ gap: space[1] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <View style={{ flex: 1 }}>
              <Field
                label={t('m.tags.who')}
                hideLabel
                placeholder={t('m.tags.who')}
                value={q}
                onChangeText={setQ}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
            </View>
            <Button label={t('common.cancel')} variant="ghost" size="sm" onPress={() => setSpot(null)} />
          </View>
          <View accessibilityRole="list" accessibilityLabel={t('m.ac.people')}>
            {(people ?? []).map((p) => (
              <PersonRow
                key={p.user.id}
                user={p.user}
                disabled={!p.canTag}
                note={p.canTag ? undefined : t('m.tags.cantTag')}
                onPress={() => {
                  onChange([...value.filter((x) => x.user.id !== p.user.id), { user: p.user, ...spot }]);
                  setSpot(null);
                  setQ('');
                }}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
