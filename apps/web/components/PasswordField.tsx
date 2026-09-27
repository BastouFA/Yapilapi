'use client';

import { useId, useState, type InputHTMLAttributes } from 'react';
import { Icon } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

/** A password field with a button to show or hide what was typed (the design system's field look). */
export function PasswordField({
  label,
  hint,
  error,
  className,
  ...rest
}: { label: string; hint?: string; error?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useSession();
  const [shown, setShown] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={['yp-field', className].filter(Boolean).join(' ')}>
      <label className="yp-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="password-field">
        <input
          {...rest}
          id={id}
          type={shown ? 'text' : 'password'}
          className="yp-input"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? hintId : undefined}
        />
        <button
          type="button"
          className="password-field__toggle"
          aria-label={shown ? t('m.auth.hidePassword') : t('m.auth.showPassword')}
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((v) => !v)}
        >
          <Icon name={shown ? 'eye-off' : 'eye'} />
        </button>
      </div>
      {error ? (
        <span id={hintId} className="yp-field__error">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="yp-field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
