import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Share, Text, View } from 'react-native';
import { client, errorMessage } from './api';
import { matchContacts, readContacts, type ContactsResult, type DeviceContact } from './contacts';
import { useT } from './i18n';
import { space } from './theme';
import { Avatar, Button, Card, Loading, Notice, useColors, userText } from './ui';

/** How many contacts to list for inviting; the share button covers everyone else. */
const INVITE_ROWS = 100;

/**
 * Find friends from the address book. Nothing is read until the person taps the button;
 * emails (and later phone numbers) are hashed on the phone, and only hashes are sent. People
 * already here get a Follow button; the others can be invited with your invite link.
 */
export function FriendsFinder({ onChecked }: { onChecked?: (r: { checked: number; found: number }) => void }) {
  const c = useColors();
  const { t } = useT();
  const [state, setState] = useState<'idle' | 'checking' | 'denied' | 'done'>('idle');
  const [result, setResult] = useState<ContactsResult | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void client()
      .then((api) => api.invites.mine())
      .then((r) => setLink(r.link))
      .catch(() => {});
  }, []);

  async function check() {
    setError(null);
    setState('checking');
    try {
      const contacts = await readContacts();
      if (!contacts) return setState('denied');
      const r = await matchContacts(contacts);
      setResult(r);
      setFollowing(new Set(r.found.filter((f) => f.following).map((f) => f.user.id)));
      setState('done');
      onChecked?.({ checked: r.checked, found: r.found.length });
    } catch (e) {
      setError(errorMessage(e));
      setState('idle');
    }
  }

  async function toggle(id: string) {
    const on = following.has(id);
    const next = new Set(following);
    if (on) next.delete(id);
    else next.add(id);
    setFollowing(next);
    try {
      const api = await client();
      await (on ? api.users.unfollow(id) : api.users.follow(id));
    } catch (e) {
      setFollowing(following);
      setError(errorMessage(e));
    }
  }

  async function invite(to?: DeviceContact) {
    if (!link) return;
    const message = t('invite.shareText');
    const body = encodeURIComponent(`${message}\n${link}`);
    // A text message to their number, or an email, opened on the phone; otherwise the share sheet.
    const direct = to?.phones[0]
      ? `sms:${to.phones[0]}${Platform.OS === 'ios' ? '&' : '?'}body=${body}`
      : to?.emails[0]
        ? `mailto:${to.emails[0]}?subject=${encodeURIComponent(message)}&body=${body}`
        : null;
    if (direct) {
      try {
        return await Linking.openURL(direct);
      } catch {
        // No messages or mail app: fall back to the share sheet.
      }
    }
    try {
      await Share.share(Platform.OS === 'ios' ? { url: link, message } : { message: `${message}\n${link}`, title: message });
    } catch {
      // The person closed the share sheet.
    }
  }

  return (
    <View style={{ gap: space[3] }}>
      <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 21 }}>{t('friends.body')}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {state === 'idle' ? <Button label={t('friends.allow')} icon="people-outline" onPress={() => void check()} /> : null}
      {state === 'checking' ? (
        <View style={{ gap: space[2], alignItems: 'center', paddingVertical: space[4] }}>
          <Loading />
          <Text style={{ color: c.inkMuted }}>{t('friends.checking')}</Text>
        </View>
      ) : null}
      {state === 'denied' ? (
        <View style={{ gap: space[2] }}>
          <Notice tone="warn">{t('friends.denied')}</Notice>
          <Button label={t('friends.openSettings')} variant="secondary" onPress={() => void Linking.openSettings()} />
        </View>
      ) : null}

      {state === 'done' && result ? (
        <>
          <Card style={{ gap: space[3] }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
              {t('friends.found')}
            </Text>
            {result.found.length ? (
              result.found.map((f) => {
                const on = following.has(f.user.id);
                return (
                  <View key={f.user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                    <Pressable
                      accessibilityRole="link"
                      onPress={() => router.push(`/u/${f.user.username}`)}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[3] }}
                    >
                      <Avatar name={f.user.displayName} url={f.user.avatarUrl} size={40} />
                      <View style={{ flex: 1 }}>
                        <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                          {f.user.displayName}
                        </Text>
                        <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                          {f.followsYou ? `${f.contactName} · ${t('friends.followsYou')}` : f.contactName}
                        </Text>
                      </View>
                    </Pressable>
                    <Button
                      size="sm"
                      variant={on ? 'secondary' : 'primary'}
                      label={on ? t('profile.unfollow') : t('profile.follow')}
                      onPress={() => void toggle(f.user.id)}
                    />
                  </View>
                );
              })
            ) : (
              <Text style={{ color: c.inkMuted }}>{t('friends.none')}</Text>
            )}
          </Card>

          {link && result.others.length ? (
            <Card style={{ gap: space[3] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
                {t('friends.invite.title')}
              </Text>
              <Button label={t('invite.share')} icon="share-outline" variant="secondary" onPress={() => void invite()} />
              {result.others.slice(0, INVITE_ROWS).map((o) => (
                <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                  <Avatar name={o.name} size={36} />
                  <Text style={[{ flex: 1, color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
                    {o.name}
                  </Text>
                  <Button size="sm" variant="ghost" label={t('friends.invite')} onPress={() => void invite(o)} />
                </View>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
