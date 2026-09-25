import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { ToastProvider, UIProvider } from '@yapilapi/ui';
import type { AdminMe, ApiClient, PlatformRoleName, SelfUser } from '@yapilapi/api-client';
import { I18nProvider, useI18n, type Locale } from '@/i18n';
import { ApiTestProvider } from '@/lib/api';
import { AdminTestProvider, makeAdminContext } from '@/lib/session';

/**
 * The real permission matrix, parsed from the API's own source (apps/api/src/modules/admin/rbac.ts). Tests use it so the
 * console is exercised with exactly the permissions each role gets from GET /v1/admin/me, and so a permission the console
 * uses that the API does not know about fails a test.
 */
export function loadPermissionMatrix(): {
  all: string[];
  byRole: Record<Exclude<PlatformRoleName, 'user'>, Set<string>>;
} {
  const src = readFileSync(path.resolve(__dirname, '../../api/src/modules/admin/rbac.ts'), 'utf8');
  const list = /export const PERMISSIONS = \[([\s\S]*?)\] as const;/.exec(src)?.[1];
  const added =
    /const ADDED: Record<PlatformRole, readonly Permission\[\]> = \{([\s\S]*?)\n\};/.exec(src)?.[1];
  if (!list || !added) throw new Error('could not parse rbac.ts');
  const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const perRole: Record<string, string[]> = {};
  for (const m of added.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) perRole[m[1]!] = quoted(m[2]!);
  const byRole = {} as Record<Exclude<PlatformRoleName, 'user'>, Set<string>>;
  let acc = new Set<string>();
  for (const role of ['support', 'moderator', 'admin', 'superadmin'] as const) {
    acc = new Set([...acc, ...(perRole[role] ?? [])]);
    byRole[role] = acc;
  }
  return { all: quoted(list), byRole };
}

export const MATRIX = loadPermissionMatrix();

export function fakeUser(
  role: PlatformRoleName,
  id = '00000000-0000-4000-8000-000000000001',
): SelfUser {
  return {
    id,
    platformRole: role,
    profile: { username: `${role}_user`, displayName: `${role} person` },
  } as unknown as SelfUser;
}

export function adminMe(
  role: Exclude<PlatformRoleName, 'user'>,
  userId = '00000000-0000-4000-8000-000000000001',
): AdminMe {
  return { userId, role, permissions: [...MATRIX.byRole[role]] };
}

/** A fake ApiClient: only what a test supplies exists; calling anything else fails loudly. */
export function fakeClient(
  parts: { admin?: Record<string, unknown>; auth?: Record<string, unknown> } = {},
): ApiClient {
  const strict = (name: string, obj: Record<string, unknown> = {}) =>
    new Proxy(obj, {
      get: (t, k) =>
        k in t
          ? t[k as string]
          : typeof k === 'string' && k !== 'then'
            ? () => {
                throw new Error(`unexpected API call: ${name}.${k}`);
              }
            : undefined,
    });
  return {
    admin: strict('admin', parts.admin),
    auth: strict('auth', parts.auth),
  } as unknown as ApiClient;
}

function Providers({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  return (
    <UIProvider Link={({ href, ...rest }) => <a href={href} {...rest} />} locale={locale}>
      <ToastProvider regionLabel={t('toast.region')} dismissLabel={t('toast.dismiss')}>
        {children}
      </ToastProvider>
    </UIProvider>
  );
}

export interface RenderOpts {
  role?: Exclude<PlatformRoleName, 'user'>;
  client?: ApiClient;
  locale?: Locale;
  userId?: string;
}

/** Render a view as a signed-in staff member of `role` with the API's real permissions for that role. */
export function renderAsStaff(ui: ReactElement, opts: RenderOpts = {}) {
  const role = opts.role ?? 'admin';
  const ctx = makeAdminContext(fakeUser(role, opts.userId), adminMe(role, opts.userId));
  const client = opts.client ?? fakeClient();
  return render(
    <I18nProvider locale={opts.locale ?? 'en'}>
      <ApiTestProvider client={client}>
        <AdminTestProvider value={ctx}>
          <Providers>{ui}</Providers>
        </AdminTestProvider>
      </ApiTestProvider>
    </I18nProvider>,
  );
}

/** Render without a staff session (sign-in screen and other public views). */
export function renderPublic(ui: ReactElement, opts: { client?: ApiClient; locale?: Locale } = {}) {
  return render(
    <I18nProvider locale={opts.locale ?? 'en'}>
      <ApiTestProvider client={opts.client ?? fakeClient()}>
        <Providers>{ui}</Providers>
      </ApiTestProvider>
    </I18nProvider>,
  );
}

export const spy = <T extends (...a: never[]) => unknown>(impl?: T) => vi.fn(impl);
