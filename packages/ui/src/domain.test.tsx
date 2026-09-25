import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommentThread,
  Composer,
  FeedTabs,
  PollView,
  PostCard,
  ProfileHeader,
  UIProvider,
  formatCompact,
  formatCurrency,
  formatRelativeTime,
  formatNumber,
  formatDate,
  type CommentNode,
  type ComposerValue,
} from './index';
import {
  commentLabels,
  composerLabels,
  makeComment,
  makePost,
  pollLabels,
  postLabels,
  profileLabels,
} from './test-utils';

const user = () => userEvent.setup();
async function a11y(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

describe('PostCard', () => {
  it('renders author, relative time, visibility and safe links', () => {
    const { container } = render(
      <PostCard post={makePost()} labels={postLabels} href="/post/p1" />,
    );
    const article = screen.getByRole('article');
    expect(article).toHaveAccessibleName('Ada Lovelace');
    expect(screen.getByText('@ada')).toBeInTheDocument();
    expect(screen.getByText('Public')).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime');
    const link = screen.getByRole('link', { name: 'https://example.com/x' });
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('never renders post text as HTML', () => {
    const { container } = render(
      <PostCard
        post={makePost({ body: '<img src=x onerror=alert(1)> <script>alert(1)</script>' })}
        labels={postLabels}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });

  it('ignores javascript: and other non-http schemes when linkifying', () => {
    const { container } = render(
      <PostCard
        post={makePost({ body: 'see javascript:alert(1) and ftp://x.y' })}
        labels={postLabels}
      />,
    );
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('like button exposes aria-pressed and toggles via onReact', async () => {
    const onReact = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <PostCard post={makePost()} labels={postLabels} onReact={onReact} />,
    );
    const like = screen.getByTestId('like-button');
    expect(like).toHaveAttribute('aria-pressed', 'false');
    expect(like).toHaveAccessibleName('Like, 3 likes');
    await user().click(like);
    expect(onReact).toHaveBeenLastCalledWith('like');
    rerender(
      <PostCard
        post={makePost({
          viewer: { reaction: 'like', saved: false, isAuthor: false },
          counts: { likes: 4, comments: 2, shares: 0, saves: 0 },
        })}
        labels={postLabels}
        onReact={onReact}
      />,
    );
    expect(screen.getByTestId('like-button')).toHaveAttribute('aria-pressed', 'true');
    await user().click(screen.getByTestId('like-button'));
    expect(onReact).toHaveBeenLastCalledWith(null);
  });

  it('offers other reactions through a menu', async () => {
    const onReact = vi.fn();
    render(<PostCard post={makePost()} labels={postLabels} onReact={onReact} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Choose a reaction' }));
    await u.click(screen.getByRole('menuitemradio', { name: /Love/ }));
    expect(onReact).toHaveBeenCalledWith('love');
  });

  it('save toggles', async () => {
    const onSave = vi.fn();
    render(<PostCard post={makePost()} labels={postLabels} onSave={onSave} />);
    await user().click(screen.getByTestId('save-button'));
    expect(onSave).toHaveBeenCalledWith(true);
  });

  it('share is only actionable for public posts', async () => {
    const onShare = vi.fn();
    const { rerender } = render(
      <PostCard post={makePost({ visibility: 'friends' })} labels={postLabels} onShare={onShare} />,
    );
    const share = screen.getByTestId('share-button');
    expect(share).toHaveAttribute('aria-disabled', 'true');
    expect(share).toHaveAccessibleName(/Only public posts can be shared/);
    await user().click(share);
    expect(onShare).not.toHaveBeenCalled();
    rerender(
      <PostCard post={makePost({ visibility: 'public' })} labels={postLabels} onShare={onShare} />,
    );
    await user().click(screen.getByTestId('share-button'));
    expect(onShare).toHaveBeenCalled();
  });

  it('feedback menu sends typed actions including topic mute', async () => {
    const onFeedback = vi.fn();
    render(<PostCard post={makePost()} labels={postLabels} onFeedback={onFeedback} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Post options' }));
    await u.click(screen.getByRole('menuitem', { name: 'Less like this' }));
    expect(onFeedback).toHaveBeenLastCalledWith({ type: 'less_like_this' });
    await u.click(screen.getByRole('button', { name: 'Post options' }));
    await u.click(screen.getByRole('menuitem', { name: 'Mute topic Music' }));
    expect(onFeedback).toHaveBeenLastCalledWith({ type: 'mute_topic', topic: 'Music' });
    await u.click(screen.getByRole('button', { name: 'Post options' }));
    await u.click(screen.getByRole('menuitem', { name: 'Mute @ada' }));
    expect(onFeedback).toHaveBeenLastCalledWith({ type: 'mute_creator' });
  });

  it('hides feedback controls on your own posts', () => {
    render(
      <PostCard
        post={makePost({ viewer: { reaction: null, saved: false, isAuthor: true } })}
        labels={postLabels}
        onFeedback={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Post options' })).toBeNull();
  });

  it('"Why am I seeing this?" fetches reasons when opened and sends feedback', async () => {
    const load = vi.fn().mockResolvedValue(['You follow @ada', 'Popular right now']);
    const onFeedback = vi.fn();
    render(
      <PostCard post={makePost()} labels={postLabels} loadReasons={load} onFeedback={onFeedback} />,
    );
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Why am I seeing this?' }));
    expect(await screen.findByText('You follow @ada')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    await u.click(screen.getByRole('button', { name: 'More like this' }));
    expect(onFeedback).toHaveBeenCalledWith({ type: 'more_like_this' });
    expect(await screen.findByText('Thanks, noted')).toBeInTheDocument();
  });

  it('shows an error and lets the user retry when reasons fail to load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(['Recent']);
    render(<PostCard post={makePost()} labels={postLabels} loadReasons={load} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Why am I seeing this?' }));
    expect(await screen.findByText(/Could not load/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recent')).toBeInTheDocument();
  });

  it('hides media behind a tap in low-bandwidth mode', async () => {
    document.documentElement.setAttribute('data-bandwidth', 'low');
    const media = [
      {
        id: 'm1',
        kind: 'image',
        url: 'https://cdn.example/a.jpg',
        altText: 'A cat',
        width: 1,
        height: 1,
        status: 'ready',
      },
    ];
    const { container } = render(<PostCard post={makePost({ media })} labels={postLabels} />);
    expect(container.querySelector('img[src*="cdn.example"]')).toBeNull();
    await user().click(screen.getByRole('button', { name: 'Load' }));
    expect(container.querySelector('img[src*="cdn.example"]')).toHaveAttribute('alt', 'A cat');
    document.documentElement.removeAttribute('data-bandwidth');
  });

  it('formats counts and time by locale', () => {
    render(
      <UIProvider locale="fr">
        <PostCard
          post={makePost({ counts: { likes: 1200, comments: 0, shares: 0, saves: 0 } })}
          labels={postLabels}
          now={Date.now()}
        />
      </UIProvider>,
    );
    expect(screen.getByText(/il y a 3 h|il y a 3 heures/)).toBeInTheDocument();
    expect(screen.getByText(/1,2\s?k/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <PostCard
        post={makePost({ topics: ['Music', 'Food'], link: { url: 'https://example.com' } })}
        labels={postLabels}
        href="/post/p1"
        onReact={() => undefined}
        onSave={() => undefined}
        onFeedback={() => undefined}
        loadReasons={async () => []}
      />,
    );
    expect(await a11y(container)).toEqual([]);
  });
});

describe('PollView', () => {
  const poll = {
    question: 'Best fruit?',
    multiple: false,
    closesAt: null,
    options: [
      { id: 'o1', label: 'Mango', votes: 3 },
      { id: 'o2', label: 'Plantain', votes: 1 },
    ],
    myVotes: [],
    totalVotes: 4,
  };

  it('requires a choice, then submits the chosen option', async () => {
    const onVote = vi.fn().mockResolvedValue(undefined);
    render(<PollView poll={poll} labels={pollLabels} onVote={onVote} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Vote' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one option');
    await u.click(screen.getByRole('radio', { name: 'Plantain' }));
    await u.click(screen.getByRole('button', { name: 'Vote' }));
    expect(onVote).toHaveBeenCalledWith(['o2']);
  });

  it('multi-choice polls use checkboxes', async () => {
    const onVote = vi.fn().mockResolvedValue(undefined);
    render(<PollView poll={{ ...poll, multiple: true }} labels={pollLabels} onVote={onVote} />);
    const u = user();
    await u.click(screen.getByRole('checkbox', { name: 'Mango' }));
    await u.click(screen.getByRole('checkbox', { name: 'Plantain' }));
    await u.click(screen.getByRole('button', { name: 'Vote' }));
    expect(onVote).toHaveBeenCalledWith(['o1', 'o2']);
  });

  it('shows results with percentages after voting, marking your vote', () => {
    render(
      <PollView
        poll={{ ...poll, myVotes: ['o1'] }}
        labels={pollLabels}
        onVote={async () => undefined}
      />,
    );
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Your vote')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
    expect(screen.getByText('4 votes')).toBeInTheDocument();
  });

  it('shows results, not the form, for closed polls', () => {
    render(
      <PollView
        poll={{ ...poll, closesAt: new Date(Date.now() - 1000).toISOString() }}
        labels={pollLabels}
        onVote={async () => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });
});

describe('CommentThread', () => {
  const base = (over: Partial<Parameters<typeof CommentThread>[0]> = {}) => ({
    comments: [] as CommentNode[],
    labels: commentLabels,
    onSubmit: async () => undefined,
    onLoadReplies: () => undefined,
    onReact: () => undefined,
    ...over,
  });

  it('shows the empty state and submits a new comment', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommentThread {...base({ onSubmit })} />);
    expect(screen.getByText('No comments yet')).toBeInTheDocument();
    const u = user();
    const submit = screen.getByRole('button', { name: 'Comment' });
    expect(submit).toBeDisabled();
    await u.type(screen.getByRole('textbox', { name: 'Write a comment' }), 'First!');
    await u.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('First!', undefined);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue(''),
    );
  });

  it('shows submit errors from the server and keeps the text', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Too fast'));
    render(<CommentThread {...base({ onSubmit })} />);
    const u = user();
    await u.type(screen.getByRole('textbox', { name: 'Write a comment' }), 'Hello');
    await u.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Too fast')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Hello');
  });

  it('replies to a comment with its id and lazily loads replies', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onLoadReplies = vi.fn();
    const comments: CommentNode[] = [{ ...makeComment({ counts: { likes: 0, replies: 2 } }) }];
    render(<CommentThread {...base({ comments, onSubmit, onLoadReplies })} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Show 2 replies' }));
    expect(onLoadReplies).toHaveBeenCalledWith('c1');
    await u.click(screen.getByRole('button', { name: 'Reply' }));
    await u.type(screen.getByRole('textbox', { name: 'Reply to Grace Hopper' }), 'Agreed');
    await u.click(
      within(
        screen.getByRole('textbox', { name: 'Reply to Grace Hopper' }).closest('form')!,
      ).getByRole('button', { name: 'Comment' }),
    );
    expect(onSubmit).toHaveBeenCalledWith('Agreed', 'c1');
  });

  it('renders loaded replies, like toggles, and delete only for owners/moderators', async () => {
    const onReact = vi.fn();
    const onDelete = vi.fn();
    const reply = makeComment({
      id: 'r1',
      parentId: 'c1',
      body: 'A reply',
      viewer: { reaction: null, isAuthor: true },
    });
    const comments: CommentNode[] = [
      { ...makeComment({ counts: { likes: 2, replies: 1 } }), replies: [reply] },
    ];
    render(<CommentThread {...base({ comments, onReact, onDelete })} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Show 1 replies' }));
    expect(screen.getByText('A reply')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Delete comment/ })).toHaveLength(1);
    await u.click(screen.getAllByRole('button', { name: /^Like, 2 likes/ })[0]!);
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), true);
  });

  it('has no axe violations', async () => {
    const { container } = render(<CommentThread {...base({ comments: [makeComment()] })} />);
    expect(await a11y(container)).toEqual([]);
  });
});

describe('ProfileHeader', () => {
  const profile = {
    username: 'ada',
    displayName: 'Ada Lovelace',
    bio: 'Poet of maths',
    avatarUrl: null,
    coverUrl: null,
    mode: 'creator',
    links: [{ label: 'site', url: 'https://ada.example' }],
    locationText: 'London',
    isPrivate: true,
    counts: { followers: 1500, following: 12, friends: 3 },
    joinedAt: '2024-05-01T00:00:00Z',
    contentHidden: true,
  };
  it('shows identity, badges, facts and formatted counts', () => {
    render(
      <ProfileHeader
        profile={profile}
        labels={profileLabels}
        actions={<button>Follow</button>}
        onShowFollowers={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('Private account')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1.5K followers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute(
      'rel',
      expect.stringContaining('noopener'),
    );
    expect(screen.getByText('This account is private')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow' })).toBeInTheDocument();
  });
  it('has no axe violations', async () => {
    const { container } = render(<ProfileHeader profile={profile} labels={profileLabels} />);
    expect(await a11y(container)).toEqual([]);
  });
});

describe('FeedTabs', () => {
  const Demo = ({ onChange = () => undefined }: { onChange?: (v: string) => void }) => {
    const [v, setV] = useState('for_you');
    return (
      <FeedTabs
        label="Feeds"
        value={v}
        onChange={(x) => {
          setV(x);
          onChange(x);
        }}
        tabs={[
          { id: 'for_you', label: 'For You' },
          { id: 'following', label: 'Following' },
          { id: 'local', label: 'Local' },
        ]}
      >
        <p>content for {v}</p>
      </FeedTabs>
    );
  };
  it('is a tablist with one shared labelled panel and keyboard navigation', async () => {
    const onChange = vi.fn();
    const { container } = render(<Demo onChange={onChange} />);
    expect(screen.getByRole('tablist', { name: 'Feeds' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('For You');
    screen.getByRole('tab', { name: 'For You' }).focus();
    await user().keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('following');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Following');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('content for following');
    expect(await a11y(container)).toEqual([]);
  });
});

describe('Composer', () => {
  const topics = [
    { slug: 'music', name: 'Music' },
    { slug: 'food', name: 'Food' },
  ];
  const circles = [{ id: 'c1', name: 'Family', memberCount: 4 }];
  const setup = (over: Partial<Parameters<typeof Composer>[0]> = {}) => {
    const onSubmit = vi.fn<(v: ComposerValue) => Promise<void>>().mockResolvedValue(undefined);
    const utils = render(
      <Composer
        labels={composerLabels}
        topics={topics}
        circles={circles}
        isTeen={false}
        onSubmit={onSubmit}
        onLookupUser={async (n) =>
          n === 'sam' ? { id: 'u9', username: 'sam', displayName: 'Sam', avatarUrl: null } : null
        }
        {...over}
      />,
    );
    return { onSubmit, ...utils };
  };

  it('validates: needs text or a poll', async () => {
    const { onSubmit } = setup();
    await user().click(screen.getByRole('button', { name: 'Post' }));
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain(
      'Write something or add a poll',
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'What is on your mind?' })).toHaveFocus();
  });

  it('submits text with the chosen visibility and topics', async () => {
    const { onSubmit } = setup({ defaultVisibility: 'public' });
    const u = user();
    await u.type(screen.getByRole('textbox', { name: 'What is on your mind?' }), 'Hello world');
    await u.click(screen.getByRole('radio', { name: /Friends/ }));
    await u.click(screen.getByRole('checkbox', { name: 'Music' }));
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(onSubmit).toHaveBeenCalledWith({
      body: 'Hello world',
      visibility: 'friends',
      topics: ['music'],
    });
  });

  it('explains each audience option in the option itself', () => {
    setup();
    expect(screen.getByRole('radio', { name: 'Public' })).toHaveAccessibleDescription(
      'Anyone can see it',
    );
    expect(screen.getByRole('radio', { name: 'Only me' })).toHaveAccessibleDescription('Just you');
  });

  it('teens cannot pick public and are told why; default falls back to followers', () => {
    setup({ isTeen: true, defaultVisibility: 'public' });
    const pub = screen.getByRole('radio', { name: 'Public' });
    expect(pub).toBeDisabled();
    expect(pub).toHaveAccessibleDescription('Not available for accounts under 18');
    expect(screen.getByRole('radio', { name: 'Followers' })).toBeChecked();
    expect(screen.getByRole('note')).toHaveTextContent('private by default');
  });

  it('circle audience needs a circle; selected audience needs people (looked up for real)', async () => {
    const { onSubmit } = setup();
    const u = user();
    await u.type(screen.getByRole('textbox', { name: 'What is on your mind?' }), 'Hi');
    await u.click(screen.getByRole('radio', { name: /A circle/ }));
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('Choose a circle');
    await u.selectOptions(screen.getByRole('combobox', { name: 'Circle' }), 'c1');
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ body: 'Hi', visibility: 'circle', circleId: 'c1' });

    await u.click(screen.getByRole('radio', { name: /Selected people/ }));
    await u.type(screen.getByTestId('audience-input'), 'nobody');
    await u.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('No such person')).toBeInTheDocument();
    await u.clear(screen.getByTestId('audience-input'));
    await u.type(screen.getByTestId('audience-input'), '@sam{Enter}');
    expect(await screen.findByText('@sam')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      body: 'Hi',
      visibility: 'selected',
      audience: ['u9'],
    });
  });

  it('poll builder validates and submits question, options and settings', async () => {
    const { onSubmit } = setup();
    const u = user();
    await u.click(screen.getByRole('switch', { name: 'Add a poll' }));
    await u.click(screen.getByRole('button', { name: 'Post' }));
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toContain('Ask a question');
    expect(alerts).toContain('Add at least two options');
    await u.type(screen.getByTestId('poll-question'), 'Tea or coffee?');
    await u.type(screen.getByTestId('poll-option-0'), 'Tea');
    await u.type(screen.getByTestId('poll-option-1'), 'Coffee');
    await u.click(screen.getByRole('button', { name: 'Add option' }));
    await u.type(screen.getByTestId('poll-option-2'), 'Water');
    await u.click(screen.getByRole('button', { name: 'Remove option 3' }));
    await u.click(screen.getByRole('checkbox', { name: 'Allow several answers' }));
    await u.selectOptions(screen.getByRole('combobox', { name: 'Poll length' }), '24');
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(onSubmit).toHaveBeenCalledWith({
      body: '',
      visibility: 'followers',
      poll: {
        question: 'Tea or coffee?',
        options: ['Tea', 'Coffee'],
        multiple: true,
        closesInHours: 24,
      },
    });
  });

  it('validates links: only http(s)', async () => {
    const { onSubmit } = setup();
    const u = user();
    await u.type(screen.getByRole('textbox', { name: 'What is on your mind?' }), 'Look');
    await u.type(screen.getByRole('textbox', { name: /Link/ }), 'javascript:alert(1)');
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('Enter a valid link');
    expect(onSubmit).not.toHaveBeenCalled();
    await u.clear(screen.getByRole('textbox', { name: /Link/ }));
    await u.type(screen.getByRole('textbox', { name: /Link/ }), 'https://example.com/a');
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ linkUrl: 'https://example.com/a' }),
    );
  });

  it('location is opt-in, asks the browser only when toggled, and is blocked for teens', async () => {
    const onRequestLocation = vi.fn().mockResolvedValue({ latitude: 6.5, longitude: 3.4 });
    const { onSubmit } = setup({ onRequestLocation });
    expect(onRequestLocation).not.toHaveBeenCalled();
    const u = user();
    await u.type(screen.getByRole('textbox', { name: 'What is on your mind?' }), 'Lagos');
    await u.click(screen.getByRole('switch', { name: /approximate location/ }));
    expect(onRequestLocation).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Location added')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 6.5, longitude: 3.4 }),
    );
  });

  it('a denied location request leaves the toggle off with an explanation', async () => {
    setup({ onRequestLocation: async () => null });
    await user().click(screen.getByRole('switch', { name: /approximate location/ }));
    expect(await screen.findByText('Location not shared')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /approximate location/ })).not.toBeChecked();
  });

  it('teens cannot enable location', () => {
    setup({ isTeen: true, onRequestLocation: async () => ({ latitude: 1, longitude: 1 }) });
    expect(screen.getByRole('switch', { name: /approximate location/ })).toBeDisabled();
  });

  it('shows server errors from submit', async () => {
    const { onSubmit } = setup();
    onSubmit.mockRejectedValueOnce(new Error('Rate limited'));
    const u = user();
    await u.type(screen.getByRole('textbox', { name: 'What is on your mind?' }), 'Hi');
    await u.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('Rate limited')).toBeInTheDocument();
  });

  it('has no axe violations (with poll and selected audience open)', async () => {
    const { container } = setup();
    const u = user();
    await u.click(screen.getByRole('switch', { name: 'Add a poll' }));
    await u.click(screen.getByRole('radio', { name: /Selected people/ }));
    expect(await a11y(container)).toEqual([]);
  });

  const mediaLabels = {
    ...composerLabels,
    media: {
      attach: 'Add photo or video',
      uploading: 'Uploading…',
      remove: (n: number) => `Remove attachment ${n}`,
      altTextLabel: 'Describe this image',
      altTextPlaceholder: 'Describe this image for people using a screen reader',
      failed: 'Upload failed',
      retry: 'Try again',
    },
  };

  it('allows an empty body when a ready attachment is present, and submits its id', async () => {
    const onAddMedia = vi.fn();
    const { onSubmit, rerender } = setup({
      labels: mediaLabels,
      media: [],
      onAddMedia,
      onRemoveMedia: vi.fn(),
    });
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    await user().upload(screen.getByTestId('composer-media-input'), file);
    expect(onAddMedia).toHaveBeenCalledTimes(1);

    rerender(
      <Composer
        labels={mediaLabels}
        topics={topics}
        circles={circles}
        isTeen={false}
        onSubmit={onSubmit}
        onLookupUser={async () => null}
        media={[{ id: 'm1', url: 'https://example.test/m1.png', kind: 'image', status: 'ready' }]}
        onAddMedia={onAddMedia}
        onRemoveMedia={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    await user().click(screen.getByRole('button', { name: 'Post' }));
    expect(onSubmit).toHaveBeenCalledWith({ body: '', visibility: 'followers', mediaIds: ['m1'] });
  });

  it('shows an uploading placeholder and a remove button per attachment', () => {
    const onRemoveMedia = vi.fn();
    setup({
      labels: mediaLabels,
      onAddMedia: vi.fn(),
      onRemoveMedia,
      media: [
        { id: 'm1', url: null, kind: 'image', status: 'uploading' },
        { id: 'm2', url: null, kind: 'image', status: 'failed', error: 'Too large' },
      ],
    });
    expect(screen.getByText('Uploading…')).toBeInTheDocument();
    expect(screen.getByText('Too large')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove attachment 1' })).toBeInTheDocument();
  });
});

describe('format', () => {
  it('formats numbers, compact counts, currency and dates per locale', () => {
    expect(formatNumber(1234567.5, 'en')).toBe('1,234,567.5');
    expect(formatNumber(1234567.5, 'de')).toBe('1.234.567,5');
    expect(formatCompact(1500, 'en')).toBe('1.5K');
    expect(formatCurrency(1234.5, 'NGN', 'en')).toMatch(/NGN|₦/);
    expect(formatCurrency(1234.5, 'EUR', 'fr')).toMatch(/1\s?234,50\s?€/);
    expect(formatDate('2025-03-04T12:00:00Z', 'en', { dateStyle: 'long' }, 'UTC')).toBe(
      'March 4, 2025',
    );
    expect(formatDate('2025-03-04T12:00:00Z', 'fr', { dateStyle: 'long' }, 'UTC')).toBe(
      '4 mars 2025',
    );
  });
  it('formats relative time in several scripts', () => {
    const now = Date.parse('2025-01-10T12:00:00Z');
    expect(formatRelativeTime(now - 10_000, 'en', now)).toMatch(/now/i);
    expect(formatRelativeTime(now - 3 * 3_600_000, 'en', now)).toBe('3 hr. ago');
    expect(formatRelativeTime(now - 2 * 86_400_000, 'en', now)).toBe('2 days ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, 'ar', now)).toContain('قبل');
  });
  it('falls back for unknown locales without throwing', () => {
    expect(formatNumber(1000, 'xx-invalid-locale!!')).toBe('1,000');
  });
});
