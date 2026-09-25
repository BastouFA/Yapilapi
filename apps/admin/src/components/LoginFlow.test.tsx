import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@yapilapi/api-client';
import { fakeClient, fakeUser, renderPublic } from '@/test-utils';
import { routerMock } from '@/test-router';
import { LoginFlow } from './LoginFlow';

const staffLogin = { mfaRequired: false, user: fakeUser('moderator') };

function setup(
  auth: Record<string, unknown>,
  admin: Record<string, unknown> = { me: vi.fn().mockResolvedValue({}) },
  reason?: string,
) {
  renderPublic(<LoginFlow next="/moderation" reason={reason} />, {
    client: fakeClient({ auth, admin }),
  });
  return userEvent.setup();
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Email/), 'mod@example.com');
  await user.type(screen.getByLabelText(/^Password/), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('staff sign in', () => {
  it('asks for email and password first, with labelled fields', () => {
    setup({});
    expect(screen.getByRole('heading', { level: 1, name: 'Staff sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toBeRequired();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('requires the authenticator code after the password and then goes to the requested page', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({ mfaRequired: true, challengeToken: 'chal-1' }),
      mfaVerify: vi.fn().mockResolvedValue({ user: fakeUser('moderator') }),
    };
    const admin = {
      me: vi.fn().mockResolvedValue({ userId: 'u', role: 'moderator', permissions: [] }),
    };
    const user = setup(auth, admin);
    await signIn(user);
    expect(auth.login).toHaveBeenCalledWith({
      email: 'mod@example.com',
      password: 'correct horse',
      deviceLabel: 'Staff console',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Two-factor code' })).toHaveFocus();
    await user.type(screen.getByLabelText(/Authenticator code/), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() =>
      expect(auth.mfaVerify).toHaveBeenCalledWith({ challengeToken: 'chal-1', code: '123456' }),
    );
    // The definitive check is the API's own staff endpoint on the now MFA-verified session.
    await waitFor(() => expect(admin.me).toHaveBeenCalled());
    expect(routerMock.replace).toHaveBeenCalledWith('/moderation');
  });

  it('accepts a recovery code instead', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({ mfaRequired: true, challengeToken: 'chal-1' }),
      mfaVerify: vi.fn().mockResolvedValue({}),
    };
    const user = setup(auth);
    await signIn(user);
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByLabelText(/Recovery code/), 'abcd-efgh');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() =>
      expect(auth.mfaVerify).toHaveBeenCalledWith({
        challengeToken: 'chal-1',
        recoveryCode: 'abcd-efgh',
      }),
    );
  });

  it('shows the API message and reference for a wrong code and does not navigate', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({ mfaRequired: true, challengeToken: 'chal-1' }),
      mfaVerify: vi
        .fn()
        .mockRejectedValue(new ApiError('unauthenticated', 'Invalid code', 401, 'req-mfa-1')),
    };
    const user = setup(auth);
    await signIn(user);
    await user.type(await screen.findByLabelText(/Authenticator code/), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('Invalid code')).toBeInTheDocument();
    expect(screen.getByText('req-mfa-1')).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('goes back to the password step when the challenge expired', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({ mfaRequired: true, challengeToken: 'chal-1' }),
      mfaVerify: vi
        .fn()
        .mockRejectedValue(new ApiError('unauthenticated', 'Challenge expired', 401, 'r')),
    };
    const user = setup(auth);
    await signIn(user);
    await user.type(await screen.findByLabelText(/Authenticator code/), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(/verification step expired/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toBeInTheDocument();
  });

  it('refuses a non-staff account and leaves no session behind', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({ mfaRequired: false, user: fakeUser('user') }),
      logout: vi.fn().mockResolvedValue(undefined),
    };
    const user = setup(auth);
    await signIn(user);
    expect(
      (await screen.findByText(/not a staff account/)).closest('[role="alert"]'),
    ).not.toBeNull();
    expect(auth.logout).toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('makes a staff member without an authenticator enrol one before entering', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue(staffLogin),
      mfaSetup: vi.fn().mockResolvedValue({
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: 'otpauth://totp/YAPILAPI:mod?secret=JBSWY3DPEHPK3PXP',
      }),
      mfaEnable: vi
        .fn()
        .mockResolvedValue({ enabled: true, recoveryCodes: ['aaaa-1111', 'bbbb-2222'] }),
    };
    const admin = { me: vi.fn().mockResolvedValue({}) };
    const user = setup(auth, admin);
    await signIn(user);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up two-factor sign-in' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('mfa-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    await user.type(screen.getByLabelText(/Authenticator code/), '654321');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor sign-in' }));
    await waitFor(() => expect(auth.mfaEnable).toHaveBeenCalledWith('654321'));
    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled(); // not until the codes are acknowledged
    await user.click(screen.getByRole('button', { name: 'I saved them, continue' }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/moderation'));
  });

  it('explains why the person was sent back here', () => {
    setup({}, undefined, 'mfa');
    expect(screen.getByText(/two-factor verification/).closest('[role="status"]')).not.toBeNull();
  });

  it('never keeps the password in the URL or storage', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({ mfaRequired: true, challengeToken: 'chal-1' }),
    };
    const user = setup(auth);
    await signIn(user);
    await screen.findByRole('heading', { name: 'Two-factor code' });
    expect(window.location.href).not.toContain('correct');
    expect(JSON.stringify({ ...localStorage })).not.toContain('correct');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('chal-1');
  });
});
