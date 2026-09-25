import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeveloperApp, DeveloperAppCreated } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { DeveloperAppsListView } from './DeveloperAppsListView';

function app(overrides: Partial<DeveloperApp> = {}): DeveloperApp {
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
    ...overrides,
  };
}

describe('DeveloperAppsListView', () => {
  it('lists my developer apps', async () => {
    const client = fakeClient({
      developer: { apps: vi.fn().mockResolvedValue({ items: [app()] }) },
    });
    renderWithProviders(<DeveloperAppsListView />, { client });
    await waitFor(() => expect(screen.getByText('My App')).toBeInTheDocument());
  });

  it('registers a new app and shows the client secret once', async () => {
    const created: DeveloperAppCreated = {
      ...app({ id: 'app2', name: 'New App' }),
      clientSecret: 'ylcs_super_secret_value',
      note: 'Store the client secret now; it cannot be shown again.',
    };
    const createApp = vi.fn().mockResolvedValue(created);
    const client = fakeClient({
      developer: {
        apps: vi.fn().mockResolvedValue({ items: [] }),
        createApp,
      },
    });
    renderWithProviders(<DeveloperAppsListView />, { client });

    await waitFor(() => expect(screen.getByText('Register an app')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'New App' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register app' }));

    await waitFor(() =>
      expect(createApp).toHaveBeenCalledWith({
        name: 'New App',
        description: undefined,
        confidential: true,
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ylcs_super_secret_value');
    const doneButton = screen.getByTestId('secret-once-done');
    expect(doneButton).toBeDisabled();
    fireEvent.click(screen.getByTestId('secret-once-saved'));
    expect(doneButton).not.toBeDisabled();
    fireEvent.click(doneButton);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
