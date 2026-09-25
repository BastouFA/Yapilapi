import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import Home from '../src/app/(tabs)/index';
import { PostCard } from '../src/features/PostCard';
import { makeFetch, makeMedia, makePost, renderApp, router } from './support/harness';

const page = (items: unknown[], nextCursor: string | null = null) => ({
  json: { items, nextCursor },
});

describe('Home feed', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('shows For You by default, with the reason line, and switches to Following and Friends', async () => {
    const fetch = makeFetch({
      'GET /v1/feed': ({ query }) => {
        const m = query.get('mode');
        return page(
          m === 'for_you'
            ? [makePost({ id: 'a', body: 'For you post', reasons: ['trending'] })]
            : m === 'following'
              ? [makePost({ id: 'b', body: 'Following post' })]
              : [],
        );
      },
    });
    await renderApp(<Home />, { fetch });
    expect(await screen.findByText('For you post')).toBeTruthy();
    expect(screen.getByText('Popular right now')).toBeTruthy();
    fireEvent.press(screen.getByRole('tab', { name: 'Following' }));
    expect(await screen.findByText('Following post')).toBeTruthy();
    fireEvent.press(screen.getByRole('tab', { name: 'Friends' }));
    expect(await screen.findByText(/Your friends have not posted yet/)).toBeTruthy();
    expect(
      fetch.calls
        .filter((c) => c.path === '/v1/feed')
        .map((c) => new URLSearchParams(c.query).get('mode')),
    ).toEqual(expect.arrayContaining(['for_you', 'following', 'friends']));
  });

  it('asks for a small first page (low-bandwidth friendly) and loads more on demand in low-data mode', async () => {
    const fetch = makeFetch({
      'GET /v1/feed': ({ query }) =>
        query.get('cursor')
          ? page([makePost({ id: 'p2', body: 'Second page' })])
          : page([makePost({ id: 'p1', body: 'First page' })], 'cur-2'),
    });
    await renderApp(<Home />, { fetch, prefs: { bandwidth: 'low' } });
    expect(await screen.findByText('First page')).toBeTruthy();
    expect(
      new URLSearchParams(fetch.calls.find((c) => c.path === '/v1/feed')!.query).get('limit'),
    ).toBe('15');
    expect(screen.getByText('Low-data mode is on: images load when you tap them.')).toBeTruthy();
    expect(screen.queryByText('Second page')).toBeNull(); // no automatic prefetch
    fireEvent.press(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second page')).toBeTruthy();
  });

  it('shows an empty state with a way forward', async () => {
    await renderApp(<Home />, { fetch: makeFetch({ 'GET /v1/feed': page([]) }) });
    expect(await screen.findByText(/Your For You feed is warming up/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Write a post' }));
    expect(router().push).toHaveBeenCalledWith('/compose');
  });

  it('shows an error with retry when the first load fails, and recovers', async () => {
    let fail = true;
    const fetch = makeFetch({
      'GET /v1/feed': () =>
        fail
          ? { status: 500, json: { error: { code: 'internal', message: 'boom' } } }
          : { json: { items: [makePost({ body: 'Back online' })], nextCursor: null } },
    });
    await renderApp(<Home />, { fetch });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    fireEvent.press(retry);
    expect(await screen.findByText('Back online')).toBeTruthy();
  });

  it('says it could not reach the server when offline instead of showing a blank screen', async () => {
    const fetch = makeFetch({
      'GET /v1/feed': () => {
        throw new TypeError('Network request failed');
      },
    });
    await renderApp(<Home />, { fetch });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByText(/Could not reach YAPILAPI|Could not reach the server/)).toBeTruthy();
  });
});

describe('PostCard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('likes optimistically in the feed (before the server answers) and rolls back if it fails', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fail = false;
    const fetch = makeFetch({
      'GET /v1/feed': page([makePost({ id: 'post-1' })]),
      'PUT /v1/posts/post-1/reaction': async () => {
        await gate;
        return fail
          ? { status: 500, json: { error: { code: 'internal', message: 'x' } } }
          : { json: { reaction: 'like', likes: 3 } };
      },
    });
    await renderApp(<Home />, { fetch });
    fireEvent.press(await screen.findByRole('button', { name: 'Like, 2 likes' }));
    // The UI changed while the request is still pending.
    expect(await screen.findByRole('button', { name: 'Remove reaction, 3 likes' })).toBeTruthy();
    expect(fetch.calls.find((c) => c.method === 'PUT')!.body).toEqual({ kind: 'like' });
    fail = true;
    release();
    expect(await screen.findByRole('button', { name: 'Like, 2 likes' })).toBeTruthy();
  });

  it('exposes accessible names for author, actions and counts', async () => {
    await renderApp(<PostCard post={makePost()} />, { fetch: makeFetch({}) });
    expect(screen.getByLabelText('Post by Bola A')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open profile of Bola A/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Comment, 1 comment/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More about this post' })).toBeTruthy();
  });

  it('opens the post and the author profile', async () => {
    await renderApp(<PostCard post={makePost()} />, { fetch: makeFetch({}) });
    fireEvent.press(screen.getByText('Hello from Lagos'));
    expect(router().push).toHaveBeenCalledWith({
      pathname: '/post/[id]',
      params: { id: 'post-1' },
    });
    fireEvent.press(screen.getByRole('button', { name: /Open profile of Bola A/i }));
    expect(router().push).toHaveBeenCalledWith({
      pathname: '/user/[username]',
      params: { username: 'bola' },
    });
  });

  it('low-data mode: images wait for a tap; normal mode loads them with alt text', async () => {
    const post = makePost({ media: [makeMedia()] });
    const low = await renderApp(<PostCard post={post} />, {
      fetch: makeFetch({}),
      prefs: { bandwidth: 'low' },
    });
    expect(screen.queryByTestId('expo-image')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: /Tap to load image/ }));
    expect(await screen.findByTestId('expo-image')).toBeTruthy();
    expect(screen.getByLabelText('Image: A market stall')).toBeTruthy();
    low.unmount();
    await renderApp(<PostCard post={post} />, {
      fetch: makeFetch({}),
      prefs: { bandwidth: 'normal' },
    });
    expect(screen.getByTestId('expo-image')).toBeTruthy();
    expect(screen.getByLabelText('Image: A market stall')).toBeTruthy();
  });

  it('a video is a link tile that never autoplays', async () => {
    const post = makePost({
      media: [
        makeMedia({
          id: 'v1',
          kind: 'video',
          url: 'https://cdn.test/v.mp4',
          mimeType: 'video/mp4',
          altText: null,
        }),
      ],
    });
    await renderApp(<PostCard post={post} />, { fetch: makeFetch({}) });
    const tile = screen.getByRole('link', { name: /Video\. Tap to open it in your browser/ });
    expect(tile).toBeTruthy();
    expect(screen.queryByTestId('expo-image')).toBeNull();
    expect(screen.queryByTestId('video')).toBeNull();
  });

  it('shows a processing placeholder for media that is not ready', async () => {
    await renderApp(
      <PostCard post={makePost({ media: [makeMedia({ status: 'processing' })] })} />,
      { fetch: makeFetch({}) },
    );
    expect(screen.getByText('Still processing')).toBeTruthy();
  });
});
