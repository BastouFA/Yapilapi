import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioProject, StudioPublication, StudioSuggestion } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { ProjectDetailView } from './ProjectDetailView';

function project(overrides: Partial<StudioProject> = {}): StudioProject {
  return {
    id: 'proj1',
    title: 'My edit',
    description: '',
    mediaId: 'media1',
    status: 'draft',
    edl: { version: 1, segments: [], aspect: null, thumbnail: null, captions: null },
    edlVersion: 1,
    edlHash: 'h1',
    outputMediaId: null,
    rendered: true,
    renderError: null,
    aiAssisted: [],
    publishedPostId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function suggestion(overrides: Partial<StudioSuggestion> = {}): StudioSuggestion {
  return {
    id: 'sg1',
    kind: 'title',
    source: 'ai_module',
    provider: 'dev',
    status: 'suggested',
    payload: { text: 'A great title' },
    createdAt: new Date().toISOString(),
    decidedAt: null,
    appliedAutomatically: false,
    ...overrides,
  };
}

describe('ProjectDetailView', () => {
  it('saves an edited recipe', async () => {
    const setEdl = vi.fn().mockResolvedValue(project());
    const client = fakeClient({
      studio: { project: vi.fn().mockResolvedValue(project()), setEdl },
    });
    renderWithProviders(<ProjectDetailView id="proj1" />, { client });

    await waitFor(() => expect(screen.getByText('Edit recipe (EDL)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
    await waitFor(() => expect(setEdl).toHaveBeenCalledWith('proj1', expect.any(Object), 1));
  });

  it('accepts a suggestion only through the accept action, never automatically', async () => {
    const generateSuggestions = vi.fn().mockResolvedValue({ items: [], skipped: [] });
    const acceptSuggestion = vi.fn().mockResolvedValue(project());
    const client = fakeClient({
      studio: {
        project: vi.fn().mockResolvedValue(project()),
        suggestions: vi.fn().mockResolvedValue({ items: [suggestion()] }),
        generateSuggestions,
        acceptSuggestion,
      },
    });
    renderWithProviders(<ProjectDetailView id="proj1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Suggestions' }));
    await waitFor(() => expect(screen.getByText('Title')).toBeInTheDocument());
    expect(acceptSuggestion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(acceptSuggestion).toHaveBeenCalledWith('proj1', 'sg1'));
  });

  it('publishes only after the explicit confirmation dialog', async () => {
    const publish = vi.fn().mockResolvedValue({
      publication: {
        id: 'pub1',
        mode: 'now',
        publishAt: null,
        status: 'published',
        postId: 'post1',
        error: null,
        confirmedAt: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
        mediaId: 'media1',
        contentHash: 'h',
      } satisfies StudioPublication,
      postId: 'post1',
    });
    const client = fakeClient({
      studio: {
        project: vi.fn().mockResolvedValue(project()),
        publication: vi.fn().mockResolvedValue({ publication: null }),
        publish,
      },
    });
    renderWithProviders(<ProjectDetailView id="proj1" />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByText('Not published yet.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(publish).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Publish' })[1]!);
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith('proj1', {
        confirm: true,
        mode: 'now',
        publishAt: undefined,
        body: '',
      }),
    );
  });
});
