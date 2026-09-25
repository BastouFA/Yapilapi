import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MediaObject, RealCapture, RealTrayGroup } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { RealView } from './RealView';

function capture(overrides: Partial<RealCapture> = {}): RealCapture {
  return {
    id: 'cap1',
    author: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null },
    front: {
      id: 'm1',
      kind: 'image',
      url: 'https://example.com/front.jpg',
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
      durationMs: null,
      altText: null,
      blurhash: null,
      status: 'ready',
    },
    rear: null,
    caption: 'At the beach',
    location: null,
    capturedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    authenticity: {},
    indicators: [{ key: 'in_app', ok: true, label: 'Captured in app' }],
    visibility: 'friends',
    reactionCount: 0,
    viewer: { reaction: null, isAuthor: true },
    createdAt: new Date().toISOString(),
    sharedPostId: null,
    ...overrides,
  };
}

function media(): MediaObject {
  return {
    id: 'm1',
    kind: 'image',
    status: 'ready',
    mimeType: 'image/jpeg',
    url: 'https://example.com/front.jpg',
    width: 800,
    height: 600,
    durationMs: null,
    altText: null,
    decorative: false,
    blurhash: null,
    needsAltText: false,
    createdAt: new Date().toISOString(),
  };
}

function tray(): RealTrayGroup[] {
  return [
    {
      author: { id: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null },
      count: 1,
      latestAt: new Date().toISOString(),
      items: [
        capture({
          id: 'cap2',
          author: { id: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null },
        }),
      ],
    },
  ];
}

describe('RealView', () => {
  it('shows the friends tray by default', async () => {
    const client = fakeClient({
      real: { tray: vi.fn().mockResolvedValue({ items: tray() }) },
    });
    renderWithProviders(<RealView />, { client });
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());
  });

  it('captures a Real: session, upload, then create', async () => {
    const startCaptureSession = vi.fn().mockResolvedValue({
      token: 'tok1',
      expiresAt: new Date().toISOString(),
      ttlSec: 60,
      method: 'in_app_token',
      attestation: { available: false, provider: 'none' },
      clockSkewMs: null,
    });
    const upload = vi.fn().mockResolvedValue(media());
    const createCapture = vi.fn().mockResolvedValue(capture());
    const client = fakeClient({
      real: {
        tray: vi.fn().mockResolvedValue({ items: [] }),
        mine: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        startCaptureSession,
        createCapture,
      },
      media: { upload },
    });
    renderWithProviders(<RealView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'My Reals' }));
    await waitFor(() => expect(screen.getByText('Capture a Real')).toBeInTheDocument());

    const file = new File(['x'], 'front.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Front-facing photo (you)'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post my Real' }));

    await waitFor(() => expect(startCaptureSession).toHaveBeenCalled());
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, { purpose: 'attachment' }));
    await waitFor(() =>
      expect(createCapture).toHaveBeenCalledWith(
        expect.objectContaining({ captureToken: 'tok1', frontMediaId: 'm1' }),
      ),
    );
  });

  it('reacts to a capture', async () => {
    const react = vi.fn().mockResolvedValue({ reactionCount: 1 });
    const client = fakeClient({
      real: {
        tray: vi.fn().mockResolvedValue({ items: [] }),
        mine: vi.fn().mockResolvedValue({ items: [capture()], nextCursor: null }),
        react,
      },
    });
    renderWithProviders(<RealView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'My Reals' }));
    await waitFor(() => expect(screen.getByText('At the beach')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Like' }));
    await waitFor(() => expect(react).toHaveBeenCalledWith('cap1', 'like'));
  });

  it('deletes a capture only after confirming the dialog', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      real: {
        tray: vi.fn().mockResolvedValue({ items: [] }),
        mine: vi.fn().mockResolvedValue({ items: [capture()], nextCursor: null }),
        remove,
      },
    });
    renderWithProviders(<RealView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'My Reals' }));
    await waitFor(() => expect(screen.getByText('At the beach')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('cap1'));
  });

  it('saves reminder settings', async () => {
    const setReminders = vi.fn().mockResolvedValue({
      enabled: true,
      days: [1],
      localMinute: 18 * 60,
      timezone: 'UTC',
    });
    const client = fakeClient({
      real: {
        tray: vi.fn().mockResolvedValue({ items: [] }),
        reminders: vi
          .fn()
          .mockResolvedValue({ enabled: false, days: [], localMinute: 18 * 60, timezone: 'UTC' }),
        setReminders,
      },
    });
    renderWithProviders(<RealView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Reminder' }));
    await waitFor(() => expect(screen.getByText('Remind me')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setReminders).toHaveBeenCalled());
  });
});
