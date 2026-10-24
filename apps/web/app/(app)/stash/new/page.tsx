'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Checkbox, Icon, Select, TextField } from '@yapilapi/design-system';
import {
  LAUNCH_CITIES,
  STASH_AUDIENCES,
  STASH_AUDIENCE_KEYS,
  STASH_DURATIONS,
  STASH_DURATION_KEYS,
  STASH_GIFT_MAX,
  STASH_HINT_MAX,
  STASH_KINDS,
  STASH_KIND_KEYS,
  STASH_MAX_ACCURACY,
  STASH_TEXT_MAX,
  STASH_TITLE_MAX,
  STASH_VIDEO_MAX_MS,
  type MusicTrack,
  type PublicUser,
  type SquadCard,
  type StashAudience,
  type StashDuration,
  type StashKind,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { FeatureOff } from '@/components/FeatureOff';
import { MusicPicker } from '@/components/MusicPicker';
import { STASH_KIND_ICONS, usePrecisePosition } from '@/components/Stash';
import { YapRecorder, uploadVoice, voiceError, type Recording } from '@/components/YapRecorder';
import { useSession } from '../../../providers';

/**
 * Hide a stash (docs/product/stash.md): what goes in, a title and hint, who can open it, for how
 * long and whether only the first finder gets it. It's hidden exactly where the device is when
 * "Hide it here" is pressed (asked for then, accurate to STASH_MAX_ACCURACY metres or better).
 * Admins can also place one for everyone at a chosen point (seed mode, "Hidden by YAPILAPI").
 */
export default function HideStashPage() {
  const router = useRouter();
  const { t, toast, me, flags } = useSession();
  const precise = usePrecisePosition();
  const [kind, setKind] = useState<StashKind>('text');
  const [body, setBody] = useState('');
  const [giftCode, setGiftCode] = useState('');
  const [title, setTitle] = useState('');
  const [hint, setHint] = useState('');
  const [audience, setAudience] = useState<StashAudience>('everyone');
  const [recipient, setRecipient] = useState('');
  const [squadId, setSquadId] = useState('');
  const [duration, setDuration] = useState<StashDuration>('7d');
  const [firstOnly, setFirstOnly] = useState(false);
  const [media, setMedia] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [voice, setVoice] = useState<Recording | null>(null);
  const [song, setSong] = useState<MusicTrack | null>(null);
  const [picking, setPicking] = useState(false);
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [squads, setSquads] = useState<SquadCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Seed mode (admins): a chosen point instead of where the device is.
  const admin = me?.role === 'admin';
  const [seed, setSeed] = useState(false);
  const [lat, setLat] = useState(String(LAUNCH_CITIES[0].center.lat));
  const [lng, setLng] = useState(String(LAUNCH_CITIES[0].center.lng));

  useEffect(() => {
    if (audience === 'person' && !people.length)
      api.squads
        .candidates()
        .then((r) => setPeople(r.items))
        .catch(() => {});
    if (audience === 'squad' && !squads.length)
      api.squads
        .list()
        .then((r) => setSquads(r.items.filter((s) => s.role)))
        .catch(() => {});
  }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps

  if (flags.STASH === false) return <FeatureOff name={t('stash.title')} />;

  async function pickFile(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    setProblem(null);
    try {
      if (kind === 'video') {
        const seconds = await new Promise<number>((resolve) => {
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.onloadedmetadata = () => resolve(v.duration || 0);
          v.onerror = () => resolve(0);
          v.src = URL.createObjectURL(f);
        });
        if (seconds * 1000 > STASH_VIDEO_MAX_MS + 500) {
          setProblem(t('stash.form.video'));
          return;
        }
      }
      const { media: m } = f.size > 8 * 1024 * 1024 ? await api.uploads.resumable(f) : await api.media.upload(f);
      await api.media.waitUntilProcessed(m.id);
      setMedia({ id: m.id, name: f.name });
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      let voiceId: string | undefined;
      if (kind === 'voice' && voice) {
        try {
          voiceId = (await uploadVoice(voice, 'yap')).id;
        } catch (err) {
          setProblem(voiceError(err, t));
          return;
        }
      }
      const content = {
        kind,
        title: title.trim() || undefined,
        hint: hint.trim() || undefined,
        body: body.trim() || undefined,
        giftCode: kind === 'gift' ? giftCode.trim() || undefined : undefined,
        mediaId: kind === 'photo' || kind === 'video' ? media?.id : undefined,
        voiceId,
        music: kind === 'song' && song ? (song.source === 'library' ? { soundId: song.id } : { trackId: song.id }) : undefined,
        duration,
        firstOnly,
      };
      if (seed) {
        const { stash } = await api.stash.seed({ ...content, point: { lat: Number(lat), lng: Number(lng) } });
        router.push(`/stash/${stash.id}`);
        return;
      }
      const pos = await precise.locate();
      if (!pos) return;
      if (pos.accuracy > STASH_MAX_ACCURACY) {
        setProblem(t('stash.form.inaccurate'));
        return;
      }
      const { stash } = await api.stash.hide({
        ...content,
        audience,
        recipientId: audience === 'person' ? recipient || undefined : undefined,
        squadId: audience === 'squad' ? squadId || undefined : undefined,
        position: pos,
      });
      toast(t('stash.hidden'));
      router.push(`/stash/${stash.id}`);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    (kind === 'text' && !!body.trim()) ||
    (kind === 'gift' && !!giftCode.trim()) ||
    ((kind === 'photo' || kind === 'video') && !!media) ||
    (kind === 'voice' && !!voice) ||
    (kind === 'song' && !!song);

  return (
    <div className="yp-shell__inner stack">
      <div className="yp-topbar">
        <h1>{t('stash.hide')}</h1>
      </div>
      <p className="muted">{t('stash.hint')}</p>
      <form className="stack" onSubmit={submit}>
        <fieldset className="stash-kinds">
          <legend>{t('stash.form.what')}</legend>
          {STASH_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className="stash-kind"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setMedia(null);
                setProblem(null);
              }}
            >
              <Icon name={STASH_KIND_ICONS[k]} size={22} />
              {t(STASH_KIND_KEYS[k])}
            </button>
          ))}
        </fieldset>

        {kind === 'gift' ? (
          <TextField label={t('stash.form.gift')} value={giftCode} maxLength={STASH_GIFT_MAX} onChange={(e) => setGiftCode(e.currentTarget.value)} />
        ) : null}
        {kind === 'photo' || kind === 'video' ? (
          <label className="yp-field">
            <span className="yp-field__label">{kind === 'photo' ? t('stash.form.photo') : t('stash.form.video')}</span>
            <input
              type="file"
              accept={kind === 'photo' ? 'image/*' : 'video/*'}
              disabled={uploading}
              onChange={(e) => void pickFile(e.currentTarget.files?.[0])}
            />
            {uploading ? <span className="muted">{t('settings.uploading')}</span> : media ? <span className="muted">{media.name}</span> : null}
          </label>
        ) : null}
        {kind === 'voice' ? (
          <YapRecorder maxMs={60_000} onDone={(blob, durationMs, filename) => setVoice({ blob, durationMs, filename })} onReset={() => setVoice(null)} />
        ) : null}
        {kind === 'song' ? (
          <div className="row" style={{ alignItems: 'center' }}>
            <Button type="button" variant="secondary" icon="music" onClick={() => setPicking(true)}>
              {song ? `${song.title} · ${song.artist}` : t('stash.form.song')}
            </Button>
            <MusicPicker
              open={picking}
              onClose={() => setPicking(false)}
              onPick={(tr) => {
                setSong(tr);
                setPicking(false);
              }}
            />
          </div>
        ) : null}
        <TextField
          label={kind === 'text' ? t('stash.form.body') : t('stash.form.line')}
          multiline
          value={body}
          maxLength={STASH_TEXT_MAX}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
        <TextField label={t('stash.form.title')} value={title} maxLength={STASH_TITLE_MAX} onChange={(e) => setTitle(e.currentTarget.value)} />
        <TextField
          label={t('stash.form.hint')}
          placeholder={t('stash.form.hintPlaceholder')}
          value={hint}
          maxLength={STASH_HINT_MAX}
          onChange={(e) => setHint(e.currentTarget.value)}
        />

        {!seed ? (
          <>
            <Select label={t('stash.form.who')} value={audience} onChange={(e) => setAudience(e.currentTarget.value as StashAudience)}>
              {STASH_AUDIENCES.map((a) => (
                <option key={a} value={a}>
                  {t(STASH_AUDIENCE_KEYS[a])}
                </option>
              ))}
            </Select>
            {audience === 'person' ? (
              <Select label={t('stash.form.person')} value={recipient} onChange={(e) => setRecipient(e.currentTarget.value)}>
                <option value="">{t('stash.form.person')}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} (@{p.username})
                  </option>
                ))}
              </Select>
            ) : null}
            {audience === 'squad' ? (
              <Select label={t('stash.form.squad')} value={squadId} onChange={(e) => setSquadId(e.currentTarget.value)}>
                <option value="">{t('stash.form.squad')}</option>
                {squads.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </>
        ) : null}
        <Select label={t('stash.form.howLong')} value={duration} onChange={(e) => setDuration(e.currentTarget.value as StashDuration)}>
          {STASH_DURATIONS.map((d) => (
            <option key={d} value={d}>
              {t(STASH_DURATION_KEYS[d])}
            </option>
          ))}
        </Select>
        <Checkbox label={t('stash.form.firstOnly')} checked={firstOnly} onChange={(e) => setFirstOnly(e.currentTarget.checked)} />

        {admin ? (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <Checkbox label={t('stash.seed.title')} description={t('stash.seed.hint')} checked={seed} onChange={(e) => setSeed(e.currentTarget.checked)} />
            {seed ? (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <TextField label={t('stash.seed.lat')} inputMode="decimal" value={lat} onChange={(e) => setLat(e.currentTarget.value)} />
                <TextField label={t('stash.seed.lng')} inputMode="decimal" value={lng} onChange={(e) => setLng(e.currentTarget.value)} />
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {!seed ? <p className="muted">{t('stash.form.here')}</p> : null}
        {precise.pos ? <p className="muted">{t('stash.form.accuracy', { n: precise.pos.accuracy })}</p> : null}
        {problem || precise.problem ? (
          <p className="stash-page__note" role="alert">
            {problem ?? precise.problem}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" icon="map-pin" loading={busy || precise.busy} disabled={!ready || uploading}>
            {t('stash.form.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
