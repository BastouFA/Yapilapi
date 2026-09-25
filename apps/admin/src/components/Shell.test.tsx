import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeClient, renderAsStaff } from '@/test-utils';
import { routerMock } from '@/test-router';
import { Guard } from './Gate';
import { Shell } from './Shell';

const links = () =>
  within(screen.getByRole('navigation', { name: 'Console sections' }))
    .getAllByRole('link')
    .map((a) => a.textContent?.trim());

describe('console shell', () => {
  it('shows support only the read-only sections', () => {
    renderAsStaff(
      <Shell>
        <p>content</p>
      </Shell>,
      { role: 'support' },
    );
    expect(links()).toEqual([
      'Dashboard',
      'Users',
      'Content lookup',
      'Moderation',
      'Communities',
      'Businesses',
      'Creators',
      'Payments',
    ]);
  });

  it('shows admins the audit log, flags, analytics and fraud review', () => {
    renderAsStaff(
      <Shell>
        <p>content</p>
      </Shell>,
      { role: 'admin' },
    );
    expect(links()).toEqual(
      expect.arrayContaining([
        'Audit log',
        'Feature flags',
        'Analytics',
        'Fraud review',
        'AI usage',
        'Mini apps',
      ]),
    );
  });

  it('names the signed-in person and role, and offers a skip link and landmarks', () => {
    renderAsStaff(
      <Shell>
        <p>content</p>
      </Shell>,
      { role: 'moderator' },
    );
    expect(screen.getByTestId('whoami')).toHaveTextContent('moderator_user');
    expect(screen.getByTestId('whoami')).toHaveTextContent('Moderator');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('main')).toHaveTextContent('content');
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('signs out through the API and returns to the sign-in page', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    renderAsStaff(
      <Shell>
        <p>content</p>
      </Shell>,
      { client: fakeClient({ auth: { logout } }) },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/login'));
  });

  it('still leaves the page when the session is already gone', async () => {
    const logout = vi.fn().mockRejectedValue(new Error('401'));
    renderAsStaff(
      <Shell>
        <p>content</p>
      </Shell>,
      { client: fakeClient({ auth: { logout } }) },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/login'));
  });

  it('toggles the mobile menu with correct aria state', async () => {
    renderAsStaff(
      <Shell>
        <p>content</p>
      </Shell>,
    );
    const toggle = screen.getByRole('button', { name: 'Menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('offers a language switch that includes right-to-left Arabic', () => {
    renderAsStaff(
      <Shell>
        <p>content</p>
      </Shell>,
    );
    const select = screen.getByRole('combobox', { name: 'Language' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['English', 'Français', 'العربية', 'Yorùbá']);
  });
});

describe('page guard', () => {
  it('renders the page when the role has the permission', () => {
    renderAsStaff(
      <Guard permission="audit.read">
        <p>audit page</p>
      </Guard>,
      { role: 'admin' },
    );
    expect(screen.getByText('audit page')).toBeInTheDocument();
  });

  it('shows a plain "not available for your role" state otherwise, without rendering the page', () => {
    renderAsStaff(
      <Guard permission="audit.read">
        <p>audit page</p>
      </Guard>,
      { role: 'moderator' },
    );
    expect(screen.queryByText('audit page')).toBeNull();
    expect(screen.getByTestId('no-access')).toHaveTextContent('Not available for your role');
  });

  it('can also gate on a minimum role', () => {
    renderAsStaff(
      <Guard minRole="moderator">
        <p>tools</p>
      </Guard>,
      { role: 'support' },
    );
    expect(screen.queryByText('tools')).toBeNull();
  });
});
