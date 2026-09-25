import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdvertisingPrefs,
  ConnectedApp,
  ConsentStatus,
  PrivacyOverview,
  PrivacyRequest,
  VisibilityOverview,
} from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { PrivacyCenterSection } from './PrivacyCenterSection';

function overview(): PrivacyOverview {
  return {
    categories: [
      {
        key: 'content',
        label: 'Posts, comments, reactions and saves',
        items: 12,
        purpose: 'Showing your content',
        retention: 'Until you delete it',
      },
    ],
    connectedApps: 1,
    consents: [],
    exportSections: [],
    retainedAfterDeletion: ['Financial records as required by law'],
    rights: {
      export: '/v1/privacy/export',
      delete: '/v1/account/deletion',
      consents: '/v1/privacy/consents',
    },
  };
}

function consent(overrides: Partial<ConsentStatus> = {}): ConsentStatus {
  return {
    purpose: 'personalization',
    label: 'Personalised recommendations',
    description: 'Tailor your feed.',
    granted: true,
    decidedAt: null,
    isDefault: true,
    canGrant: true,
    ...overrides,
  };
}

function advertising(): AdvertisingPrefs {
  return { personalizedAds: false, hiddenTopics: [], limitSensitive: true, availableToYou: true };
}

function visibility(): VisibilityOverview {
  return {
    profile: { private: false, discoverable: true, whoCanMessage: 'everyone' },
    defaults: { postVisibility: 'public', sensitiveContent: 'limit', personalization: true },
    postsByVisibility: {},
    momentsByVisibility: {},
    controls: { blocked: 0, muted: 0, restricted: 0, circles: 0, connected_apps: 1, guardians: 0 },
  };
}

function connectedApp(): ConnectedApp {
  return {
    id: 'g1',
    app: {
      id: 'app1',
      name: 'Demo App',
      description: null,
      homepageUrl: null,
      privacyUrl: null,
      developer: 'ada',
    },
    scopes: [{ scope: 'profile:read', description: 'Read your profile' }],
    authorizedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

function baseClient(overrides: Record<string, unknown> = {}) {
  return fakeClient({
    privacy: {
      overview: vi.fn().mockResolvedValue(overview()),
      consents: vi.fn().mockResolvedValue({ items: [consent()] }),
      advertising: vi.fn().mockResolvedValue(advertising()),
      visibility: vi.fn().mockResolvedValue(visibility()),
      requests: vi.fn().mockResolvedValue({ items: [] }),
      connectedApps: vi.fn().mockResolvedValue({ items: [connectedApp()] }),
      ...overrides,
    },
  });
}

describe('PrivacyCenterSection', () => {
  it('renders the overview, consents, visibility and connected apps once loaded', async () => {
    const client = baseClient();
    renderWithProviders(<PrivacyCenterSection />, { client });

    await waitFor(() =>
      expect(screen.getByText('Posts, comments, reactions and saves')).toBeInTheDocument(),
    );
    expect(screen.getByText('Personalised recommendations')).toBeInTheDocument();
    expect(screen.getByText('Demo App')).toBeInTheDocument();
  });

  it('toggles a consent', async () => {
    const setConsent = vi
      .fn()
      .mockResolvedValue({ purpose: 'personalization', granted: false, changed: true, label: 'x' });
    const client = baseClient({ setConsent });
    renderWithProviders(<PrivacyCenterSection />, { client });

    await waitFor(() =>
      expect(screen.getByText('Personalised recommendations')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Personalised recommendations' }));

    await waitFor(() => expect(setConsent).toHaveBeenCalledWith('personalization', false));
  });

  it('requests a data export', async () => {
    const requestExport = vi.fn().mockResolvedValue({
      requestId: 'r1',
      status: 'processing',
      expiresAt: new Date().toISOString(),
      sizeBytes: 0,
      next: '/v1/privacy/requests/r1/download-link',
    });
    const client = baseClient({ requestExport });
    renderWithProviders(<PrivacyCenterSection />, { client });

    await waitFor(() => expect(screen.getByText('Download your data')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Request export' }));

    await waitFor(() => expect(requestExport).toHaveBeenCalledWith({}));
  });

  it('revokes a connected app only after the confirmation dialog', async () => {
    const revokeConnectedApp = vi.fn().mockResolvedValue(undefined);
    const client = baseClient({ revokeConnectedApp });
    renderWithProviders(<PrivacyCenterSection />, { client });

    await waitFor(() => expect(screen.getByText('Demo App')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(revokeConnectedApp).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!);
    await waitFor(() => expect(revokeConnectedApp).toHaveBeenCalledWith('g1'));
  });

  it('shows past export requests with a download action once ready', async () => {
    const req: PrivacyRequest = {
      id: 'r1',
      kind: 'export',
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      export: { downloadable: true, expiresAt: new Date().toISOString(), sizeBytes: 1234 },
    };
    const client = baseClient({ requests: vi.fn().mockResolvedValue({ items: [req] }) });
    renderWithProviders(<PrivacyCenterSection />, { client });

    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});
