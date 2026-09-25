import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MediaObject, StudioCapabilities, StudioProject } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { ProjectsListView } from './ProjectsListView';

function status(): StudioCapabilities {
  return {
    render: { available: true, burnInCaptions: true },
    analysis: { available: true },
    speech: { available: false },
    aiSuggestions: { available: false },
  };
}

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
    rendered: false,
    renderError: null,
    aiAssisted: [],
    publishedPostId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function media(overrides: Partial<MediaObject> = {}): MediaObject {
  return {
    id: 'media1',
    kind: 'video',
    status: 'ready',
    mimeType: 'video/mp4',
    url: 'https://example.com/v.mp4',
    width: 1280,
    height: 720,
    durationMs: 10_000,
    altText: null,
    decorative: false,
    blurhash: null,
    needsAltText: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ProjectsListView', () => {
  it('lists existing projects', async () => {
    const client = fakeClient({
      studio: {
        status: vi.fn().mockResolvedValue(status()),
        projects: vi.fn().mockResolvedValue({ items: [project()] }),
      },
    });
    renderWithProviders(<ProjectsListView />, { client });

    await waitFor(() => expect(screen.getByText('My edit')).toBeInTheDocument());
  });

  it('uploads a file then creates a project from it', async () => {
    const upload = vi.fn().mockResolvedValue(media());
    const createProject = vi.fn().mockResolvedValue(project());
    const client = fakeClient({
      studio: {
        status: vi.fn().mockResolvedValue(status()),
        projects: vi.fn().mockResolvedValue({ items: [] }),
        createProject,
      },
      media: { upload },
    });
    renderWithProviders(<ProjectsListView />, { client });

    await waitFor(() => expect(screen.getByLabelText('Video or audio file')).toBeInTheDocument());
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('Video or audio file'), { target: { files: [file] } });
    await waitFor(() => expect(upload).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New clip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        title: 'New clip',
        description: undefined,
        mediaId: 'media1',
      }),
    );
  });
});
