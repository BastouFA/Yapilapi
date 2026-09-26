'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Avatar, Button, TextField } from '@yapilapi/design-system';
import type { ContactMatch } from '@yapilapi/api-client';
import { contactHashInput, emailsIn } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Find friends from a pasted list of email addresses. Each address is normalized and hashed
 * in the browser (Web Crypto) with the server's salt; only the hashes are sent. People already
 * here get a Follow button; the others can be invited by email with your invite link.
 */
export function FindFriends({ onChecked }: { onChecked?: (result: { checked: number; found: number }) => void }) {
  const { t, toast } = useSession();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<ContactMatch[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  useEffect(() => {
    api.invites.mine().then(
      (r) => setInviteLink(r.link),
      () => {},
    );
  }, []);

  async function lookUp() {
    setError(null);
    const emails = emailsIn(text);
    if (!emails.length) {
      setError(t('friends.web.noEmails'));
      return;
    }
    setBusy(true);
    try {
      const { salt, maxHashes } = await api.contacts.salt();
      const byHash = new Map<string, string>();
      for (const e of emails) byHash.set(await sha256Hex(contactHashInput(salt, 'email', e)), e);
      const hashes = [...byHash.keys()];
      const items: ContactMatch[] = [];
      for (let i = 0; i < hashes.length; i += maxHashes) items.push(...(await api.contacts.match(hashes.slice(i, i + maxHashes), 'web')).items);
      const matched = new Set(items.flatMap((m) => m.hashes.map((h) => byHash.get(h))));
      setFound(items);
      setFollowing(new Set(items.filter((m) => m.following).map((m) => m.user.id)));
      setMissing(emails.filter((e) => !matched.has(e)));
      onChecked?.({ checked: emails.length, found: items.length });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string) {
    const on = following.has(id);
    const next = new Set(following);
    if (on) next.delete(id);
    else next.add(id);
    setFollowing(next);
    try {
      await (on ? api.users.unfollow(id) : api.users.follow(id));
    } catch (e) {
      setFollowing(following);
      toast(errorMessage(e));
    }
  }

  const mailto = (email: string) =>
    `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(t('invite.shareText'))}&body=${encodeURIComponent(`${t('invite.shareText')}\n${inviteLink ?? ''}`)}`;

  return (
    <div className="stack find-friends">
      <p className="muted">{t('friends.web.body')}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField
        multiline
        label={t('friends.web.label')}
        rows={4}
        value={text}
        placeholder="name@example.com"
        onChange={(e) => setText(e.currentTarget.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Button onClick={lookUp} loading={busy} disabled={!text.trim()}>
        {t('friends.web.submit')}
      </Button>

      {found ? (
        <section className="stack-sm" aria-labelledby="ff-found">
          <h2 id="ff-found" className="section-title">
            {t('friends.found')}
          </h2>
          {found.length ? (
            <ul className="find-friends__list">
              {found.map((m) => {
                const on = following.has(m.user.id);
                return (
                  <li key={m.user.id} className="find-friends__row">
                    <Link href={`/u/${m.user.username}`} className="find-friends__who">
                      <Avatar name={m.user.displayName} src={m.user.avatarUrl} />
                      <span className="find-friends__text">
                        <bdi className="find-friends__name">{m.user.displayName}</bdi>
                        <span className="muted">
                          @{m.user.username}
                          {m.followsYou ? ` · ${t('friends.followsYou')}` : ''}
                        </span>
                      </span>
                    </Link>
                    <Button size="sm" variant={on ? 'secondary' : 'primary'} aria-pressed={on} onClick={() => toggle(m.user.id)}>
                      {on ? t('profile.unfollow') : t('profile.follow')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">{t('friends.none')}</p>
          )}
        </section>
      ) : null}

      {found && missing.length && inviteLink ? (
        <section className="stack-sm" aria-labelledby="ff-invite">
          <h2 id="ff-invite" className="section-title">
            {t('friends.invite.title')}
          </h2>
          <ul className="find-friends__list">
            {missing.slice(0, 50).map((e) => (
              <li key={e} className="find-friends__row">
                <span className="find-friends__email">{e}</span>
                <a className="yp-btn yp-btn--secondary yp-btn--sm" href={mailto(e)}>
                  {t('friends.invite')}
                </a>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(inviteLink).catch(() => {});
              toast(t('invite.copied'));
            }}
          >
            {t('invite.copy')}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
