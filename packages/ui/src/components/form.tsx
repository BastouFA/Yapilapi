import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../utils';
import { EyeOffIcon } from './icons';

// ------------------------------------------------------------------ FormField
interface FieldCtx {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}
const FieldContext = createContext<FieldCtx | null>(null);

/** Props a control gets from an enclosing FormField (id, aria-describedby, aria-invalid, required). */
export function useFieldProps(
  own: {
    id?: string | undefined;
    'aria-describedby'?: string | undefined;
    'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' | undefined;
    required?: boolean | undefined;
  } = {},
) {
  const f = useContext(FieldContext);
  return {
    id: own.id ?? f?.id,
    'aria-describedby':
      [own['aria-describedby'], f?.describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': own['aria-invalid'] ?? (f?.invalid ? true : undefined),
    required: own.required ?? (f?.required || undefined),
  };
}

export interface FormFieldProps {
  /** Id for the control (defaults to a generated one). Useful when other code needs to focus the control. */
  id?: string;
  label: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Text shown next to required labels for screen readers and sighted users alike (e.g. "required"). */
  requiredLabel?: string;
  className?: string;
  /** Hide the visible label (keeps it for assistive tech). Prefer a visible label. */
  hideLabel?: boolean;
}

export function FormField({
  id: idProp,
  label,
  children,
  description,
  error,
  required,
  requiredLabel,
  className,
  hideLabel,
}: FormFieldProps) {
  const auto = useId();
  const id = idProp ?? auto;
  const descId = description ? `${id}-desc` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const ctx: FieldCtx = {
    id,
    describedBy: [descId, errId].filter(Boolean).join(' ') || undefined,
    invalid: Boolean(error),
    required: Boolean(required),
  };
  return (
    <div className={cx('yl-field', className)}>
      <label htmlFor={id} className={cx('yl-field__label', hideLabel && 'yl-sr-only')}>
        {label}
        {required && requiredLabel ? (
          <span className="yl-field__req"> ({requiredLabel})</span>
        ) : null}
      </label>
      {description ? (
        <p id={descId} className="yl-field__desc">
          {description}
        </p>
      ) : null}
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {/* The error container is always mounted so screen readers announce text changes. */}
      <p id={errId} className="yl-field__error" role="alert" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ Input
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  endAdornment?: ReactNode;
}
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, endAdornment, className, ...rest },
  ref,
) {
  const f = useFieldProps({
    id: rest.id,
    'aria-describedby': rest['aria-describedby'],
    'aria-invalid': invalid ? true : rest['aria-invalid'],
    required: rest.required,
  });
  const input = (
    <input
      ref={ref}
      className={cx('yl-input', Boolean(endAdornment) && 'yl-input--has-end', className)}
      {...rest}
      {...f}
    />
  );
  if (!endAdornment) return input;
  return (
    <div className="yl-input-wrap">
      {input}
      <span className="yl-input-wrap__end">{endAdornment}</span>
    </div>
  );
});

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'endAdornment'> {
  showLabel: string;
  hideLabel: string;
}
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ showLabel, hideLabel, ...rest }, ref) {
    const [shown, setShown] = useState(false);
    return (
      <Input
        ref={ref}
        {...rest}
        type={shown ? 'text' : 'password'}
        autoCapitalize="none"
        spellCheck={false}
        endAdornment={
          <button
            type="button"
            className="yl-input-toggle"
            aria-pressed={shown}
            onClick={() => setShown((s) => !s)}
          >
            <EyeOffIcon size={18} />
            <span className="yl-sr-only">{shown ? hideLabel : showLabel}</span>
          </button>
        }
      />
    );
  },
);

// ------------------------------------------------------------------ Textarea
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 3, ...rest },
  ref,
) {
  const f = useFieldProps({
    id: rest.id,
    'aria-describedby': rest['aria-describedby'],
    'aria-invalid': invalid ? true : rest['aria-invalid'],
    required: rest.required,
  });
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx('yl-input yl-textarea', className)}
      {...rest}
      {...f}
    />
  );
});

// ------------------------------------------------------------------ Select (native, styled)
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  const f = useFieldProps({
    id: rest.id,
    'aria-describedby': rest['aria-describedby'],
    'aria-invalid': invalid ? true : rest['aria-invalid'],
    required: rest.required,
  });
  return (
    <select ref={ref} className={cx('yl-input yl-select', className)} {...rest} {...f}>
      {children}
    </select>
  );
});

// ------------------------------------------------------------------ Checkbox / Switch / Radio (native inputs, custom paint)
interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  label: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, ChoiceProps>(function Checkbox(
  { label, description, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className={cx('yl-choice', className)}>
      <input
        ref={ref}
        id={cid}
        type="checkbox"
        className="yl-choice__input yl-checkbox"
        aria-describedby={description ? `${cid}-d` : undefined}
        {...rest}
      />
      <div className="yl-choice__text">
        <label htmlFor={cid} className="yl-choice__label">
          {label}
        </label>
        {description ? (
          <span id={`${cid}-d`} className="yl-choice__desc">
            {description}
          </span>
        ) : null}
      </div>
    </div>
  );
});

/** A real checkbox with role="switch": native keyboard behaviour (Space) and form semantics. */
export const Switch = forwardRef<HTMLInputElement, ChoiceProps>(function Switch(
  { label, description, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className={cx('yl-choice yl-choice--switch', className)}>
      <div className="yl-choice__text">
        <label htmlFor={cid} className="yl-choice__label">
          {label}
        </label>
        {description ? (
          <span id={`${cid}-d`} className="yl-choice__desc">
            {description}
          </span>
        ) : null}
      </div>
      <input
        ref={ref}
        id={cid}
        type="checkbox"
        role="switch"
        className="yl-choice__input yl-switch"
        aria-describedby={description ? `${cid}-d` : undefined}
        {...rest}
      />
    </div>
  );
});

interface RadioCtx {
  name: string;
  value: string | undefined;
  onChange: (v: string) => void;
  disabled?: boolean | undefined;
}
const RadioContext = createContext<RadioCtx | null>(null);

export interface RadioGroupProps {
  legend: ReactNode;
  name?: string;
  value: string | undefined;
  onValueChange: (v: string) => void;
  children: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  hideLegend?: boolean;
}
export function RadioGroup({
  legend,
  name,
  value,
  onValueChange,
  children,
  description,
  disabled,
  className,
  hideLegend,
}: RadioGroupProps) {
  const auto = useId();
  return (
    <fieldset className={cx('yl-radiogroup', className)} disabled={disabled}>
      <legend className={cx('yl-radiogroup__legend', hideLegend && 'yl-sr-only')}>{legend}</legend>
      {description ? <p className="yl-field__desc">{description}</p> : null}
      <RadioContext.Provider
        value={{ name: name ?? auto, value, onChange: onValueChange, disabled }}
      >
        <div className="yl-radiogroup__items">{children}</div>
      </RadioContext.Provider>
    </fieldset>
  );
}

export interface RadioProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'checked' | 'onChange' | 'name'
> {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  /** Render as a bordered "option card" (used for audience pickers). */
  card?: boolean;
}
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { value, label, description, card, className, id, ...rest },
  ref,
) {
  const ctx = useContext(RadioContext);
  const auto = useId();
  const cid = id ?? auto;
  if (!ctx) throw new Error('<Radio> must be used inside <RadioGroup>');
  const checked = ctx.value === value;
  return (
    <div className={cx('yl-choice', card && 'yl-choice--card', checked && 'is-checked', className)}>
      <input
        ref={ref}
        id={cid}
        type="radio"
        className="yl-choice__input yl-radio"
        name={ctx.name}
        value={value}
        checked={checked}
        disabled={ctx.disabled || rest.disabled}
        onChange={() => ctx.onChange(value)}
        aria-describedby={description ? `${cid}-d` : undefined}
        {...rest}
      />
      <div className="yl-choice__text">
        <label htmlFor={cid} className="yl-choice__label">
          {label}
        </label>
        {description ? (
          <span id={`${cid}-d`} className="yl-choice__desc">
            {description}
          </span>
        ) : null}
      </div>
    </div>
  );
});
