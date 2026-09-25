'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { AlertIcon } from '@yapilapi/ui';

/** Form-level error: announced and focused so keyboard / screen-reader users notice it. */
export function FormError({ children, id }: { children: ReactNode; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (children) ref.current?.focus();
  }, [children]);
  if (!children) return null;
  return (
    <div
      ref={ref}
      id={id}
      role="alert"
      tabIndex={-1}
      className="yl-notice yl-notice--danger form-error"
    >
      <AlertIcon size={16} /> <span>{children}</span>
    </div>
  );
}

export function FormSuccess({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div role="status" className="yl-notice yl-notice--success form-error">
      {children}
    </div>
  );
}
