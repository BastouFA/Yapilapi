import type { FeedMode } from '@yapilapi/api-client';

/** Query keys. The first element names the domain so caches can be patched or cleared by prefix. */
export const qk = {
  feed: (mode: FeedMode, geo = '') => ['feed', mode, geo] as const,
  post: (id: string) => ['post', id] as const,
  comments: (postId: string) => ['comments', postId] as const,
  replies: (commentId: string) => ['replies', commentId] as const,
  explain: (postId: string) => ['explain', postId] as const,
  profile: (username: string) => ['profile', username] as const,
  userPosts: (username: string) => ['userPosts', username] as const,
  topics: () => ['topics'] as const,
  myInterests: () => ['myInterests'] as const,
  trending: () => ['trending'] as const,
  people: () => ['people'] as const,
  discoverTopics: () => ['discoverTopics'] as const,
  discoverCommunities: () => ['discoverCommunities'] as const,
  search: (q: string) => ['search', q] as const,
  communities: (q: string) => ['communities', q] as const,
  myCommunities: () => ['myCommunities'] as const,
  community: (idOrSlug: string) => ['community', idOrSlug] as const,
  communityFeed: (id: string) => ['communityFeed', id] as const,
  conversations: () => ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  messages: (id: string) => ['messages', id] as const,
  unreadConversations: () => ['unreadConversations'] as const,
  notifications: () => ['notifications'] as const,
  unreadNotifications: () => ['unreadNotifications'] as const,
  preferences: () => ['preferences'] as const,
  sessions: () => ['sessions'] as const,
  pushTokens: () => ['pushTokens'] as const,
  saved: () => ['saved'] as const,
} as const;

/** Domains whose results are safe to keep on disk for offline reading. */
export const PERSISTED_DOMAINS: ReadonlySet<string> = new Set([
  'feed',
  'post',
  'comments',
  'conversations',
  'messages',
  'communityFeed',
  'profile',
  'userPosts',
  'topics',
  'notifications',
]);
