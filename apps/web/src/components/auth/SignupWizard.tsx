'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type Topic, type Profile } from '@yapilapi/api-client';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  FormField,
  Input,
  PasswordInput,
  Skeleton,
  useToast,
  useUI,
  CheckIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { ageGate, MIN_AGE } from '@/lib/age';
import { describeError } from '@/lib/errors';
import { useAsync, useDebounced, usePageTitle } from '@/lib/hooks';
import { FormError } from '../forms';
import { ErrorView } from '../common';

type Step = 'account' | 'birthdate' | 'profile' | 'interests' | 'people';
const STEPS: Step[] = ['account', 'birthdate', 'profile', 'interests', 'people'];
const USERNAME_RE = /^[a-z0-9_]{3,30}$/;
const BLOCK_COOKIE = 'yl_age_block';

type Availability =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'taken' }
  | { state: 'reserved' }
  | { state: 'invalid' }
  | { state: 'error' };

const hasBlockCookie = () =>
  typeof document !== 'undefined' &&
  document.cookie.split('; ').some((c) => c.startsWith(`${BLOCK_COOKIE}=`));
const setBlockCookie = () => {
  document.cookie = `${BLOCK_COOKIE}=1; path=/; max-age=86400; SameSite=Lax`;
};

export function SignupWizard({ resume }: { resume?: { username: string; ageBand: string } }) {
  const { t, locale } = useI18n();
  const { Link } = useUI();
  const api = useApi();
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState<Step>(resume ? 'interests' : 'account');
  const [registered, setRegistered] = useState(Boolean(resume));
  const [isTeen, setIsTeen] = useState(resume?.ageBand === 'teen');
  const headingRef = useRef<HTMLHeadingElement>(null);

  // account
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [accountErrors, setAccountErrors] = useState<{
    email?: string;
    password?: string;
    terms?: string;
  }>({});
  // birthdate
  const [birthDate, setBirthDate] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [birthError, setBirthError] = useState<string | null>(null);
  // profile
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [avail, setAvail] = useState<Availability>({ state: 'idle' });
  const [profileErrors, setProfileErrors] = useState<{ displayName?: string; username?: string }>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // interests / people
  const [picked, setPicked] = useState<string[]>([]);
  const [followed, setFollowed] = useState<
    Array<{ username: string; displayName: string; status: 'active' | 'pending' }>
  >([]);

  const stepIndex = STEPS.indexOf(step);
  usePageTitle(t(`signup.step.${step}`), t('app.name'));

  useEffect(() => {
    if (hasBlockCookie()) {
      setBlocked(true);
    }
  }, []);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // ---- username availability (debounced, latest request wins)
  const debouncedName = useDebounced(username.trim().toLowerCase(), 400);
  useEffect(() => {
    if (!debouncedName) {
      setAvail({ state: 'idle' });
      return;
    }
    if (!USERNAME_RE.test(debouncedName)) {
      setAvail({ state: 'invalid' });
      return;
    }
    const ctl = new AbortController();
    setAvail({ state: 'checking' });
    api.profile.usernameAvailable(debouncedName, { signal: ctl.signal }).then(
      (r) => {
        if (!ctl.signal.aborted)
          setAvail(
            r.available
              ? { state: 'available' }
              : {
                  state:
                    r.reason === 'reserved'
                      ? 'reserved'
                      : r.reason === 'invalid'
                        ? 'invalid'
                        : 'taken',
                },
          );
      },
      () => {
        if (!ctl.signal.aborted) setAvail({ state: 'error' });
      },
    );
    return () => ctl.abort();
  }, [debouncedName, api]);
  const nameStale = username.trim().toLowerCase() !== debouncedName;

  // ---- step handlers
  const submitAccount = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof accountErrors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) errs.email = t('signup.emailInvalid');
    if (password.length < 10) errs.password = t('password.tooShort');
    if (!terms) errs.terms = t('signup.termsRequired');
    setAccountErrors(errs);
    if (Object.keys(errs).length === 0) setStep('birthdate');
  };

  const gate = useMemo(() => (birthDate ? ageGate(birthDate) : null), [birthDate]);

  const submitBirthdate = (e: FormEvent) => {
    e.preventDefault();
    setBirthError(null);
    const g = ageGate(birthDate);
    if (g.kind === 'invalid') {
      setBirthError(t('signup.birthInvalid'));
      return;
    }
    if (g.kind === 'blocked') {
      setBlocked(true);
      setBlockCookie();
      return;
    }
    setIsTeen(g.kind === 'teen');
    setStep('profile');
  };

  const submitProfile = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof profileErrors = {};
    const name = displayName.trim();
    const handle = username.trim().toLowerCase();
    if (!name) errs.displayName = t('signup.displayNameRequired');
    if (!USERNAME_RE.test(handle)) errs.username = t('signup.usernameInvalid');
    else if (avail.state === 'taken' || avail.state === 'reserved')
      errs.username = t(
        avail.state === 'taken' ? 'signup.usernameTaken' : 'signup.usernameReserved',
      );
    setProfileErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.auth.register({
        email: email.trim(),
        password,
        username: handle,
        displayName: name,
        birthDate,
        locale,
        acceptTerms: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
      setRegistered(true);
      setPassword('');
      setStep('interests');
      router.refresh();
    } catch (err) {
      const d = describeError(err, t);
      if (err instanceof ApiError && err.code === 'conflict') {
        if (/username/i.test(err.message)) {
          setProfileErrors({ username: d.message });
          setAvail({ state: 'taken' });
        } else {
          setAccountErrors({ email: d.message });
          setStep('account');
        }
      } else if (err instanceof ApiError && d.fields['email']) {
        setAccountErrors({ email: d.fields['email'] });
        setStep('account');
      } else if (err instanceof ApiError && d.fields['password']) {
        setAccountErrors({ password: d.fields['password'] });
        setStep('account');
      } else setFormError(d.message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await api.profile.completeOnboarding();
      toast.show({ tone: 'success', title: t('signup.welcome') });
      router.replace('/');
      router.refresh();
    } catch (err) {
      setFormError(describeError(err, t).message);
      setBusy(false);
    }
  };

  const saveInterests = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await api.profile.setInterests(picked);
      setStep('people');
    } catch (err) {
      setFormError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- rendering
  const heading = (
    <h1 ref={headingRef} tabIndex={-1} className="auth-card__title">
      {t(`signup.step.${step}`)}
    </h1>
  );

  const progress = (
    <nav aria-label={t('signup.progress')} className="steps">
      <p className="steps__count">
        {t('signup.stepOf', { current: stepIndex + 1, total: STEPS.length })}
      </p>
      <ol className="steps__list">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            className={`steps__item${i < stepIndex ? ' is-done' : ''}${s === step ? ' is-current' : ''}`}
          >
            <span className="yl-sr-only">
              {t(`signup.step.${s}`)}
              {i < stepIndex ? ` (${t('signup.done')})` : ''}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );

  return (
    <Card padding="lg" className="auth-card auth-card--wide" data-testid="signup-wizard">
      {progress}
      {step === 'account' ? (
        <>
          {heading}
          <p className="auth-card__lead">{t('signup.accountLead')}</p>
          <form onSubmit={submitAccount} className="stack" noValidate>
            <FormField
              label={t('field.email')}
              error={accountErrors.email}
              required
              requiredLabel={t('common.required')}
            >
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                dir="ltr"
                data-testid="signup-email"
              />
            </FormField>
            <FormField
              label={t('field.password')}
              description={t('password.rules')}
              error={accountErrors.password}
              required
              requiredLabel={t('common.required')}
            >
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                showLabel={t('field.showPassword')}
                hideLabel={t('field.hidePassword')}
                data-testid="signup-password"
              />
            </FormField>
            <FormField label={t('signup.termsLabel')} hideLabel error={accountErrors.terms}>
              <Checkbox
                label={t('signup.termsLabel')}
                checked={terms}
                onChange={(e) => setTerms(e.target.checked)}
                data-testid="signup-terms"
              />
            </FormField>
            <Button type="submit" size="lg" fullWidth data-testid="signup-next">
              {t('common.continue')}
            </Button>
          </form>
          <p className="auth-card__links">
            {t('signup.haveAccount')} <Link href="/login">{t('signup.login')}</Link>
          </p>
        </>
      ) : null}

      {step === 'birthdate' ? (
        <>
          {heading}
          {blocked ? (
            <div className="stack" role="alert" data-testid="age-blocked">
              <p className="yl-notice yl-notice--danger">
                {t('signup.underAge', { age: MIN_AGE })}
              </p>
              <p>{t('signup.underAgeHelp')}</p>
              {!hasBlockCookie() ? (
                <Button variant="secondary" onClick={() => setBlocked(false)}>
                  {t('signup.fixBirthdate')}
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <p className="auth-card__lead">{t('signup.birthLead')}</p>
              <form onSubmit={submitBirthdate} className="stack" noValidate>
                <FormField
                  label={t('field.birthDate')}
                  description={t('signup.birthHelp')}
                  error={birthError}
                  required
                  requiredLabel={t('common.required')}
                >
                  <Input
                    type="date"
                    value={birthDate}
                    onChange={(e) => {
                      setBirthDate(e.target.value);
                      setBirthError(null);
                    }}
                    max={new Date().toISOString().slice(0, 10)}
                    autoComplete="bday"
                    data-testid="signup-birthdate"
                  />
                </FormField>
                {gate?.kind === 'teen' ? (
                  <div className="yl-notice yl-notice--info" role="note" data-testid="teen-note">
                    <p>
                      <LockIcon size={16} /> <strong>{t('signup.teenTitle')}</strong>
                    </p>
                    <ul className="bullets">
                      <li>{t('signup.teen1')}</li>
                      <li>{t('signup.teen2')}</li>
                      <li>{t('signup.teen3')}</li>
                    </ul>
                  </div>
                ) : null}
                {gate?.kind === 'blocked' ? (
                  <p className="yl-notice yl-notice--danger" role="alert">
                    {t('signup.underAge', { age: MIN_AGE })}
                  </p>
                ) : null}
                <div className="button-row">
                  <Button variant="ghost" onClick={() => setStep('account')}>
                    {t('common.back')}
                  </Button>
                  <Button type="submit" size="lg" disabled={!birthDate} data-testid="signup-next">
                    {t('common.continue')}
                  </Button>
                </div>
              </form>
            </>
          )}
        </>
      ) : null}

      {step === 'profile' ? (
        <>
          {heading}
          <p className="auth-card__lead">{t('signup.profileLead')}</p>
          <form onSubmit={(e) => void submitProfile(e)} className="stack" noValidate>
            <FormError>{formError}</FormError>
            <FormField
              label={t('field.displayName')}
              error={profileErrors.displayName}
              required
              requiredLabel={t('common.required')}
            >
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                autoComplete="name"
                data-testid="signup-displayname"
              />
            </FormField>
            <FormField
              label={t('field.username')}
              description={t('signup.usernameHelp')}
              required
              requiredLabel={t('common.required')}
              error={
                profileErrors.username ??
                (avail.state === 'taken'
                  ? t('signup.usernameTaken')
                  : avail.state === 'reserved'
                    ? t('signup.usernameReserved')
                    : avail.state === 'invalid' && username
                      ? t('signup.usernameInvalid')
                      : undefined)
              }
            >
              <Input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value.toLowerCase());
                  setProfileErrors((p) => ({ ...p, username: undefined }));
                }}
                maxLength={30}
                autoCapitalize="none"
                autoComplete="username"
                spellCheck={false}
                dir="ltr"
                data-testid="signup-username"
              />
            </FormField>
            <p className="avail" aria-live="polite" data-testid="username-status">
              {(avail.state === 'checking' || nameStale) && username ? (
                <span>{t('signup.usernameChecking')}</span>
              ) : null}
              {avail.state === 'available' && !nameStale ? (
                <span className="avail__ok">
                  <CheckIcon size={16} />{' '}
                  {t('signup.usernameAvailable', { username: debouncedName })}
                </span>
              ) : null}
              {avail.state === 'error' ? <span>{t('signup.usernameCheckFailed')}</span> : null}
            </p>
            <div className="button-row">
              <Button variant="ghost" onClick={() => setStep('birthdate')}>
                {t('common.back')}
              </Button>
              <Button
                type="submit"
                size="lg"
                loading={busy}
                loadingLabel={t('signup.creating')}
                disabled={avail.state === 'checking' || nameStale}
                data-testid="signup-create"
              >
                {t('signup.create')}
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {step === 'interests' ? (
        <>
          {heading}
          <p className="auth-card__lead">{t('signup.interestsLead')}</p>
          <InterestsStep picked={picked} setPicked={setPicked} />
          <FormError>{formError}</FormError>
          <div className="button-row">
            <Button variant="ghost" onClick={() => setStep('people')}>
              {t('common.skip')}
            </Button>
            <Button
              size="lg"
              onClick={() => void saveInterests()}
              loading={busy}
              loadingLabel={t('common.working')}
              data-testid="interests-next"
            >
              {t('common.continue')}
            </Button>
          </div>
        </>
      ) : null}

      {step === 'people' ? (
        <>
          {heading}
          <p className="auth-card__lead">{t('signup.peopleLead')}</p>
          <PeopleStep followed={followed} setFollowed={setFollowed} />
          <FormError>{formError}</FormError>
          <div className="button-row button-row--end">
            <Button
              size="lg"
              onClick={() => void finish()}
              loading={busy}
              loadingLabel={t('common.working')}
              data-testid="signup-finish"
            >
              {followed.length ? t('signup.finish') : t('signup.skipFinish')}
            </Button>
          </div>
        </>
      ) : null}
      {isTeen && registered && (step === 'interests' || step === 'people') ? (
        <p className="yl-notice yl-notice--info" role="note">
          <InfoIcon size={16} /> {t('signup.teenPrivateNote')}
        </p>
      ) : null}
    </Card>
  );
}

function InterestsStep({
  picked,
  setPicked,
}: {
  picked: string[];
  setPicked: (fn: (p: string[]) => string[]) => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const topics = useAsync((signal) => api.topics.list({ signal }), [api]);
  if (topics.loading)
    return (
      <div className="topicgrid-skeleton" aria-busy="true">
        <Skeleton width="full" />
        <Skeleton width="lg" />
        <Skeleton width="md" />
      </div>
    );
  if (topics.error) return <ErrorView error={topics.error} onRetry={topics.reload} />;
  const items: Topic[] = topics.data?.items ?? [];
  if (items.length === 0)
    return <EmptyState title={t('signup.noTopics')} description={t('signup.noTopicsHelp')} />;
  return (
    <fieldset className="yl-composer__topics">
      <legend className="yl-sr-only">{t('signup.step.interests')}</legend>
      <div className="yl-topicgrid" data-testid="topic-grid">
        {items.map((topic) => {
          const on = picked.includes(topic.slug);
          return (
            <Checkbox
              key={topic.slug}
              label={topic.name}
              checked={on}
              className="yl-topicchip"
              onChange={(e) =>
                setPicked((s) =>
                  e.target.checked ? [...s, topic.slug] : s.filter((x) => x !== topic.slug),
                )
              }
            />
          );
        })}
      </div>
      <p className="yl-field__desc" aria-live="polite">
        {t('signup.interestsCount', { count: picked.length })}
      </p>
    </fieldset>
  );
}

function PeopleStep({
  followed,
  setFollowed,
}: {
  followed: Array<{ username: string; displayName: string; status: 'active' | 'pending' }>;
  setFollowed: (
    v: Array<{ username: string; displayName: string; status: 'active' | 'pending' }>,
  ) => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [following, setFollowing] = useState(false);

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    const name = query.trim().replace(/^@/, '').toLowerCase();
    if (!name) return;
    setLooking(true);
    setError(null);
    setFound(null);
    try {
      setFound(await api.profile.get(name));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? t('signup.personNotFound')
          : describeError(err, t).message,
      );
    } finally {
      setLooking(false);
    }
  };

  const follow = async (p: Profile) => {
    setFollowing(true);
    setError(null);
    try {
      const r = await api.graph.follow(p.username);
      setFollowed([
        ...followed.filter((f) => f.username !== p.username),
        { username: p.username, displayName: p.displayName, status: r.status },
      ]);
      setFound(null);
      setQuery('');
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setFollowing(false);
    }
  };

  return (
    <div className="stack">
      <form onSubmit={(e) => void lookup(e)} className="inline-form" noValidate>
        <FormField
          label={t('signup.findPerson')}
          description={t('signup.findPersonHelp')}
          error={error ?? undefined}
          className="yl-grow"
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            data-testid="people-input"
          />
        </FormField>
        <Button
          type="submit"
          variant="secondary"
          loading={looking}
          loadingLabel={t('common.working')}
          disabled={!query.trim()}
          data-testid="people-find"
        >
          {t('signup.find')}
        </Button>
      </form>
      {found ? (
        <Card padding="md" className="person-card" data-testid="person-result">
          <Avatar name={found.displayName} src={found.avatarUrl} decorative />
          <div className="person-card__text">
            <p className="person-card__name">
              {found.displayName}{' '}
              {found.isPrivate ? (
                <Badge icon={<LockIcon size={12} />}>{t('profile.private')}</Badge>
              ) : null}
            </p>
            <p className="person-card__handle" dir="ltr">
              @{found.username}
            </p>
            {found.bio ? <p className="person-card__bio">{found.bio}</p> : null}
          </div>
          <Button
            onClick={() => void follow(found)}
            loading={following}
            loadingLabel={t('common.working')}
            leadingIcon={<PlusIcon size={16} />}
            data-testid="people-follow"
          >
            {found.isPrivate ? t('profile.requestFollow') : t('profile.follow')}
          </Button>
        </Card>
      ) : null}
      <section aria-labelledby="followed-h">
        <h2 id="followed-h" className="section-title">
          {t('signup.followedTitle', { count: followed.length })}
        </h2>
        {followed.length === 0 ? (
          <p className="muted">{t('signup.followedEmpty')}</p>
        ) : (
          <ul className="stack-sm" data-testid="followed-list">
            {followed.map((f) => (
              <li key={f.username} className="person-row">
                <Avatar name={f.displayName} size="sm" decorative />
                <span>
                  {f.displayName}{' '}
                  <span className="muted" dir="ltr">
                    @{f.username}
                  </span>
                </span>
                <Badge tone={f.status === 'active' ? 'success' : 'neutral'}>
                  {f.status === 'active' ? t('profile.followingState') : t('profile.requested')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
