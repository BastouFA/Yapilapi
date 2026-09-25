import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  DeveloperApiKey,
  DeveloperAppDetail,
  DeveloperWebhook,
  WebhookDelivery,
} from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { DeveloperAppDetailView } from './DeveloperAppDetailView';

function app(overrides: Partial<DeveloperAppDetail> = {}): DeveloperAppDetail {
  return {
    id: 'app1',
    name: 'My App',
    description: null,
    clientId: 'yl_abc123',
    confidential: true,
    redirectUris: [],
    homepageUrl: null,
    privacyUrl: null,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: { authorizedUsers: 0, activeKeys: 1, webhooks: 1 },
    ...overrides,
  };
}

function key(overrides: Partial<DeveloperApiKey> = {}): DeveloperApiKey {
  return {
    id: 'key1',
    name: 'default',
    prefix: 'ylk_abc12345',
    scopes: ['public:read'],
    rateLimitPerMin: 120,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function webhook(overrides: Partial<DeveloperWebhook> = {}): DeveloperWebhook {
  return {
    id: 'wh1',
    appId: 'app1',
    url: 'https://example.com/hooks/yapilapi',
    events: ['ping'],
    description: null,
    active: true,
    disabledReason: null,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'del1',
    eventType: 'ping',
    eventId: 'evt1',
    status: 'delivered',
    attempts: 1,
    lastStatusCode: 200,
    lastError: null,
    nextAttemptAt: null,
    deliveredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('DeveloperAppDetailView', () => {
  it('creates an API key and shows it only once', async () => {
    const createKey = vi.fn().mockResolvedValue({
      ...key(),
      key: 'ylk_freshly_minted_value',
      note: 'Store this key now; it cannot be shown again.',
    });
    const client = fakeClient({
      developer: {
        app: vi.fn().mockResolvedValue(app()),
        keys: vi.fn().mockResolvedValue({ items: [] }),
        createKey,
      },
    });
    renderWithProviders(<DeveloperAppDetailView id="app1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'API keys' }));
    await waitFor(() => expect(screen.getByText('Create API key')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() => expect(createKey).toHaveBeenCalledWith('app1', expect.any(Object)));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ylk_freshly_minted_value');
  });

  it('revokes an API key only after confirming the dialog', async () => {
    const revokeKey = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      developer: {
        app: vi.fn().mockResolvedValue(app()),
        keys: vi.fn().mockResolvedValue({ items: [key()] }),
        revokeKey,
      },
    });
    renderWithProviders(<DeveloperAppDetailView id="app1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'API keys' }));
    await waitFor(() => expect(screen.getByText(/default/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(revokeKey).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith('app1', 'key1'));
  });

  it('creates a webhook and shows its signing secret only once', async () => {
    const createWebhook = vi.fn().mockResolvedValue({
      ...webhook(),
      secret: 'whsec_freshly_minted',
      note: 'Store the signing secret now; it cannot be shown again.',
    });
    const client = fakeClient({
      developer: {
        app: vi.fn().mockResolvedValue(app()),
        webhooks: vi.fn().mockResolvedValue({ items: [] }),
        webhookEvents: vi.fn().mockResolvedValue({
          items: [{ type: 'ping', description: 'Sent when you press "send test event".' }],
        }),
        createWebhook,
      },
    });
    renderWithProviders(<DeveloperAppDetailView id="app1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Webhooks' }));
    await waitFor(() => expect(screen.getByText('Add a webhook')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'https://example.com/hooks' },
    });
    fireEvent.click(screen.getByLabelText(/ping —/));
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }));

    await waitFor(() =>
      expect(createWebhook).toHaveBeenCalledWith('app1', {
        url: 'https://example.com/hooks',
        events: ['ping'],
        description: undefined,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('whsec_freshly_minted');
  });

  it('shows a webhook delivery log', async () => {
    const deliveries = vi.fn().mockResolvedValue({ items: [delivery()], nextCursor: null });
    const client = fakeClient({
      developer: {
        app: vi.fn().mockResolvedValue(app()),
        webhooks: vi.fn().mockResolvedValue({ items: [webhook()] }),
        webhookEvents: vi.fn().mockResolvedValue({ items: [] }),
        deliveries,
      },
    });
    renderWithProviders(<DeveloperAppDetailView id="app1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Webhooks' }));
    await waitFor(() =>
      expect(screen.getByText('https://example.com/hooks/yapilapi')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'View deliveries' }));

    await waitFor(() => expect(deliveries).toHaveBeenCalledWith('wh1', expect.any(Object)));
    await waitFor(() => expect(screen.getByText('Delivered')).toBeInTheDocument());
  });

  it('deletes the app only after confirming the dialog', async () => {
    const deleteApp = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      developer: {
        app: vi.fn().mockResolvedValue(app()),
        deleteApp,
      },
    });
    renderWithProviders(<DeveloperAppDetailView id="app1" />, { client });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete app' }));
    expect(deleteApp).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete app' }));
    await waitFor(() => expect(deleteApp).toHaveBeenCalledWith('app1'));
  });
});
