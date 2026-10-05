'use client';

import { FeatureOff } from '@/components/FeatureOff';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, EmptyState, PostCard, Select, Skeleton, TextField } from '@yapilapi/design-system';
import { noticeText, type Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { Capture } from '@/components/Capture';
import { useSession } from '../../providers';

/** Real: capture what's in front of you now, both cameras if you like. No filters, no library. */
export default function RealPage() {
  const { flags, toast, locale, t } = useSession();
  const [items, setItems] = useState<Post[] | null>(null);
  // Why the Reals couldn't load (shown with Try again, rather than as "no Reals yet").
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState('friends');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api.real.feed().then(
        (r) => {
          setItems(r.items);
          setLoadError(null);
        },
        (e) => {
          setLoadError(errorMessage(e));
          setItems((cur) => cur ?? []);
        },
      ),
    [],
  );
  useEffect(() => {
    if (flags.REAL) void load();
  }, [flags.REAL, load]);

  if (!flags.REAL) return <FeatureOff name={t('m.title.real')} />;

  async function share(files: File[]) {
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const f of files) ids.push((await api.media.upload(f)).media.id);
      const r = await api.real.create({ mediaIds: ids, caption, visibility });
      setCapturing(false);
      setCaption('');
      toast(noticeText(r.moderation, t) ?? t('real.shared'));
      await load();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.title.real')}</h1>
        {!capturing ? <Button onClick={() => setCapturing(true)}>{t('m.real.capture')}</Button> : null}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('real.intro')}
      </p>
      {capturing ? (
        <div className="stack-sm yp-card" style={{ padding: 16 }}>
          <TextField label={t('m.real.caption')} value={caption} onChange={(e) => setCaption(e.currentTarget.value)} maxLength={300} />
          <Select label={t('m.eventForm.whoSees')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value)}>
            <option value="friends">{t('visibility.friends')}</option>
            <option value="followers">{t('visibility.followers')}</option>
            <option value="public">{t('visibility.public')}</option>
          </Select>
          {busy ? <p>{t('m.real.sharing')}</p> : <Capture dual onCaptured={share} />}
          <Button variant="ghost" onClick={() => setCapturing(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
      {loadError ? (
        <Alert tone="danger">
          <span className="row">
            {loadError}
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              {t('m.common.retry')}
            </Button>
          </span>
        </Alert>
      ) : null}
      {items === null ? (
        <Skeleton height={240} />
      ) : items.length ? (
        items.map((p) => <PostCard key={p.id} post={p} locale={locale} linkAs={NextLink} />)
      ) : loadError ? null : (
        <EmptyState title={t('real.empty.title')} body={t('real.empty.body')} />
      )}
    </div>
  );
}
