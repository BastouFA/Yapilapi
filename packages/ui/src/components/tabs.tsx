import {
  createContext,
  useContext,
  useId,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cx, isRtlElement, useControllableState } from '../utils';

interface TabsCtx {
  value: string;
  select: (v: string) => void;
  baseId: string;
}
const TabsContext = createContext<TabsCtx | null>(null);
const useTabs = () => {
  const c = useContext(TabsContext);
  if (!c) throw new Error('Tabs components must be used inside <Tabs>');
  return c;
};

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  children: ReactNode;
  className?: string;
}

/** Tabs with automatic activation, roving tabindex, Home/End, and arrow keys that respect text direction. */
export function Tabs({ value, defaultValue = '', onValueChange, children, className }: TabsProps) {
  const [current, setCurrent] = useControllableState(value, defaultValue, onValueChange);
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ value: current, select: setCurrent, baseId }}>
      <div className={cx('yl-tabs', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

/** Shared arrow-key behaviour for tablists (direction-aware, wraps, Home/End). Tabs must carry `data-value`. */
export function handleTablistKeyDown(
  e: KeyboardEvent<HTMLElement>,
  list: HTMLElement | null,
  select: (v: string) => void,
): void {
  const tabs = Array.from(
    list?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])') ?? [],
  );
  if (tabs.length === 0) return;
  const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
  const rtl = isRtlElement(list);
  let next = -1;
  if (e.key === 'ArrowRight') next = rtl ? i - 1 : i + 1;
  else if (e.key === 'ArrowLeft') next = rtl ? i + 1 : i - 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else return;
  e.preventDefault();
  const target = tabs[(next + tabs.length) % tabs.length]!;
  target.focus();
  const v = target.dataset['value'];
  if (v) select(v);
}

export function TabList({
  label,
  children,
  className,
  ...rest
}: { label: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const { select } = useTabs();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) =>
    handleTablistKeyDown(e, ref.current, select);
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className={cx('yl-tablist', className)}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Tab({
  value,
  children,
  disabled,
  icon,
}: {
  value: string;
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const { value: current, select, baseId } = useTabs();
  const selected = current === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      data-value={value}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      className={cx('yl-tab', selected && 'is-selected')}
      onClick={() => select(value)}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
  keepMounted,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
}) {
  const { value: current, baseId } = useTabs();
  const selected = current === value;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!selected}
      tabIndex={0}
      className={cx('yl-tabpanel', className)}
    >
      {selected || keepMounted ? children : null}
    </div>
  );
}
