'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Select, TextField } from '@yapilapi/design-system';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '../../../providers';

export default function NewCommunity() {
  const { t, toast } = useSession();
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const autoSlug = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40);

  return (
    <form
      className="yp-shell__inner"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError(null);
        setFields({});
        try {
          const { community } = await api.communities.create({
            name,
            slug,
            description: String(f.get('description') ?? ''),
            visibility: String(f.get('visibility')),
            topics: String(f.get('topics') ?? '').split(/[,\s#]+/).filter(Boolean).slice(0, 5),
            rules: String(f.get('rules') ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20),
          });
          toast(`${community.name} is ready`);
          router.push(`/c/${community.slug}`);
        } catch (err) {
          setError(errorMessage(err));
          setFields(fieldErrors(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="yp-topbar">
        <h1>{t('communities.create')}</h1>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="stack">
        <TextField
          label="Name"
          value={name}
          required
          maxLength={80}
          error={fields.name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            if (!slugTouched) setSlug(autoSlug(e.currentTarget.value));
          }}
        />
        <TextField
          label="Address"
          hint={`yapilapi.com/c/${slug || 'your-community'}`}
          value={slug}
          required
          minLength={3}
          maxLength={40}
          error={fields.slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(autoSlug(e.currentTarget.value));
          }}
        />
        <TextField label="What's it about?" name="description" multiline maxLength={2000} />
        <Select label="Who can join" name="visibility" defaultValue="public">
          <option value="public">Anyone can join and read</option>
          <option value="private">People request to join; only members read</option>
        </Select>
        <TextField label="Topics" name="topics" hint="Up to 5, separated by commas." />
        <TextField label="Rules" name="rules" multiline hint="One rule per line." />
      </div>
      <Button type="submit" size="lg" block loading={busy} disabled={!name || slug.length < 3}>
        {t('communities.create')}
      </Button>
    </form>
  );
}
