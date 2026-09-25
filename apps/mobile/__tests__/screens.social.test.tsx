import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import PostDetail from '../src/app/post/[id]';
import UserProfile from '../src/app/user/[username]';
import { makeFetch, makePost, renderApp, router, setParams } from './support/harness';

const comment = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  postId: 'post-1',
  parentId: null,
  body: 'Lovely photo',
  author: { id: 'u3', username: 'chi', displayName: 'Chi', avatarUrl: null },
  counts: { likes: 0, replies: 0 },
  viewer: { reaction: null, isAuthor: false },
  pendingApproval: false,
  moderationStatus: 'ok',
  editedAt: null,
  createdAt: '2026-01-02T00:00:00Z',
  ...over,
});

describe('Post detail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setParams({ id: 'post-1' });
  });

  it('shows the post and its comments', async () => {
    const fetch = makeFetch({
      'GET /v1/posts/post-1': { json: makePost() },
      'GET /v1/posts/post-1/comments': { json: { items: [comment()], nextCursor: null } },
    });
    await renderApp(<PostDetail />, { fetch });
    expect(await screen.findByText('Hello from Lagos')).toBeTruthy();
    expect(await screen.findByText('Lovely photo')).toBeTruthy();
  });

  it('shows the empty comments state and a not-found message for a missing post', async () => {
    await renderApp(<PostDetail />, {
      fetch: makeFetch({
        'GET /v1/posts/post-1': { json: makePost() },
        'GET /v1/posts/post-1/comments': { json: { items: [], nextCursor: null } },
      }),
    });
    expect(await screen.findByText('No comments yet. Start the conversation.')).toBeTruthy();
    screen.unmount();
    setParams({ id: 'gone' });
    await renderApp(<PostDetail />, {
      fetch: makeFetch({
        'GET /v1/posts/gone': {
          status: 404,
          json: { error: { code: 'not_found', message: 'nope' } },
        },
      }),
    });
    expect(await screen.findByText(/not available|no longer/i)).toBeTruthy();
  });

  it('posts a comment, clears the box and refreshes the list', async () => {
    let posted = false;
    const fetch = makeFetch({
      'GET /v1/posts/post-1': { json: makePost() },
      'GET /v1/posts/post-1/comments': () => ({
        json: { items: posted ? [comment({ id: 'c2', body: 'Nice one' })] : [], nextCursor: null },
      }),
      'POST /v1/posts/post-1/comments': ({ body }) => {
        posted = true;
        return { status: 201, json: comment({ id: 'c2', body: (body as { body: string }).body }) };
      },
    });
    await renderApp(<PostDetail />, { fetch });
    const send = await screen.findByRole('button', { name: 'Post comment' });
    expect(send.props.accessibilityState.disabled).toBe(true); // nothing to send yet
    fireEvent.changeText(screen.getByLabelText('Add a comment'), '  Nice one ');
    fireEvent.press(screen.getByRole('button', { name: 'Post comment' }));
    expect(await screen.findByText('Nice one')).toBeTruthy();
    expect(fetch.calls.find((c) => c.method === 'POST')!.body).toEqual({ body: 'Nice one' });
    expect(screen.getByLabelText('Add a comment').props.value).toBe('');
  });

  it('replies to a comment with its parentId', async () => {
    const fetch = makeFetch({
      'GET /v1/posts/post-1': { json: makePost() },
      'GET /v1/posts/post-1/comments': { json: { items: [comment()], nextCursor: null } },
      'POST /v1/posts/post-1/comments': {
        status: 201,
        json: comment({ id: 'c9', parentId: 'c1' }),
      },
    });
    await renderApp(<PostDetail />, { fetch });
    fireEvent.press(await screen.findByRole('button', { name: 'Reply Chi' }));
    expect(screen.getByText('Replying to Chi')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Add a comment'), 'Thanks!');
    fireEvent.press(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'POST')!.body).toEqual({
      body: 'Thanks!',
      parentId: 'c1',
    });
  });

  it('keeps the draft and tells the user when posting fails', async () => {
    const fetch = makeFetch({
      'GET /v1/posts/post-1': { json: makePost() },
      'GET /v1/posts/post-1/comments': { json: { items: [], nextCursor: null } },
      'POST /v1/posts/post-1/comments': () => {
        throw new TypeError('Network request failed');
      },
    });
    await renderApp(<PostDetail />, { fetch });
    fireEvent.changeText(await screen.findByLabelText('Add a comment'), 'Will not go');
    fireEvent.press(screen.getByRole('button', { name: 'Post comment' }));
    expect(await screen.findByText('Your comment was not posted.')).toBeTruthy();
    expect(screen.getByLabelText('Add a comment').props.value).toBe('Will not go');
  });
});

const profile = (over: Record<string, unknown> = {}, viewer: Record<string, unknown> = {}) => ({
  id: 'u-2',
  username: 'bola',
  displayName: 'Bola A',
  bio: 'Photographer',
  avatarUrl: null,
  coverUrl: null,
  mode: 'personal',
  links: [],
  locationText: null,
  isPrivate: false,
  counts: { followers: 10, following: 5, friends: 2 },
  joinedAt: '2025-06-01T00:00:00Z',
  contentHidden: false,
  viewer: {
    isSelf: false,
    following: 'none',
    followedBy: false,
    friendship: 'none',
    muted: false,
    restricted: false,
    ...viewer,
  },
  ...over,
});

describe('Profile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setParams({ username: 'bola' });
  });

  it('shows another person, their posts and the relationship buttons', async () => {
    const fetch = makeFetch({
      'GET /v1/users/bola': { json: profile() },
      'GET /v1/users/bola/posts': {
        json: { items: [makePost({ body: 'Their post' })], nextCursor: null },
      },
    });
    await renderApp(<UserProfile />, { fetch });
    expect(await screen.findByRole('header', { name: 'Bola A' })).toBeTruthy();
    expect(screen.getByText('Photographer')).toBeTruthy();
    expect(await screen.findByText('Their post')).toBeTruthy();
    for (const n of ['Follow', 'Add friend', 'Message'])
      expect(screen.getByRole('button', { name: n })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  });

  it('follows optimistically and unfollows', async () => {
    let following = false;
    const fetch = makeFetch({
      'GET /v1/users/bola': () => ({
        json: profile({}, { following: following ? 'active' : 'none' }),
      }),
      'GET /v1/users/bola/posts': { json: { items: [], nextCursor: null } },
      'PUT /v1/users/bola/follow': () => {
        following = true;
        return { json: { status: 'active' } };
      },
      'DELETE /v1/users/bola/follow': () => {
        following = false;
        return { status: 204 };
      },
    });
    await renderApp(<UserProfile />, { fetch });
    fireEvent.press(await screen.findByRole('button', { name: 'Follow' }));
    expect(await screen.findByRole('button', { name: 'Following' })).toBeTruthy();
    expect(fetch.calls.some((c) => c.method === 'PUT' && c.path === '/v1/users/bola/follow')).toBe(
      true,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Following' }));
    expect(await screen.findByRole('button', { name: 'Follow' })).toBeTruthy();
    expect(fetch.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('a private account shows "Requested" after following, and hides posts', async () => {
    let requested = false;
    const fetch = makeFetch({
      'GET /v1/users/bola': () => ({
        json: profile(
          { isPrivate: true, contentHidden: true },
          { following: requested ? 'pending' : 'none' },
        ),
      }),
      'PUT /v1/users/bola/follow': () => {
        requested = true;
        return { json: { status: 'pending' } };
      },
    });
    await renderApp(<UserProfile />, { fetch });
    expect(
      await screen.findByText('This account is private. Follow to see their posts.'),
    ).toBeTruthy();
    expect(fetch.calls.some((c) => c.path === '/v1/users/bola/posts')).toBe(false);
    fireEvent.press(screen.getByRole('button', { name: 'Follow' }));
    expect(await screen.findByRole('button', { name: 'Requested' })).toBeTruthy();
  });

  it('sends a friend request', async () => {
    const fetch = makeFetch({
      'GET /v1/users/bola': { json: profile() },
      'GET /v1/users/bola/posts': { json: { items: [], nextCursor: null } },
      'POST /v1/friends/requests': { json: { status: 'pending' } },
    });
    await renderApp(<UserProfile />, { fetch });
    fireEvent.press(await screen.findByRole('button', { name: 'Add friend' }));
    await waitFor(() =>
      expect(
        fetch.calls.some((c) => c.method === 'POST' && c.path === '/v1/friends/requests'),
      ).toBe(true),
    );
    expect(fetch.calls.find((c) => c.path === '/v1/friends/requests')!.body).toEqual({
      username: 'bola',
    });
  });

  it('blocks after confirmation and leaves the screen', async () => {
    const fetch = makeFetch({
      'GET /v1/users/bola': { json: profile() },
      'GET /v1/users/bola/posts': { json: { items: [], nextCursor: null } },
      'PUT /v1/users/bola/block': { json: { blocked: true } },
    });
    await renderApp(<UserProfile />, { fetch });
    fireEvent.press(await screen.findByRole('button', { name: 'More options' }));
    await screen.findByText('Mute');
    fireEvent.press(screen.getByLabelText('Block')); // the menu entry
    expect(await screen.findByText('Block Bola A?')).toBeTruthy();
    expect(fetch.calls.some((c) => c.path === '/v1/users/bola/block')).toBe(false); // not until confirmed
    fireEvent.press(screen.getByLabelText('Block'));
    await waitFor(() =>
      expect(fetch.calls.some((c) => c.method === 'PUT' && c.path === '/v1/users/bola/block')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(router().back).toHaveBeenCalled());
  });

  it('shows Edit profile on your own profile instead of relationship buttons', async () => {
    setParams({ username: 'ada' });
    const fetch = makeFetch({
      'GET /v1/users/ada': {
        json: profile({ username: 'ada', displayName: 'Ada Obi' }, { isSelf: true }),
      },
      'GET /v1/users/ada/posts': { json: { items: [], nextCursor: null } },
      'GET /v1/auth/me': { json: { user: { id: 'u', profile: { username: 'ada' } }, flags: {} } },
    });
    await renderApp(<UserProfile />, { fetch });
    expect(await screen.findByRole('button', { name: 'Edit profile' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();
  });

  it('shows not-found, and an offline error with retry', async () => {
    await renderApp(<UserProfile />, {
      fetch: makeFetch({
        'GET /v1/users/bola': { status: 404, json: { error: { code: 'not_found', message: 'x' } } },
      }),
    });
    expect(await screen.findByText('This profile is not available.')).toBeTruthy();
    screen.unmount();
    await renderApp(<UserProfile />, {
      fetch: makeFetch({
        'GET /v1/users/bola': () => {
          throw new TypeError('Network request failed');
        },
      }),
    });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
