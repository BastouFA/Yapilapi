import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from 'react';
import { observeBandwidth, readBandwidth } from '@yapilapi/design-system';

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

export interface UIConfig {
  /** Router-aware link (e.g. next/link). Defaults to a plain <a>. */
  Link: ComponentType<LinkProps>;
  /** BCP-47 locale used by components that format dates and numbers. */
  locale: string;
}

const DefaultLink: ComponentType<LinkProps> = (props) => <a {...props} />;
const Ctx = createContext<UIConfig>({ Link: DefaultLink, locale: 'en' });

export function UIProvider({
  Link,
  locale,
  children,
}: {
  Link?: ComponentType<LinkProps>;
  locale?: string;
  children: ReactNode;
}) {
  const parent = useContext(Ctx);
  const value = useMemo(
    () => ({ Link: Link ?? parent.Link, locale: locale ?? parent.locale }),
    [Link, locale, parent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useUI = (): UIConfig => useContext(Ctx);

/** Low-bandwidth mode as applied to <html data-bandwidth="low"> by @yapilapi/design-system. */
export function useLowBandwidth(): boolean {
  const subscribe = (cb: () => void) =>
    typeof document === 'undefined'
      ? () => undefined
      : observeBandwidth(document.documentElement, cb);
  const get = () =>
    typeof document === 'undefined' ? false : readBandwidth(document.documentElement) === 'low';
  return useSyncExternalStore(subscribe, get, () => false);
}

/** Runs `fn` once on mount (client only). */
export function useMountEffect(fn: () => void | (() => void)): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fn, []);
}
