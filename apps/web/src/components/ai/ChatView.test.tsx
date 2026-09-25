import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AiArtifact, AiChatResult } from '@yapilapi/api-client';
import { fakeClient, renderWithProviders } from './test-utils';
import { ChatView } from './ChatView';

function chatResult(overrides: Partial<AiChatResult> = {}): AiChatResult {
  return {
    conversationId: 'c1',
    agent: 'social',
    message: {
      id: 'm1',
      role: 'assistant',
      content: 'Hello!',
      createdAt: new Date().toISOString(),
    },
    provider: 'dev',
    model: null,
    notice: null,
    sources: [],
    toolCalls: [],
    artifacts: [],
    memorySuggestions: [],
    documented: null,
    safety: {
      refused: false,
      category: null,
      output: 'ok',
      reasons: [],
      injectionDetected: false,
      injectionSentencesRemoved: 0,
      notes: [],
    },
    support: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    ...overrides,
  };
}

function artifact(overrides: Partial<AiArtifact> = {}): AiArtifact {
  return {
    id: 'a1',
    kind: 'post_draft',
    status: 'draft',
    tool: 'draft_post',
    provider: 'dev',
    payload: { body: 'A drafted post', visibility: 'public' },
    sources: [],
    edited: false,
    conversationId: 'c1',
    result: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
    ...overrides,
  };
}

describe('ChatView', () => {
  it('shows the empty state before any message is sent', async () => {
    const client = fakeClient({
      ai: {
        agents: vi.fn().mockResolvedValue({ items: [] }),
        conversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      },
    });
    renderWithProviders(<ChatView />, { client });
    await waitFor(() => expect(screen.getByText('Nothing here yet')).toBeInTheDocument());
  });

  it('sends a message and renders the reply with sources', async () => {
    const chat = vi.fn().mockResolvedValue(chatResult({ sources: [{ type: 'event', id: 'e1' }] }));
    const client = fakeClient({
      ai: {
        agents: vi.fn().mockResolvedValue({ items: [] }),
        conversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        chat,
      },
    });
    renderWithProviders(<ChatView />, { client });

    fireEvent.change(screen.getByTestId('ai-composer'), { target: { value: 'What is next?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('Hello!')).toBeInTheDocument());
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ message: 'What is next?' }));
    expect(screen.getByText('event · e1')).toBeInTheDocument();
  });

  it('never applies a draft automatically: the artifact appears pending, needing an explicit confirm', async () => {
    const created = artifact();
    const chat = vi
      .fn()
      .mockResolvedValue(
        chatResult({ artifacts: [{ id: 'a1', kind: 'post_draft', status: 'draft' }] }),
      );
    const getArtifact = vi.fn().mockResolvedValue(created);
    const confirmArtifact = vi.fn();
    const client = fakeClient({
      ai: {
        agents: vi.fn().mockResolvedValue({ items: [] }),
        conversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        chat,
        artifact: getArtifact,
        confirmArtifact,
      },
    });
    renderWithProviders(<ChatView />, { client });

    fireEvent.change(screen.getByTestId('ai-composer'), { target: { value: 'Draft a post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByTestId('ai-artifact')).toBeInTheDocument());
    // The draft's own text is visible, but nothing was posted: confirmArtifact must not have been called.
    expect(screen.getByText('A drafted post')).toBeInTheDocument();
    expect(confirmArtifact).not.toHaveBeenCalled();
  });

  it('shows a safety notice when the assistant refused to answer', async () => {
    const chat = vi.fn().mockResolvedValue(
      chatResult({
        message: { id: 'm2', role: 'assistant', content: '', createdAt: new Date().toISOString() },
        safety: {
          refused: true,
          category: 'unsafe',
          output: 'blocked',
          reasons: ['unsafe'],
          injectionDetected: false,
          injectionSentencesRemoved: 0,
          notes: [],
        },
      }),
    );
    const client = fakeClient({
      ai: {
        agents: vi.fn().mockResolvedValue({ items: [] }),
        conversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        chat,
      },
    });
    renderWithProviders(<ChatView />, { client });

    fireEvent.change(screen.getByTestId('ai-composer'), { target: { value: 'Something unsafe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(screen.getByText('The assistant declined to answer this.')).toBeInTheDocument(),
    );
  });

  it('still shows a draft inline after reopening the conversation (loaded from history, not the live chat response)', async () => {
    // Regression test: a reopened conversation renders its turns from GET .../messages, which carries
    // artifact ids inside each message's toolCalls rather than in a top-level `artifacts` field. A draft
    // must still surface here, not only right after the chat call that created it.
    const created = artifact();
    const getArtifact = vi.fn().mockResolvedValue(created);
    const client = fakeClient({
      ai: {
        agents: vi.fn().mockResolvedValue({ items: [] }),
        conversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        messages: vi.fn().mockResolvedValue({
          items: [
            {
              id: 'm1',
              role: 'user',
              content: 'Draft a post',
              provider: null,
              model: null,
              notice: null,
              sources: [],
              toolCalls: [],
              safety: { refused: false, category: null, output: 'ok', injectionDetected: false },
              memorySuggestions: [],
              createdAt: new Date().toISOString(),
            },
            {
              id: 'm2',
              role: 'assistant',
              content: 'Here is a draft post.',
              provider: 'dev',
              model: null,
              notice: null,
              sources: [],
              toolCalls: [{ tool: 'draft_post', outcome: 'allowed', artifactId: 'a1' }],
              safety: { refused: false, category: null, output: 'ok', injectionDetected: false },
              memorySuggestions: [],
              createdAt: new Date().toISOString(),
            },
          ],
        }),
        artifact: getArtifact,
      },
    });

    renderWithProviders(<ChatView conversationId="c1" />, { client });

    await waitFor(() => expect(screen.getByTestId('ai-artifact')).toBeInTheDocument());
    expect(screen.getByText('A drafted post')).toBeInTheDocument();
    expect(getArtifact).toHaveBeenCalledWith('a1');
  });
});
