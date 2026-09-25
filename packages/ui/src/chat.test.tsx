import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import {
  ChatComposer,
  ConversationRow,
  MessageList,
  UIProvider,
  type ChatComposerLabels,
  type ChatItem,
  type ChatMessageData,
  type ConversationRowLabels,
  type MessageBubbleLabels,
  type MessageListLabels,
} from './index';

const bubbleLabels: MessageBubbleLabels = {
  you: 'You',
  deleted: 'This message was deleted',
  reply: 'Reply',
  react: 'React',
  options: 'Message options',
  delete: 'Delete message',
  edited: 'edited',
  sending: 'Sending',
  failed: 'Not sent',
  retry: 'Retry',
  discard: 'Discard',
  reactionCount: (k, n) => `${k}, ${n}`,
  reactions: {
    like: 'Like',
    love: 'Love',
    laugh: 'Laugh',
    wow: 'Wow',
    sad: 'Sad',
    insightful: 'Insightful',
  },
  replyingTo: (n) => `Replying to ${n}`,
  originalDeleted: 'Original message deleted',
  sentAt: (n, w) => `${n}, ${w}`,
};
const listLabels: MessageListLabels = {
  log: 'Messages',
  empty: 'No messages yet',
  loadOlder: 'Load older messages',
  loadingOlder: 'Loading',
  newMessages: 'New messages',
  today: 'Today',
  yesterday: 'Yesterday',
};
const composerLabels: ChatComposerLabels = {
  label: 'Message',
  placeholder: 'Write a message',
  send: 'Send',
  hint: 'Enter to send',
  replyingTo: (n) => `Replying to ${n}`,
  cancelReply: 'Cancel reply',
  tooLong: 'Too long',
};
const rowLabels: ConversationRowLabels = {
  unread: (n) => `${n} unread`,
  muted: 'Muted',
  pinned: 'Pinned',
  noMessages: 'No messages yet',
};

const ada = { id: 'u1', username: 'ada', displayName: 'Ada', avatarUrl: null };
const bob = { id: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null };
const msg = (id: string, over: Partial<ChatMessageData> = {}): ChatItem => ({
  status: 'sent',
  message: {
    id,
    senderId: 'u2',
    sender: bob,
    kind: 'text',
    body: `body ${id}`,
    deleted: false,
    replyTo: null,
    reactions: { counts: {}, mine: null },
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...over,
  },
});

async function a11y(el: HTMLElement) {
  const r = await axe.run(el, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

describe('MessageList', () => {
  it('is a labelled log, marks own messages and shows sender names in groups', () => {
    render(
      <MessageList
        items={[msg('a'), msg('b', { senderId: 'u1', sender: ada })]}
        viewerId="u1"
        showSenders
        labels={listLabels}
        bubbleLabels={bubbleLabels}
      />,
    );
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(within(log).getByText('body a')).toBeInTheDocument();
    expect(within(log).getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '/u/bob');
    expect(within(log).getByText('Today')).toBeInTheDocument();
  });

  it('shows the empty state and hides tools on deleted messages', () => {
    const { rerender } = render(
      <MessageList
        items={[]}
        viewerId="u1"
        showSenders={false}
        labels={listLabels}
        bubbleLabels={bubbleLabels}
      />,
    );
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    rerender(
      <MessageList
        items={[msg('a', { deleted: true, body: '' })]}
        viewerId="u1"
        showSenders={false}
        labels={listLabels}
        bubbleLabels={bubbleLabels}
        onReply={vi.fn()}
      />,
    );
    expect(screen.getByText('This message was deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('reacts, replies and only offers delete on own messages', async () => {
    const onReact = vi.fn();
    const onReply = vi.fn();
    const onDelete = vi.fn();
    const items = [msg('a'), msg('b', { senderId: 'u1', sender: ada })];
    render(
      <MessageList
        items={items}
        viewerId="u1"
        showSenders={false}
        labels={listLabels}
        bubbleLabels={bubbleLabels}
        onReact={onReact}
        onReply={onReply}
        onDelete={onDelete}
      />,
    );
    const u = userEvent.setup();
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(1);
    await u.click(screen.getAllByRole('button', { name: 'Reply' })[0]!);
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    await u.click(screen.getAllByRole('button', { name: 'React' })[0]!);
    await u.click(screen.getByRole('menuitemradio', { name: 'Love' }));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'love');
    await u.click(screen.getByRole('button', { name: 'Message options' }));
    await u.click(screen.getByRole('menuitem', { name: 'Delete message' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('reaction chips are toggle buttons that remove your own reaction', async () => {
    const onReact = vi.fn();
    render(
      <MessageList
        items={[msg('a', { reactions: { counts: { love: 2 }, mine: 'love' } })]}
        viewerId="u1"
        showSenders={false}
        labels={listLabels}
        bubbleLabels={bubbleLabels}
        onReact={onReact}
      />,
    );
    const chip = screen.getByRole('button', { name: 'Love, 2' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.setup().click(chip);
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), null);
  });

  it('shows a quote for replies and a retry for failed sends', async () => {
    const onRetry = vi.fn();
    const failed: ChatItem = {
      ...msg('c', {
        senderId: 'u1',
        sender: ada,
        replyTo: { id: 'a', senderId: 'u2', body: 'quoted text', deleted: false },
      }),
      status: 'failed',
    };
    render(
      <MessageList
        items={[failed]}
        viewerId="u1"
        showSenders={false}
        labels={listLabels}
        bubbleLabels={bubbleLabels}
        nameOf={() => 'Bob'}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('quoted text')).toBeInTheDocument();
    expect(screen.getByText('Replying to Bob')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('offers to load older messages', async () => {
    const onLoadOlder = vi.fn();
    render(
      <MessageList
        items={[msg('a')]}
        viewerId="u1"
        showSenders={false}
        labels={listLabels}
        bubbleLabels={bubbleLabels}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <MessageList
        items={[
          msg('a', { reactions: { counts: { like: 1 }, mine: null } }),
          msg('b', { senderId: 'u1', sender: ada }),
        ]}
        viewerId="u1"
        showSenders
        labels={listLabels}
        bubbleLabels={bubbleLabels}
        onReact={vi.fn()}
        onReply={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(await a11y(container)).toEqual([]);
  });
});

describe('ChatComposer', () => {
  it('sends on Enter, keeps Shift+Enter for a newline, and clears', async () => {
    const onSend = vi.fn();
    const onTyping = vi.fn();
    render(<ChatComposer labels={composerLabels} onSend={onSend} onTyping={onTyping} />);
    const u = userEvent.setup();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await u.type(box, 'hi{Shift>}{Enter}{/Shift}there');
    expect(onSend).not.toHaveBeenCalled();
    expect(onTyping).toHaveBeenCalledWith(true);
    await u.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('hi\nthere');
    expect(box).toHaveValue('');
    expect(onTyping).toHaveBeenLastCalledWith(false);
  });

  it('disables Send when empty, shows and cancels a reply, or explains when blocked', async () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ChatComposer
        labels={composerLabels}
        onSend={vi.fn()}
        replyTo={{ name: 'Bob', body: 'hello' }}
        onCancelReply={onCancel}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('Replying to Bob')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(onCancel).toHaveBeenCalled();
    rerender(
      <ChatComposer
        labels={composerLabels}
        onSend={vi.fn()}
        disabledReason="Only admins can post"
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('Only admins can post');
  });

  it('rejects over-long messages without sending', async () => {
    const onSend = vi.fn();
    render(<ChatComposer labels={composerLabels} onSend={onSend} maxLength={5} />);
    const u = userEvent.setup();
    await u.type(screen.getByRole('textbox'), 'abcdefgh{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Too long');
  });
});

describe('ConversationRow', () => {
  it('links to the chat, announces unread counts and truncates via CSS only', async () => {
    const { container } = render(
      <UIProvider locale="en">
        <ConversationRow
          title="Ada"
          avatarName="Ada"
          href="/inbox/c1"
          preview="see you"
          previewPrefix="You"
          time={new Date().toISOString()}
          unread={3}
          muted
          pinned={false}
          labels={rowLabels}
        />
      </UIProvider>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/inbox/c1');
    expect(link).toHaveTextContent('You: see you');
    expect(link).toHaveTextContent('3 unread');
    expect(link).toHaveTextContent('Muted');
    expect(await a11y(container)).toEqual([]);
  });
});
