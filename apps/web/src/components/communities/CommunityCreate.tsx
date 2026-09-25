'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CommunityJoinPolicy,
  CommunityVisibility,
  CreateCommunityInput,
} from '@yapilapi/api-client';
import {
  Button,
  Checkbox,
  FormField,
  IconButton,
  Input,
  PlusIcon,
  Radio,
  RadioGroup,
  Textarea,
  TrashIcon,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { describeError } from '@/lib/errors';
import { FormError } from '@/components/forms';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';

const VIS: CommunityVisibility[] = ['public', 'private', 'secret'];
const JOIN: CommunityJoinPolicy[] = ['open', 'request', 'invite'];
const MAX_RULES = 5;

export function CommunityCreate() {
  const { t } = useI18n();
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { isTeen } = useSession();
  usePageTitle(t('communityNew.title'), t('app.name'));
  const topics = useAsync((signal) => api.topics.list({ signal }), [api]);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<CommunityVisibility>(isTeen ? 'private' : 'public');
  const [joinPolicy, setJoinPolicy] = useState<CommunityJoinPolicy>(isTeen ? 'request' : 'open');
  const [picked, setPicked] = useState<string[]>([]);
  const [rules, setRules] = useState<Array<{ title: string; body: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const changeVisibility = (v: CommunityVisibility) => {
    setVisibility(v);
    if (v === 'secret') setJoinPolicy('invite');
    else if (v === 'private' && joinPolicy === 'open') setJoinPolicy('request');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (name.trim().length < 3) {
      setFieldErrors({ name: t('communityNew.needName') });
      return;
    }
    const input: CreateCommunityInput = { name: name.trim(), visibility, joinPolicy };
    if (slug.trim()) input.slug = slug.trim();
    if (description.trim()) input.description = description.trim();
    if (picked.length) input.topics = picked;
    const cleanRules = rules
      .filter((r) => r.title.trim())
      .map((r) => ({ title: r.title.trim(), ...(r.body.trim() ? { body: r.body.trim() } : {}) }));
    if (cleanRules.length) input.rules = cleanRules;
    setBusy(true);
    try {
      const c = await api.communities.create(input);
      toast.show({ tone: 'success', title: t('communityNew.created') });
      router.push(`/communities/${encodeURIComponent(c.slug)}`);
    } catch (err) {
      const d = describeError(err, t);
      setFieldErrors(d.fields);
      setError(d.message);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('communityNew.title')} lead={t('communityNew.lead')} />
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <FormError>{error}</FormError>
        <FormField
          label={t('communityNew.name')}
          description={t('communityNew.nameHelp')}
          error={fieldErrors['name']}
          required
          requiredLabel={t('common.required')}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoComplete="off"
            data-testid="community-name"
          />
        </FormField>
        <FormField
          label={t('communityNew.slug')}
          description={t('communityNew.slugHelp')}
          error={fieldErrors['slug']}
        >
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            maxLength={60}
            dir="ltr"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </FormField>
        <FormField label={t('communityNew.description')} error={fieldErrors['description']}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1000}
            rows={4}
            data-testid="community-description"
          />
        </FormField>

        <RadioGroup
          legend={t('communityNew.visibility')}
          value={visibility}
          onValueChange={(v) => changeVisibility(v as CommunityVisibility)}
        >
          {VIS.map((v) => (
            <Radio
              key={v}
              value={v}
              card
              label={t(`communityNew.visibility.${v}`)}
              description={t(`communityNew.visibility.${v}.help`)}
              disabled={isTeen && v !== 'private'}
            />
          ))}
        </RadioGroup>
        <RadioGroup
          legend={t('communityNew.joinPolicy')}
          value={joinPolicy}
          onValueChange={(v) => setJoinPolicy(v as CommunityJoinPolicy)}
        >
          {JOIN.map((j) => (
            <Radio
              key={j}
              value={j}
              card
              label={t(`communityNew.joinPolicy.${j}`)}
              description={t(`communityNew.joinPolicy.${j}.help`)}
              disabled={
                visibility === 'secret'
                  ? j !== 'invite'
                  : visibility === 'private'
                    ? j === 'open'
                    : false
              }
            />
          ))}
        </RadioGroup>

        {topics.error ? (
          <ErrorView error={topics.error} onRetry={topics.reload} />
        ) : topics.loading ? (
          <PageSpinner />
        ) : (
          <fieldset className="yl-composer__topics">
            <legend className="picker__legend">{t('communityNew.topics')}</legend>
            <div className="yl-topicgrid">
              {(topics.data?.items ?? []).map((tp) => (
                <Checkbox
                  key={tp.slug}
                  className="yl-topicchip"
                  label={tp.name}
                  checked={picked.includes(tp.slug)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked ? [...p, tp.slug] : p.filter((s) => s !== tp.slug),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="yl-composer__topics">
          <legend className="picker__legend">{t('communityNew.rules')}</legend>
          <p className="muted">{t('communityNew.rulesHelp')}</p>
          {rules.map((r, i) => (
            <div key={i} className="rule-fields">
              <div className="rule-fields__row">
                <FormField label={t('communityNew.ruleTitle', { n: i + 1 })}>
                  <Input
                    value={r.title}
                    maxLength={80}
                    onChange={(e) =>
                      setRules((rs) =>
                        rs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                      )
                    }
                  />
                </FormField>
                <IconButton
                  label={t('communityNew.removeRule', { n: i + 1 })}
                  icon={<TrashIcon size={18} />}
                  onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                />
              </div>
              <FormField label={t('communityNew.ruleBody', { n: i + 1 })}>
                <Textarea
                  value={r.body}
                  rows={2}
                  maxLength={500}
                  onChange={(e) =>
                    setRules((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)),
                    )
                  }
                />
              </FormField>
            </div>
          ))}
          {rules.length < MAX_RULES ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                leadingIcon={<PlusIcon size={16} />}
                onClick={() => setRules((rs) => [...rs, { title: '', body: '' }])}
              >
                {t('communityNew.addRule')}
              </Button>
            </div>
          ) : null}
        </fieldset>

        <div className="button-row button-row--end">
          <Button
            type="submit"
            loading={busy}
            loadingLabel={t('common.working')}
            data-testid="community-submit"
          >
            {t('communityNew.submit')}
          </Button>
        </div>
      </form>
    </>
  );
}
