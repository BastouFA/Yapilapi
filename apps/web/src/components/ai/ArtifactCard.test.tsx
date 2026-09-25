import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AiArtifact } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { ArtifactCard } from './ArtifactCard';

function artifact(overrides: Partial<AiArtifact> = {}): AiArtifact {
  return {
    id: 'a1',
    kind: 'post_draft',
    status: 'draft',
    tool: 'draft_post',
    provider: 'dev',
    payload: { body: 'Original text', visibility: 'public' },
    sources: [],
    edited: false,
    conversationId: null,
    result: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
    ...overrides,
  };
}

describe('ArtifactCard', () => {
  it('requires an explicit confirm click before calling confirmArtifact', async () => {
    const confirmArtifact = vi.fn().mockResolvedValue({
      artifact: artifact({ status: 'confirmed' }),
      action: 'post_created',
      created: { type: 'post', id: 'p1' },
    });
    const client = fakeClient({ ai: { confirmArtifact } });
    renderWithProviders(
      <ArtifactCard artifact={artifact()} onChanged={vi.fn()} onRemoved={vi.fn()} />,
      { client },
    );

    // Clicking "Confirm and apply" only opens a dialog; the API is not called yet.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    expect(confirmArtifact).not.toHaveBeenCalled();

    // The dialog names the real action about to happen.
    expect(screen.getByText(/Apply this draft\?/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm and apply' })[1]!);

    await waitFor(() => expect(confirmArtifact).toHaveBeenCalledWith('a1', {}));
  });

  it('edits the body before confirming, and sends the edited text', async () => {
    const editArtifact = vi
      .fn()
      .mockResolvedValue(artifact({ payload: { body: 'Edited text', visibility: 'public' } }));
    const onChanged = vi.fn();
    const client = fakeClient({ ai: { editArtifact } });
    renderWithProviders(
      <ArtifactCard artifact={artifact()} onChanged={onChanged} onRemoved={vi.fn()} />,
      { client },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByDisplayValue('Original text');
    fireEvent.change(textarea, { target: { value: 'Edited text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    await waitFor(() => expect(editArtifact).toHaveBeenCalledWith('a1', { body: 'Edited text' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('discards a draft only after the confirmation dialog', async () => {
    const discardArtifact = vi.fn().mockResolvedValue(undefined);
    const onRemoved = vi.fn();
    const client = fakeClient({ ai: { discardArtifact } });
    renderWithProviders(
      <ArtifactCard artifact={artifact()} onChanged={vi.fn()} onRemoved={onRemoved} />,
      { client },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(discardArtifact).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[1]!);

    await waitFor(() => expect(discardArtifact).toHaveBeenCalledWith('a1'));
    expect(onRemoved).toHaveBeenCalledWith('a1');
  });

  it('lets the person pick a caption option and confirms with that selection', async () => {
    const confirmArtifact = vi.fn().mockResolvedValue({
      artifact: artifact({ kind: 'caption', status: 'confirmed' }),
      action: 'accepted',
      created: null,
      text: 'Option two',
    });
    const client = fakeClient({ ai: { confirmArtifact } });
    renderWithProviders(
      <ArtifactCard
        artifact={artifact({
          kind: 'caption',
          payload: { options: ['Option one', 'Option two'], selected: 0 },
        })}
        onChanged={vi.fn()}
        onRemoved={vi.fn()}
      />,
      { client },
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Option two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm and apply' })[1]!);

    await waitFor(() => expect(confirmArtifact).toHaveBeenCalledWith('a1', { selected: 1 }));
  });
});
