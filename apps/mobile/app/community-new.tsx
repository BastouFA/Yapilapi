import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import { client, errorMessage, webUrl } from '../lib/api';
import { autoSlug, ChoiceField, FieldError, splitRules, TopicsField } from '../lib/forms';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { Button, Card, Field, KeyboardAvoid, Notice, useColors } from '../lib/ui';

/**
 * Create a community (apps/web/app/(app)/communities/new): name, address, what it's about, who can
 * join, topics and rules. It opens as soon as it's made, with you as its owner.
 */
export default function NewCommunity() {
  const c = useColors();
  const { t } = useT();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [topics, setTopics] = useState<string[]>([]);
  const [rules, setRules] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function create() {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const { community } = await (
        await client()
      ).communities.create({ name: name.trim(), slug, description: description.trim(), visibility, topics, rules: splitRules(rules) });
      router.replace(`/c/${community.slug}`);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.fields) setFields(e.fields);
    } finally {
      setBusy(false);
    }
  }

  const host = webUrl.replace(/^https?:\/\//, '');
  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Card style={{ gap: space[3] }}>
          <Field
            label={t('m.communityForm.name')}
            value={name}
            maxLength={80}
            autoCapitalize="words"
            onChangeText={(v) => {
              setName(v);
              if (!slugTouched) setSlug(autoSlug(v));
            }}
          />
          <FieldError text={fields.name} />
          <Field
            label={t('m.communityForm.address')}
            value={slug}
            maxLength={40}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(v) => {
              setSlugTouched(true);
              setSlug(autoSlug(v));
            }}
          />
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.communityForm.addressHint', { url: `${host}/c/${slug || '…'}` })}</Text>
          <FieldError text={fields.slug} />
          <Field
            label={t('m.communityForm.about')}
            value={description}
            onChangeText={setDescription}
            multiline
            maxLength={2000}
            style={{ minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }}
          />
        </Card>
        <Card style={{ gap: space[3] }}>
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
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.communityForm.rulesHint')}</Text>
          <FieldError text={fields.rules ?? fields['rules.0']} />
        </Card>
        <Button
          label={busy ? t('m.communityForm.creating') : t('communities.create')}
          disabled={!name.trim() || slug.length < 3 || busy}
          onPress={() => create()}
        />
      </ScrollView>
    </KeyboardAvoid>
  );
}
