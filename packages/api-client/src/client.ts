import { createRequester, type ApiClientOptions, type RequestOptions } from './http';
import type * as T from './types';
import { createAdminApi } from './admin';

const enc = encodeURIComponent;
type Sig = { signal?: AbortSignal | undefined };
const opt = (o: Sig | undefined, extra: Partial<RequestOptions> = {}): RequestOptions => ({
  ...extra,
  signal: o?.signal,
});
type PageParams = Sig & { cursor?: string | undefined; limit?: number | undefined };
const pageQuery = (p: PageParams | undefined) => ({ cursor: p?.cursor, limit: p?.limit });

/** A fresh idempotency key (8-128 chars: letters, digits, `. _ : -`), matching the API's `IDEMPOTENCY_KEY` pattern. */
const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
type Idem = { idempotencyKey?: string };

/**
 * Typed client for the YAPILAPI API. Pure `fetch` + JSON: no DOM APIs, so React Native can use it unchanged.
 * Every method returns the parsed response body or throws {@link ApiError}.
 */
export function createApiClient(options: ApiClientOptions) {
  const { request: r, mode } = createRequester(options);
  const deliver = mode === 'bearer' ? ('token' as const) : ('cookie' as const);

  const auth = {
    register: (input: T.RegisterInput, o?: Sig) =>
      r<T.RegisterResult>(
        'POST',
        '/v1/auth/register',
        opt(o, { body: { ...input, deliver }, skipUnauthorizedHook: true }),
      ),
    login: (input: T.LoginInput, o?: Sig) =>
      r<T.LoginResult>(
        'POST',
        '/v1/auth/login',
        opt(o, { body: { ...input, deliver }, skipUnauthorizedHook: true }),
      ),
    mfaVerify: (input: T.MfaVerifyInput, o?: Sig) =>
      r<T.MfaVerifyResult>(
        'POST',
        '/v1/auth/mfa/verify',
        opt(o, { body: { ...input, deliver }, skipUnauthorizedHook: true }),
      ),
    logout: (o?: Sig) => r<void>('POST', '/v1/auth/logout', opt(o, { skipUnauthorizedHook: true })),
    logoutAll: (o?: Sig) => r<{ revoked: number }>('POST', '/v1/auth/logout-all', opt(o)),
    me: (o?: Sig & { skipUnauthorizedHook?: boolean }) =>
      r<T.MeResponse>(
        'GET',
        '/v1/auth/me',
        opt(o, { skipUnauthorizedHook: o?.skipUnauthorizedHook }),
      ),
    sessions: (o?: Sig) => r<{ items: T.SessionInfo[] }>('GET', '/v1/auth/sessions', opt(o)),
    revokeSession: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/auth/sessions/${enc(id)}`, opt(o)),
    verifyEmail: (token: string, o?: Sig) =>
      r<{ verified: boolean }>(
        'POST',
        '/v1/auth/email/verify',
        opt(o, { body: { token }, skipUnauthorizedHook: true }),
      ),
    resendVerification: (o?: Sig) =>
      r<{ sent?: boolean; alreadyVerified?: boolean }>('POST', '/v1/auth/email/resend', opt(o)),
    forgotPassword: (email: string, o?: Sig) =>
      r<{ message: string }>(
        'POST',
        '/v1/auth/password/forgot',
        opt(o, { body: { email }, skipUnauthorizedHook: true }),
      ),
    resetPassword: (token: string, newPassword: string, o?: Sig) =>
      r<{ reset: boolean }>(
        'POST',
        '/v1/auth/password/reset',
        opt(o, { body: { token, newPassword }, skipUnauthorizedHook: true }),
      ),
    changePassword: (currentPassword: string, newPassword: string, o?: Sig) =>
      r<{ changed: boolean; otherSessionsRevoked: number }>(
        'POST',
        '/v1/auth/password/change',
        opt(o, { body: { currentPassword, newPassword }, skipUnauthorizedHook: true }),
      ),
    mfaSetup: (o?: Sig) => r<T.MfaSetup>('POST', '/v1/auth/mfa/setup', opt(o)),
    mfaEnable: (code: string, o?: Sig) =>
      r<{ enabled: true; recoveryCodes: string[] }>(
        'POST',
        '/v1/auth/mfa/enable',
        opt(o, { body: { code } }),
      ),
    mfaDisable: (password: string, code: string, o?: Sig) =>
      r<{ enabled: false }>(
        'POST',
        '/v1/auth/mfa/disable',
        opt(o, { body: { password, code }, skipUnauthorizedHook: true }),
      ),
  };

  const account = {
    deactivate: (password: string, o?: Sig) =>
      r<void>(
        'POST',
        '/v1/account/deactivate',
        opt(o, { body: { password }, skipUnauthorizedHook: true }),
      ),
    requestDeletion: (password: string, o?: Sig) =>
      r<{ scheduledFor: T.IsoDate }>(
        'POST',
        '/v1/account/deletion',
        opt(o, { body: { password }, skipUnauthorizedHook: true }),
      ),
    cancelDeletion: (o?: Sig) =>
      r<{ cancelled: boolean }>('POST', '/v1/account/deletion/cancel', opt(o)),
  };

  const profile = {
    get: (username: string, o?: Sig) => r<T.Profile>('GET', `/v1/users/${enc(username)}`, opt(o)),
    usernameAvailable: (username: string, o?: Sig) =>
      r<T.UsernameAvailability>('GET', `/v1/usernames/${enc(username)}/available`, opt(o)),
    update: (input: T.UpdateProfileInput, o?: Sig) =>
      r<{ updated: boolean }>('PATCH', '/v1/profile', opt(o, { body: input })),
    interests: (o?: Sig) => r<{ items: T.Topic[] }>('GET', '/v1/profile/interests', opt(o)),
    setInterests: (topics: string[], o?: Sig) =>
      r<{ count: number }>('PUT', '/v1/profile/interests', opt(o, { body: { topics } })),
    completeOnboarding: (o?: Sig) =>
      r<{ completed: boolean }>('POST', '/v1/profile/onboarding/complete', opt(o)),
  };

  const topics = {
    list: (o?: Sig) => r<{ items: T.Topic[] }>('GET', '/v1/topics', opt(o)),
    mute: (slug: string, o?: Sig) =>
      r<{ muted: boolean }>('PUT', `/v1/topics/${enc(slug)}/mute`, opt(o)),
    unmute: (slug: string, o?: Sig) => r<void>('DELETE', `/v1/topics/${enc(slug)}/mute`, opt(o)),
  };

  const settings = {
    getPreferences: (o?: Sig) => r<T.Preferences>('GET', '/v1/settings/preferences', opt(o)),
    updatePreferences: (input: T.PreferencesUpdate, o?: Sig) =>
      r<{ updated: boolean }>('PATCH', '/v1/settings/preferences', opt(o, { body: input })),
  };

  const graph = {
    follow: (username: string, o?: Sig) =>
      r<{ status: 'active' | 'pending' }>('PUT', `/v1/users/${enc(username)}/follow`, opt(o)),
    unfollow: (username: string, o?: Sig) =>
      r<void>('DELETE', `/v1/users/${enc(username)}/follow`, opt(o)),
    followers: (username: string, p?: PageParams) =>
      r<T.Page<T.UserCard>>(
        'GET',
        `/v1/users/${enc(username)}/followers`,
        opt(p, { query: pageQuery(p) }),
      ),
    following: (username: string, p?: PageParams) =>
      r<T.Page<T.UserCard>>(
        'GET',
        `/v1/users/${enc(username)}/following`,
        opt(p, { query: pageQuery(p) }),
      ),
    followRequests: (o?: Sig) =>
      r<{ items: T.UserCardWithRequest[] }>('GET', '/v1/follow-requests', opt(o)),
    approveFollowRequest: (userId: string, o?: Sig) =>
      r<{ approved: boolean }>('POST', `/v1/follow-requests/${enc(userId)}/approve`, opt(o)),
    denyFollowRequest: (userId: string, o?: Sig) =>
      r<void>('POST', `/v1/follow-requests/${enc(userId)}/deny`, opt(o)),

    friends: (p?: PageParams) =>
      r<T.Page<T.UserCard>>('GET', '/v1/friends', opt(p, { query: pageQuery(p) })),
    sendFriendRequest: (username: string, o?: Sig) =>
      r<{ status: 'pending' | 'accepted' }>(
        'POST',
        '/v1/friends/requests',
        opt(o, { body: { username } }),
      ),
    friendRequests: (direction: 'incoming' | 'outgoing' = 'incoming', o?: Sig) =>
      r<{ items: T.UserCardWithRequest[] }>(
        'GET',
        '/v1/friends/requests',
        opt(o, { query: { direction } }),
      ),
    acceptFriendRequest: (userId: string, o?: Sig) =>
      r<{ status: 'accepted' }>('POST', `/v1/friends/requests/${enc(userId)}/accept`, opt(o)),
    removeFriend: (userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/friends/${enc(userId)}`, opt(o)),

    circles: (o?: Sig) => r<{ items: T.Circle[] }>('GET', '/v1/circles', opt(o)),
    createCircle: (kind: T.CircleKind, name: string, o?: Sig) =>
      r<T.Circle>('POST', '/v1/circles', opt(o, { body: { kind, name } })),
    renameCircle: (id: string, name: string, o?: Sig) =>
      r<{ updated: boolean }>('PATCH', `/v1/circles/${enc(id)}`, opt(o, { body: { name } })),
    deleteCircle: (id: string, o?: Sig) => r<void>('DELETE', `/v1/circles/${enc(id)}`, opt(o)),
    circleMembers: (id: string, o?: Sig) =>
      r<{ items: T.UserCard[] }>('GET', `/v1/circles/${enc(id)}/members`, opt(o)),
    addCircleMember: (id: string, userId: string, o?: Sig) =>
      r<{ added: boolean }>('PUT', `/v1/circles/${enc(id)}/members/${enc(userId)}`, opt(o)),
    removeCircleMember: (id: string, userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/circles/${enc(id)}/members/${enc(userId)}`, opt(o)),

    block: (username: string, o?: Sig) =>
      r<{ blocked: boolean }>('PUT', `/v1/users/${enc(username)}/block`, opt(o)),
    unblock: (username: string, o?: Sig) =>
      r<void>('DELETE', `/v1/users/${enc(username)}/block`, opt(o)),
    mute: (username: string, o?: Sig) =>
      r<{ muted: boolean }>('PUT', `/v1/users/${enc(username)}/mute`, opt(o)),
    unmute: (username: string, o?: Sig) =>
      r<void>('DELETE', `/v1/users/${enc(username)}/mute`, opt(o)),
    restrict: (username: string, o?: Sig) =>
      r<{ restricted: boolean }>('PUT', `/v1/users/${enc(username)}/restrict`, opt(o)),
    unrestrict: (username: string, o?: Sig) =>
      r<void>('DELETE', `/v1/users/${enc(username)}/restrict`, opt(o)),
    blocks: (o?: Sig) => r<{ items: T.UserCard[] }>('GET', '/v1/blocks', opt(o)),
    mutes: (o?: Sig) => r<{ items: T.UserCard[] }>('GET', '/v1/mutes', opt(o)),
    restrictions: (o?: Sig) => r<{ items: T.UserCard[] }>('GET', '/v1/restrictions', opt(o)),
  };

  const posts = {
    create: (input: T.CreatePostInput, o?: Sig) =>
      r<T.Post>('POST', '/v1/posts', opt(o, { body: input })),
    get: (id: string, o?: Sig) => r<T.Post>('GET', `/v1/posts/${enc(id)}`, opt(o)),
    edit: (id: string, body: string, o?: Sig) =>
      r<{ updated: boolean }>('PATCH', `/v1/posts/${enc(id)}`, opt(o, { body: { body } })),
    delete: (id: string, o?: Sig) => r<void>('DELETE', `/v1/posts/${enc(id)}`, opt(o)),
    byUser: (username: string, p?: PageParams) =>
      r<T.Page<T.Post>>('GET', `/v1/users/${enc(username)}/posts`, opt(p, { query: pageQuery(p) })),
    share: (
      id: string,
      input: { channel?: 'repost' | 'message' | 'external'; comment?: string } = {},
      o?: Sig,
    ) => r<{ shared: boolean }>('POST', `/v1/posts/${enc(id)}/share`, opt(o, { body: input })),
    recordView: (id: string, o?: Sig) =>
      r<{ counted: boolean }>('POST', `/v1/posts/${enc(id)}/view`, opt(o)),
  };

  const comments = {
    list: (postId: string, p?: PageParams & { sort?: 'new' | 'old' }) =>
      r<T.Page<T.Comment>>(
        'GET',
        `/v1/posts/${enc(postId)}/comments`,
        opt(p, { query: { ...pageQuery(p), sort: p?.sort } }),
      ),
    replies: (commentId: string, p?: PageParams) =>
      r<T.Page<T.Comment>>(
        'GET',
        `/v1/comments/${enc(commentId)}/replies`,
        opt(p, { query: pageQuery(p) }),
      ),
    create: (postId: string, body: string, parentId?: string, o?: Sig) =>
      r<T.Comment>(
        'POST',
        `/v1/posts/${enc(postId)}/comments`,
        opt(o, { body: parentId ? { body, parentId } : { body } }),
      ),
    edit: (id: string, body: string, o?: Sig) =>
      r<{ updated: boolean }>('PATCH', `/v1/comments/${enc(id)}`, opt(o, { body: { body } })),
    delete: (id: string, o?: Sig) => r<void>('DELETE', `/v1/comments/${enc(id)}`, opt(o)),
    approve: (id: string, o?: Sig) =>
      r<{ approved: boolean }>('POST', `/v1/comments/${enc(id)}/approve`, opt(o)),
  };

  const reactions = {
    reactToPost: (postId: string, kind: T.ReactionKind = 'like', o?: Sig) =>
      r<{ reaction: T.ReactionKind; likes: number }>(
        'PUT',
        `/v1/posts/${enc(postId)}/reaction`,
        opt(o, { body: { kind } }),
      ),
    removePostReaction: (postId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/posts/${enc(postId)}/reaction`, opt(o)),
    reactToComment: (commentId: string, kind: T.ReactionKind = 'like', o?: Sig) =>
      r<{ reaction: T.ReactionKind }>(
        'PUT',
        `/v1/comments/${enc(commentId)}/reaction`,
        opt(o, { body: { kind } }),
      ),
    removeCommentReaction: (commentId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/comments/${enc(commentId)}/reaction`, opt(o)),
  };

  const saves = {
    save: (postId: string, collection?: string, o?: Sig) =>
      r<{ saved: boolean }>(
        'PUT',
        `/v1/posts/${enc(postId)}/save`,
        opt(o, { body: collection ? { collection } : {} }),
      ),
    unsave: (postId: string, o?: Sig) => r<void>('DELETE', `/v1/posts/${enc(postId)}/save`, opt(o)),
    list: (p?: PageParams & { collection?: string }) =>
      r<T.Page<T.Post>>(
        'GET',
        '/v1/saved',
        opt(p, { query: { ...pageQuery(p), collection: p?.collection } }),
      ),
  };

  const polls = {
    vote: (postId: string, optionIds: string[], o?: Sig) =>
      r<T.Poll>('POST', `/v1/posts/${enc(postId)}/poll/vote`, opt(o, { body: { optionIds } })),
  };

  const feed = {
    get: (params: T.FeedParams = {}, o?: Sig) =>
      r<T.FeedPage>(
        'GET',
        '/v1/feed',
        opt(o, {
          query: {
            mode: params.mode,
            cursor: params.cursor,
            limit: params.limit,
            lat: params.lat,
            lng: params.lng,
            radiusKm: params.radiusKm,
            circleId: params.circleId,
            topics: params.topics,
          },
        }),
      ),
    explain: (postId: string, o?: Sig) =>
      r<T.FeedExplanation>('GET', `/v1/feed/explain/${enc(postId)}`, opt(o)),
    feedback: (postId: string, signal: T.FeedSignal, o?: Sig) =>
      r<{ recorded: boolean }>('POST', '/v1/feed/feedback', opt(o, { body: { postId, signal } })),
  };

  const conversations = {
    list: (p?: PageParams & { kind?: 'direct' | 'group'; pinned?: boolean }) =>
      r<T.Page<T.InboxItem>>(
        'GET',
        '/v1/conversations',
        opt(p, {
          query: {
            ...pageQuery(p),
            kind: p?.kind,
            pinned: p?.pinned === undefined ? undefined : String(p.pinned),
          },
        }),
      ),
    unreadCount: (o?: Sig) =>
      r<{ conversations: number; messages: number }>(
        'GET',
        '/v1/conversations/unread-count',
        opt(o),
      ),
    get: (id: string, o?: Sig) => r<T.Conversation>('GET', `/v1/conversations/${enc(id)}`, opt(o)),
    direct: (target: { username: string } | { userId: string }, o?: Sig) =>
      r<T.Conversation>('POST', '/v1/conversations/direct', opt(o, { body: target })),
    createGroup: (title: string, memberIds: string[], o?: Sig) =>
      r<T.Conversation>('POST', '/v1/conversations/group', opt(o, { body: { title, memberIds } })),
    rename: (id: string, title: string, o?: Sig) =>
      r<T.Conversation>('PATCH', `/v1/conversations/${enc(id)}`, opt(o, { body: { title } })),
    updateMine: (id: string, prefs: { pinned?: boolean; mutedUntil?: string | null }, o?: Sig) =>
      r<unknown>('PATCH', `/v1/conversations/${enc(id)}/me`, opt(o, { body: prefs })),
    addMembers: (id: string, userIds: string[], o?: Sig) =>
      r<{ added: string[]; conversation: T.Conversation }>(
        'POST',
        `/v1/conversations/${enc(id)}/members`,
        opt(o, { body: { userIds } }),
      ),
    removeMember: (id: string, userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/conversations/${enc(id)}/members/${enc(userId)}`, opt(o)),
    leave: (id: string, o?: Sig) =>
      r<unknown>('POST', `/v1/conversations/${enc(id)}/leave`, opt(o)),
    markRead: (id: string, messageId?: string, o?: Sig) =>
      r<{ lastReadAt: string }>(
        'POST',
        `/v1/conversations/${enc(id)}/read`,
        opt(o, { body: messageId ? { messageId } : {} }),
      ),
    messages: (id: string, p?: PageParams) =>
      r<T.Page<T.Message>>(
        'GET',
        `/v1/conversations/${enc(id)}/messages`,
        opt(p, { query: pageQuery(p) }),
      ),
    send: (id: string, input: T.SendMessageInput, o?: Sig) =>
      r<T.Message>('POST', `/v1/conversations/${enc(id)}/messages`, opt(o, { body: input })),
  };

  const messages = {
    edit: (id: string, body: string, o?: Sig) =>
      r<T.Message>('PATCH', `/v1/messages/${enc(id)}`, opt(o, { body: { body } })),
    delete: (id: string, o?: Sig) => r<unknown>('DELETE', `/v1/messages/${enc(id)}`, opt(o)),
    react: (id: string, kind: T.ReactionKind = 'like', o?: Sig) =>
      r<T.Message>('PUT', `/v1/messages/${enc(id)}/reaction`, opt(o, { body: { kind } })),
    unreact: (id: string, o?: Sig) =>
      r<T.Message>('DELETE', `/v1/messages/${enc(id)}/reaction`, opt(o)),
  };

  const realtime = {
    /** Single-use, 60-second ticket for opening the WebSocket without exposing the session cookie to it. */
    ticket: (o?: Sig) => r<T.WsTicket>('POST', '/v1/ws/ticket', opt(o)),
  };

  const communities = {
    list: (p?: PageParams & { q?: string; topic?: string; language?: string }) =>
      r<T.Page<T.Community>>(
        'GET',
        '/v1/communities',
        opt(p, { query: { ...pageQuery(p), q: p?.q, topic: p?.topic, language: p?.language } }),
      ),
    mine: (p?: PageParams) =>
      r<T.Page<T.Community>>('GET', '/v1/me/communities', opt(p, { query: pageQuery(p) })),
    invitations: (p?: PageParams) =>
      r<T.Page<T.CommunityInvitation>>(
        'GET',
        '/v1/me/community-invitations',
        opt(p, { query: pageQuery(p) }),
      ),
    get: (idOrSlug: string, o?: Sig) =>
      r<T.Community>('GET', `/v1/communities/${enc(idOrSlug)}`, opt(o)),
    create: (input: T.CreateCommunityInput, o?: Sig) =>
      r<T.Community>('POST', '/v1/communities', opt(o, { body: input })),
    join: (id: string, o?: Sig) =>
      r<{ status: 'active' | 'pending' }>('POST', `/v1/communities/${enc(id)}/join`, opt(o)),
    leave: (id: string, o?: Sig) =>
      r<{ status: 'left' }>('POST', `/v1/communities/${enc(id)}/leave`, opt(o)),
    acceptInvitation: (id: string, o?: Sig) =>
      r<{ status: 'active' }>('POST', `/v1/communities/${enc(id)}/invitation/accept`, opt(o)),
    declineInvitation: (id: string, o?: Sig) =>
      r<unknown>('POST', `/v1/communities/${enc(id)}/invitation/decline`, opt(o)),
    feed: (id: string, p?: PageParams) =>
      r<T.Page<T.Post>>('GET', `/v1/communities/${enc(id)}/feed`, opt(p, { query: pageQuery(p) })),
    members: (
      id: string,
      p?: PageParams & { status?: 'active' | 'pending' | 'invited' | 'banned' },
    ) =>
      r<T.Page<T.CommunityMember>>(
        'GET',
        `/v1/communities/${enc(id)}/members`,
        opt(p, { query: { ...pageQuery(p), status: p?.status } }),
      ),
    approveRequest: (id: string, userId: string, o?: Sig) =>
      r<{ status: 'active' }>(
        'POST',
        `/v1/communities/${enc(id)}/requests/${enc(userId)}/approve`,
        opt(o),
      ),
    rejectRequest: (id: string, userId: string, o?: Sig) =>
      r<unknown>('POST', `/v1/communities/${enc(id)}/requests/${enc(userId)}/reject`, opt(o)),
    channels: (id: string, o?: Sig) =>
      r<{ items: T.CommunityChannel[] }>('GET', `/v1/communities/${enc(id)}/channels`, opt(o)),
    createChannel: (id: string, name: string, kind: 'text' | 'voice' = 'text', o?: Sig) =>
      r<T.CommunityChannel>(
        'POST',
        `/v1/communities/${enc(id)}/channels`,
        opt(o, { body: { name, kind } }),
      ),
  };

  const meta = { get: (o?: Sig) => r<T.Meta>('GET', '/v1/meta', opt(o)) };
  const admin = createAdminApi(r);

  // ------------------------------------------------------------------ search
  const search = {
    run: (params: T.SearchParams, o?: Sig) =>
      r<T.SearchResponse>(
        'GET',
        '/v1/search',
        opt(o, {
          query: {
            q: params.q,
            types: params.types?.join(','),
            limit: params.limit,
            cursor: params.cursor,
            lat: params.lat,
            lng: params.lng,
            radiusKm: params.radiusKm,
            tz: params.tz,
            interpret: params.interpret,
          },
        }),
      ),
    suggest: (q: string, p?: Sig & { types?: T.SearchResultType[]; limit?: number }, o?: Sig) =>
      r<T.SearchSuggestResponse>(
        'GET',
        '/v1/search/suggest',
        opt(o ?? p, { query: { q, types: p?.types?.join(','), limit: p?.limit } }),
      ),
    history: (o?: Sig) => r<T.SearchHistoryResponse>('GET', '/v1/search/history', opt(o)),
    clearHistory: (q?: string, o?: Sig) =>
      r<void>('DELETE', '/v1/search/history', opt(o, { query: { q } })),
  };

  // ------------------------------------------------------------------ discover
  const discover = {
    trending: (p?: PageParams & { window?: '1h' | '6h' | '24h' | '7d' }) =>
      r<T.TrendingResponse>(
        'GET',
        '/v1/discover/trending',
        opt(p, { query: { ...pageQuery(p), window: p?.window } }),
      ),
    people: (p?: PageParams) =>
      r<T.DiscoverPeoplePage>('GET', '/v1/discover/people', opt(p, { query: pageQuery(p) })),
    suggestedFollows: (p?: Sig & { topics?: string[]; limit?: number }) =>
      r<{ basedOn: string[]; source: string; items: T.SuggestedPerson[] }>(
        'GET',
        '/v1/discover/suggested-follows',
        opt(p, { query: { topics: p?.topics?.join(','), limit: p?.limit } }),
      ),
    creators: (p?: PageParams & { topic?: string }) =>
      r<T.Page<T.SuggestedPerson>>(
        'GET',
        '/v1/discover/creators',
        opt(p, { query: { ...pageQuery(p), topic: p?.topic } }),
      ),
    communities: (p?: PageParams & { topic?: string }) =>
      r<T.Page<T.DiscoverCommunityItem>>(
        'GET',
        '/v1/discover/communities',
        opt(p, { query: { ...pageQuery(p), topic: p?.topic } }),
      ),
    topics: (p?: Sig & { limit?: number }) =>
      r<{ items: T.DiscoverTopicItem[] }>(
        'GET',
        '/v1/discover/topics',
        opt(p, { query: { limit: p?.limit } }),
      ),
    now: (p?: Sig & { lat?: number; lng?: number; radiusKm?: number; limit?: number }) =>
      r<T.NowResponse>(
        'GET',
        '/v1/now',
        opt(p, { query: { lat: p?.lat, lng: p?.lng, radiusKm: p?.radiusKm, limit: p?.limit } }),
      ),
  };

  // ------------------------------------------------------------------ notifications
  const notifications = {
    list: (p?: PageParams & { category?: T.NotificationCategory; unread?: boolean }) =>
      r<T.Page<T.NotificationItem>>(
        'GET',
        '/v1/notifications',
        opt(p, {
          query: {
            ...pageQuery(p),
            category: p?.category,
            unread: p?.unread === undefined ? undefined : String(p.unread),
          },
        }),
      ),
    unreadCount: (o?: Sig) =>
      r<{ total: number; byCategory: Record<T.NotificationCategory, number> }>(
        'GET',
        '/v1/notifications/unread-count',
        opt(o),
      ),
    readAll: (category?: T.NotificationCategory, o?: Sig) =>
      r<{ updated: number }>(
        'POST',
        '/v1/notifications/read-all',
        opt(o, { body: category ? { category } : {} }),
      ),
    markRead: (id: string, o?: Sig) => r<void>('POST', `/v1/notifications/${enc(id)}/read`, opt(o)),
    remove: (id: string, o?: Sig) => r<void>('DELETE', `/v1/notifications/${enc(id)}`, opt(o)),
    getPreferences: (o?: Sig) =>
      r<T.NotificationPreferences>('GET', '/v1/notifications/preferences', opt(o)),
    setPreferences: (
      items: Array<{ key: string; channel: T.NotificationChannel; enabled: boolean }>,
      o?: Sig,
    ) =>
      r<T.NotificationPreferences>(
        'PUT',
        '/v1/notifications/preferences',
        opt(o, { body: { items } }),
      ),
    resetPreference: (key: string, o?: Sig) =>
      r<void>('DELETE', `/v1/notifications/preferences/${enc(key)}`, opt(o)),
    updateSettings: (input: T.NotificationSettingsInput, o?: Sig) =>
      r<T.NotificationSettings>('PUT', '/v1/notifications/settings', opt(o, { body: input })),
  };

  // ------------------------------------------------------------------ media
  const media = {
    /** Simple single-request upload (up to the API's per-kind size limit). Use the resumable flow for large video/audio. */
    upload: (
      file: Blob,
      opts: {
        fileName?: string;
        altText?: string;
        decorative?: boolean;
        purpose?: 'attachment' | 'public';
      } = {},
      o?: Sig,
    ) => {
      const form = new FormData();
      form.append('file', file, opts.fileName ?? 'upload');
      if (opts.altText) form.append('altText', opts.altText);
      if (opts.decorative !== undefined) form.append('decorative', String(opts.decorative));
      if (opts.purpose) form.append('purpose', opts.purpose);
      return r<T.MediaObject>('POST', '/v1/media', opt(o, { body: form }));
    },
    get: (id: string, o?: Sig) => r<T.MediaObject>('GET', `/v1/media/${enc(id)}`, opt(o)),
    update: (id: string, input: { altText?: string | null; decorative?: boolean }, o?: Sig) =>
      r<{ updated: boolean }>('PATCH', `/v1/media/${enc(id)}`, opt(o, { body: input })),
    delete: (id: string, o?: Sig) => r<void>('DELETE', `/v1/media/${enc(id)}`, opt(o)),
  };

  // ------------------------------------------------------------------ moments
  const moments = {
    create: (input: T.CreateMomentInput, o?: Sig) =>
      r<T.Moment>('POST', '/v1/moments', opt(o, { body: input })),
    tray: (limit?: number, o?: Sig) =>
      r<T.MomentTray>('GET', '/v1/moments/tray', opt(o, { query: { limit } })),
    get: (id: string, o?: Sig) => r<T.Moment>('GET', `/v1/moments/${enc(id)}`, opt(o)),
    byUser: (username: string, p?: PageParams) =>
      r<T.Page<T.Moment>>(
        'GET',
        `/v1/users/${enc(username)}/moments`,
        opt(p, { query: pageQuery(p) }),
      ),
    view: (id: string, o?: Sig) =>
      r<{ counted: boolean }>('POST', `/v1/moments/${enc(id)}/view`, opt(o)),
    viewers: (id: string, p?: PageParams) =>
      r<
        T.Page<{
          id: string;
          username: string;
          displayName: string;
          avatarUrl: string | null;
          viewedAt: string;
        }>
      >('GET', `/v1/moments/${enc(id)}/viewers`, opt(p, { query: pageQuery(p) })),
    delete: (id: string, o?: Sig) => r<void>('DELETE', `/v1/moments/${enc(id)}`, opt(o)),
    react: (id: string, kind: T.ReactionKind = 'like', o?: Sig) =>
      r<unknown>('PUT', `/v1/moments/${enc(id)}/reaction`, opt(o, { body: { kind } })),
    unreact: (id: string, o?: Sig) =>
      r<unknown>('DELETE', `/v1/moments/${enc(id)}/reaction`, opt(o)),
  };

  // ------------------------------------------------------------------ events
  const events = {
    list: (
      p?: PageParams & {
        q?: string;
        topic?: string;
        communityId?: string;
        hostId?: string;
        businessId?: string;
        placeId?: string;
        online?: boolean;
        free?: boolean;
        from?: string;
        to?: string;
      },
    ) =>
      r<T.Page<T.EventSummary>>(
        'GET',
        '/v1/events',
        opt(p, {
          query: {
            ...pageQuery(p),
            q: p?.q,
            topic: p?.topic,
            communityId: p?.communityId,
            hostId: p?.hostId,
            businessId: p?.businessId,
            placeId: p?.placeId,
            online: p?.online === undefined ? undefined : String(p.online),
            free: p?.free === undefined ? undefined : String(p.free),
            from: p?.from,
            to: p?.to,
          },
        }),
      ),
    nearby: (
      p: PageParams & {
        lat: number;
        lng: number;
        radiusKm?: number;
        when?:
          | 'today'
          | 'tonight'
          | 'tomorrow'
          | 'this_weekend'
          | 'next_weekend'
          | 'this_week'
          | 'next_week';
        tz?: string;
      },
    ) =>
      r<T.Page<T.EventSummary> & { window?: T.SearchTimeWindow }>(
        'GET',
        '/v1/discover/events',
        opt(p, {
          query: {
            ...pageQuery(p),
            lat: p.lat,
            lng: p.lng,
            radiusKm: p.radiusKm,
            when: p.when,
            tz: p.tz,
          },
        }),
      ),
    get: (id: string, o?: Sig) => r<T.EventDetail>('GET', `/v1/events/${enc(id)}`, opt(o)),
    create: (input: T.CreateEventInput, o?: Sig) =>
      r<T.EventDetail>('POST', '/v1/events', opt(o, { body: input })),
    update: (id: string, input: T.UpdateEventInput, o?: Sig) =>
      r<{ updated: boolean }>('PATCH', `/v1/events/${enc(id)}`, opt(o, { body: input })),
    delete: (id: string, o?: Sig) => r<void>('DELETE', `/v1/events/${enc(id)}`, opt(o)),
    publish: (id: string, o?: Sig) => r<unknown>('POST', `/v1/events/${enc(id)}/publish`, opt(o)),
    cancel: (id: string, reason?: string, o?: Sig) =>
      r<unknown>(
        'POST',
        `/v1/events/${enc(id)}/cancel`,
        opt(o, { body: reason ? { reason } : {} }),
      ),
    rsvp: (id: string, status: T.RsvpStatus, ticketTypeId?: string, o?: Sig) =>
      r<{ status: string }>(
        'PUT',
        `/v1/events/${enc(id)}/rsvp`,
        opt(o, { body: ticketTypeId ? { status, ticketTypeId } : { status } }),
      ),
    withdrawRsvp: (id: string, o?: Sig) =>
      r<unknown>('DELETE', `/v1/events/${enc(id)}/rsvp`, opt(o)),
    save: (id: string, o?: Sig) =>
      r<{ saved: boolean }>('PUT', `/v1/events/${enc(id)}/save`, opt(o)),
    unsave: (id: string, o?: Sig) => r<void>('DELETE', `/v1/events/${enc(id)}/save`, opt(o)),
    myTicket: (id: string, o?: Sig) =>
      r<T.MyTicket>('GET', `/v1/events/${enc(id)}/my-ticket`, opt(o)),
    attendees: (id: string, p?: PageParams & { status?: string }) =>
      r<T.Page<T.EventAttendee> & { counts?: Record<string, number> }>(
        'GET',
        `/v1/events/${enc(id)}/attendees`,
        opt(p, { query: { ...pageQuery(p), status: p?.status } }),
      ),
    ticketTypes: (id: string, o?: Sig) =>
      r<{ items: T.EventTicketType[] }>('GET', `/v1/events/${enc(id)}/ticket-types`, opt(o)),
    createTicketType: (
      id: string,
      input: {
        name: string;
        description?: string;
        priceCents: number;
        currency?: string;
        quantity: number;
        maxPerUser?: number;
      },
      o?: Sig,
    ) =>
      r<T.EventTicketType>('POST', `/v1/events/${enc(id)}/ticket-types`, opt(o, { body: input })),
    cohosts: (id: string, o?: Sig) =>
      r<{
        items: Array<{
          id: string;
          username: string;
          displayName: string;
          avatarUrl: string | null;
        }>;
      }>('GET', `/v1/events/${enc(id)}/cohosts`, opt(o)),
    addCohost: (id: string, userId: string, o?: Sig) =>
      r<unknown>('POST', `/v1/events/${enc(id)}/cohosts`, opt(o, { body: { userId } })),
    removeCohost: (id: string, userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/events/${enc(id)}/cohosts/${enc(userId)}`, opt(o)),
    share: (id: string, o?: Sig) =>
      r<{
        url: string;
        calendarUrl: string;
        title: string;
        text: string;
        audience: T.EventVisibility;
        note: string | null;
      }>('GET', `/v1/events/${enc(id)}/share`, opt(o)),
    /** Path for the calendar file relative to the API origin (fetched by the browser directly; no JSON body). */
    calendarIcsUrl: (id: string) => `/v1/events/${enc(id)}/calendar.ics`,
    posts: (id: string, p?: PageParams) =>
      r<T.Page<T.Post>>('GET', `/v1/events/${enc(id)}/posts`, opt(p, { query: pageQuery(p) })),
    mine: (
      role: 'hosting' | 'attending' | 'interested' | 'waitlist' | 'saved' | 'invited' | 'past',
      p?: PageParams,
    ) =>
      r<T.Page<T.EventSummary>>(
        'GET',
        '/v1/me/events',
        opt(p, { query: { ...pageQuery(p), role } }),
      ),
    invitations: (p?: PageParams) =>
      r<T.Page<T.EventSummary>>('GET', '/v1/me/event-invitations', opt(p, { query: pageQuery(p) })),
  };

  // ------------------------------------------------------------------ places
  const places = {
    list: (
      p?: PageParams & { q?: string; kind?: T.PlaceKind; city?: string; businessId?: string },
    ) =>
      r<T.Page<T.Place>>(
        'GET',
        '/v1/places',
        opt(p, {
          query: {
            ...pageQuery(p),
            q: p?.q,
            kind: p?.kind,
            city: p?.city,
            businessId: p?.businessId,
          },
        }),
      ),
    nearby: (
      p: PageParams & {
        lat: number;
        lng: number;
        radiusKm?: number;
        kind?: T.PlaceKind;
        q?: string;
        openNow?: boolean;
        minRating?: number;
      },
    ) =>
      r<T.Page<T.Place>>(
        'GET',
        '/v1/places/nearby',
        opt(p, {
          query: {
            ...pageQuery(p),
            lat: p.lat,
            lng: p.lng,
            radiusKm: p.radiusKm,
            kind: p.kind,
            q: p.q,
            openNow: p.openNow === undefined ? undefined : String(p.openNow),
            minRating: p.minRating,
          },
        }),
      ),
    get: (id: string, o?: Sig) => r<T.Place>('GET', `/v1/places/${enc(id)}`, opt(o)),
    create: (input: T.CreatePlaceInput, o?: Sig) =>
      r<T.Place>('POST', '/v1/places', opt(o, { body: input })),
    save: (id: string, o?: Sig) =>
      r<{ saved: boolean }>('PUT', `/v1/places/${enc(id)}/save`, opt(o)),
    unsave: (id: string, o?: Sig) => r<void>('DELETE', `/v1/places/${enc(id)}/save`, opt(o)),
    reviews: (id: string, p?: PageParams & { rating?: number }) =>
      r<T.Page<T.PlaceReview>>(
        'GET',
        `/v1/places/${enc(id)}/reviews`,
        opt(p, { query: { ...pageQuery(p), rating: p?.rating } }),
      ),
    addReview: (id: string, rating: number, body?: string, o?: Sig) =>
      r<T.PlaceReview>(
        'POST',
        `/v1/places/${enc(id)}/reviews`,
        opt(o, { body: body ? { rating, body } : { rating } }),
      ),
    replyToReview: (reviewId: string, body: string, o?: Sig) =>
      r<T.PlaceReview>('PUT', `/v1/reviews/${enc(reviewId)}/reply`, opt(o, { body: { body } })),
    reportReview: (reviewId: string, reason: string, o?: Sig) =>
      r<unknown>('POST', `/v1/reviews/${enc(reviewId)}/report`, opt(o, { body: { reason } })),
    claim: (id: string, businessId: string, evidence?: string, o?: Sig) =>
      r<T.PlaceClaim>(
        'POST',
        `/v1/places/${enc(id)}/claims`,
        opt(o, { body: evidence ? { businessId, evidence } : { businessId } }),
      ),
    myClaims: (p?: PageParams) =>
      r<T.Page<T.PlaceClaim>>('GET', '/v1/me/place-claims', opt(p, { query: pageQuery(p) })),
    withdrawClaim: (id: string, o?: Sig) =>
      r<unknown>('POST', `/v1/place-claims/${enc(id)}/withdraw`, opt(o)),
    events: (id: string, p?: PageParams) =>
      r<T.Page<T.EventSummary>>(
        'GET',
        `/v1/places/${enc(id)}/events`,
        opt(p, { query: pageQuery(p) }),
      ),
    photos: (id: string, o?: Sig) =>
      r<{ items: Array<{ mediaId: string; url: string; caption: string | null }> }>(
        'GET',
        `/v1/places/${enc(id)}/photos`,
        opt(o),
      ),
    addPhoto: (id: string, mediaId: string, caption?: string, o?: Sig) =>
      r<unknown>(
        'POST',
        `/v1/places/${enc(id)}/photos`,
        opt(o, { body: caption ? { mediaId, caption } : { mediaId } }),
      ),
  };

  // ------------------------------------------------------------------ business
  const business = {
    list: (p?: PageParams & { q?: string; category?: string; verified?: boolean }) =>
      r<T.Page<T.Business>>(
        'GET',
        '/v1/businesses',
        opt(p, {
          query: {
            ...pageQuery(p),
            q: p?.q,
            category: p?.category,
            verified: p?.verified === undefined ? undefined : String(p.verified),
          },
        }),
      ),
    get: (ref: string, o?: Sig) => r<T.Business>('GET', `/v1/businesses/${enc(ref)}`, opt(o)),
    create: (input: T.CreateBusinessInput, o?: Sig) =>
      r<T.Business>('POST', '/v1/businesses', opt(o, { body: input })),
    mine: (o?: Sig) => r<{ items: T.Business[] }>('GET', '/v1/me/businesses', opt(o)),
    follow: (id: string, o?: Sig) =>
      r<{ following: boolean; followerCount: number }>(
        'PUT',
        `/v1/businesses/${enc(id)}/follow`,
        opt(o),
      ),
    unfollow: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/businesses/${enc(id)}/follow`, opt(o)),
    followingMine: (p?: PageParams) =>
      r<T.Page<T.Business>>('GET', '/v1/me/following-businesses', opt(p, { query: pageQuery(p) })),
    followers: (id: string, p?: PageParams) =>
      r<T.Page<T.UserCard>>(
        'GET',
        `/v1/businesses/${enc(id)}/followers`,
        opt(p, { query: pageQuery(p) }),
      ),
    offers: (id: string, o?: Sig) =>
      r<{ items: T.BusinessOffer[] }>('GET', `/v1/businesses/${enc(id)}/offers`, opt(o)),
    services: (id: string, o?: Sig) =>
      r<{ items: T.BusinessService[] }>('GET', `/v1/businesses/${enc(id)}/services`, opt(o)),
    events: (id: string, p?: PageParams) =>
      r<T.Page<T.EventSummary>>(
        'GET',
        `/v1/businesses/${enc(id)}/events`,
        opt(p, { query: pageQuery(p) }),
      ),
    posts: (id: string, p?: PageParams) =>
      r<T.Page<T.Post>>('GET', `/v1/businesses/${enc(id)}/posts`, opt(p, { query: pageQuery(p) })),
    analytics: (id: string, days?: number, o?: Sig) =>
      r<Record<string, unknown>>(
        'GET',
        `/v1/businesses/${enc(id)}/analytics`,
        opt(o, { query: { days } }),
      ),
    bookable: (id: string, o?: Sig) =>
      r<T.BookableInfo>('GET', `/v1/businesses/${enc(id)}/bookable`, opt(o)),
    bookingsReceived: (
      id: string,
      p?: PageParams & { status?: T.BookingStatus; from?: string; to?: string },
    ) =>
      r<T.Page<T.Booking>>(
        'GET',
        `/v1/businesses/${enc(id)}/bookings`,
        opt(p, { query: { ...pageQuery(p), status: p?.status, from: p?.from, to: p?.to } }),
      ),
  };

  const bookings = {
    create: (input: T.CreateBookingInput, o?: Sig) =>
      r<T.Booking>('POST', '/v1/bookings', opt(o, { body: input })),
    get: (id: string, o?: Sig) => r<T.Booking>('GET', `/v1/bookings/${enc(id)}`, opt(o)),
    mine: (p?: PageParams & { when?: 'upcoming' | 'past'; status?: T.BookingStatus }) =>
      r<T.Page<T.Booking>>(
        'GET',
        '/v1/me/bookings',
        opt(p, { query: { ...pageQuery(p), when: p?.when, status: p?.status } }),
      ),
    confirm: (id: string, o?: Sig) =>
      r<T.Booking>('POST', `/v1/bookings/${enc(id)}/confirm`, opt(o)),
    decline: (id: string, reason?: string, o?: Sig) =>
      r<T.Booking>(
        'POST',
        `/v1/bookings/${enc(id)}/decline`,
        opt(o, { body: reason ? { reason } : {} }),
      ),
    cancel: (id: string, reason?: string, o?: Sig) =>
      r<T.Booking>(
        'POST',
        `/v1/bookings/${enc(id)}/cancel`,
        opt(o, { body: reason ? { reason } : {} }),
      ),
    complete: (id: string, o?: Sig) =>
      r<T.Booking>('POST', `/v1/bookings/${enc(id)}/complete`, opt(o)),
    noShow: (id: string, o?: Sig) =>
      r<T.Booking>('POST', `/v1/bookings/${enc(id)}/no-show`, opt(o)),
  };

  // ------------------------------------------------------------------ commerce (products, orders)
  const commerce = {
    products: (
      p?: PageParams & {
        q?: string;
        kind?: T.ProductKind;
        businessId?: string;
        sellerId?: string;
        minPriceCents?: number;
        maxPriceCents?: number;
      },
    ) =>
      r<T.Page<T.Product>>(
        'GET',
        '/v1/products',
        opt(p, {
          query: {
            ...pageQuery(p),
            q: p?.q,
            kind: p?.kind,
            businessId: p?.businessId,
            sellerId: p?.sellerId,
            minPriceCents: p?.minPriceCents,
            maxPriceCents: p?.maxPriceCents,
          },
        }),
      ),
    myProducts: (p?: PageParams & { businessId?: string; status?: T.ProductStatus }) =>
      r<T.Page<T.Product>>(
        'GET',
        '/v1/me/products',
        opt(p, {
          query: { ...pageQuery(p), businessId: p?.businessId, status: p?.status },
        }),
      ),
    get: (id: string, o?: Sig) => r<T.Product>('GET', `/v1/products/${enc(id)}`, opt(o)),
    create: (input: T.CreateProductInput, o?: Sig) =>
      r<T.Product>('POST', '/v1/products', opt(o, { body: input })),
    update: (id: string, input: T.UpdateProductInput, o?: Sig) =>
      r<T.Product>('PATCH', `/v1/products/${enc(id)}`, opt(o, { body: input })),
    delete: (id: string, o?: Sig) => r<void>('DELETE', `/v1/products/${enc(id)}`, opt(o)),
    setMedia: (id: string, mediaIds: string[], o?: Sig) =>
      r<T.Product>('PUT', `/v1/products/${enc(id)}/media`, opt(o, { body: { mediaIds } })),
    setFiles: (id: string, mediaIds: string[], o?: Sig) =>
      r<T.Product>('PUT', `/v1/products/${enc(id)}/files`, opt(o, { body: { mediaIds } })),
    downloads: (id: string, o?: Sig) =>
      r<{
        items: Array<{
          id: string;
          mimeType: string;
          sizeBytes: number;
          url: string;
          expiresAt: string;
        }>;
      }>('GET', `/v1/products/${enc(id)}/downloads`, opt(o)),
    reviews: (id: string, p?: PageParams) =>
      r<T.Page<T.ProductReview>>(
        'GET',
        `/v1/products/${enc(id)}/reviews`,
        opt(p, { query: pageQuery(p) }),
      ),
    review: (id: string, input: { rating: number; body?: string }, o?: Sig) =>
      r<{ id: string }>('POST', `/v1/products/${enc(id)}/reviews`, opt(o, { body: input })),
    updateReview: (id: string, patch: { rating?: number; body?: string }, o?: Sig) =>
      r<{ id: string }>('PATCH', `/v1/products/${enc(id)}/reviews/mine`, opt(o, { body: patch })),
    deleteReview: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/products/${enc(id)}/reviews/mine`, opt(o)),

    // -------------------------------------------------------------- orders
    createOrder: (input: T.CreateOrderInput, o?: Sig & Idem) =>
      r<{ order: T.Order; held: boolean; replayed: boolean }>(
        'POST',
        '/v1/orders',
        opt(o, {
          body: input,
          headers: { 'idempotency-key': o?.idempotencyKey ?? newIdempotencyKey() },
        }),
      ),
    orders: (p?: PageParams & { status?: T.OrderStatus }) =>
      r<T.Page<T.Order>>(
        'GET',
        '/v1/orders',
        opt(p, { query: { ...pageQuery(p), status: p?.status } }),
      ),
    sellerOrders: (p?: PageParams & { businessId?: string; status?: T.OrderStatus }) =>
      r<T.Page<T.Order>>(
        'GET',
        '/v1/seller/orders',
        opt(p, { query: { ...pageQuery(p), businessId: p?.businessId, status: p?.status } }),
      ),
    getOrder: (id: string, o?: Sig) => r<T.Order>('GET', `/v1/orders/${enc(id)}`, opt(o)),
    cancelOrder: (id: string, o?: Sig) =>
      r<T.Order>('POST', `/v1/orders/${enc(id)}/cancel`, opt(o)),
    fulfilOrder: (
      id: string,
      input: {
        carrier?: string;
        trackingNumber?: string;
        trackingUrl?: string;
        note?: string;
      } = {},
      o?: Sig,
    ) => r<T.Order>('POST', `/v1/orders/${enc(id)}/fulfil`, opt(o, { body: input })),
    completeOrder: (id: string, o?: Sig) =>
      r<T.Order>('POST', `/v1/orders/${enc(id)}/complete`, opt(o)),
  };

  // ------------------------------------------------------------------ payments
  const payments = {
    /** Pay for an order with an opaque provider payment-method token (never raw card details). */
    pay: (
      id: string,
      input: { paymentMethod?: T.PaymentMethodToken; returnUrl?: string },
      o?: Sig & Idem,
    ) =>
      r<{ payment: T.Payment; nextAction: T.PaymentNextAction | null; order: T.Order }>(
        'POST',
        `/v1/orders/${enc(id)}/pay`,
        opt(o, {
          body: input,
          headers: { 'idempotency-key': o?.idempotencyKey ?? newIdempotencyKey() },
        }),
      ),
    confirm: (
      id: string,
      input: { paymentMethod?: T.PaymentMethodToken; returnUrl?: string },
      o?: Sig,
    ) =>
      r<{ payment: T.Payment; nextAction: T.PaymentNextAction | null; order: T.Order | null }>(
        'POST',
        `/v1/payments/${enc(id)}/confirm`,
        opt(o, { body: input }),
      ),
    get: (id: string, o?: Sig) => r<T.Payment>('GET', `/v1/payments/${enc(id)}`, opt(o)),

    // -------------------------------------------------------------- refunds
    requestRefund: (
      orderId: string,
      input: { amountCents?: number; itemId?: string; reason: string; restock?: boolean },
      o?: Sig & Idem,
    ) =>
      r<T.Refund>(
        'POST',
        `/v1/orders/${enc(orderId)}/refunds`,
        opt(o, {
          body: input,
          headers: o?.idempotencyKey ? { 'idempotency-key': o.idempotencyKey } : undefined,
        }),
      ),
    orderRefunds: (orderId: string, o?: Sig) =>
      r<{ items: T.Refund[] }>('GET', `/v1/orders/${enc(orderId)}/refunds`, opt(o)),
    sellerRefunds: (p?: PageParams & { businessId?: string; status?: T.RefundStatus }) =>
      r<T.Page<T.Refund>>(
        'GET',
        '/v1/seller/refunds',
        opt(p, { query: { ...pageQuery(p), businessId: p?.businessId, status: p?.status } }),
      ),
    approveRefund: (id: string, input: { note?: string; restock?: boolean } = {}, o?: Sig) =>
      r<T.Refund>('POST', `/v1/refunds/${enc(id)}/approve`, opt(o, { body: input })),
    denyRefund: (id: string, input: { note?: string } = {}, o?: Sig) =>
      r<T.Refund>('POST', `/v1/refunds/${enc(id)}/deny`, opt(o, { body: input })),

    // -------------------------------------------------------------- payout accounts and payouts (seller dashboard)
    createPayoutAccount: (
      input: { businessId?: string; country: string; email?: string; returnUrl?: string },
      o?: Sig,
    ) => r<T.PayoutAccount>('POST', '/v1/payout-accounts', opt(o, { body: input })),
    payoutAccount: (p?: { businessId?: string } & Sig) =>
      r<{ account: T.PayoutAccount | null }>(
        'GET',
        '/v1/payout-accounts',
        opt(p, { query: { businessId: p?.businessId } }),
      ),
    refreshPayoutAccount: (id: string, o?: Sig) =>
      r<T.PayoutAccount>('POST', `/v1/payout-accounts/${enc(id)}/refresh`, opt(o)),
    balance: (p?: { businessId?: string } & Sig) =>
      r<T.PayoutBalance>(
        'GET',
        '/v1/payouts/balance',
        opt(p, { query: { businessId: p?.businessId } }),
      ),
    requestPayout: (
      input: { businessId?: string; currency: string; amountCents?: number },
      o?: Sig & Idem,
    ) =>
      r<T.Payout>(
        'POST',
        '/v1/payouts',
        opt(o, {
          body: input,
          headers: { 'idempotency-key': o?.idempotencyKey ?? newIdempotencyKey() },
        }),
      ),
    payouts: (p?: { businessId?: string } & Sig) =>
      r<{ items: T.Payout[] }>(
        'GET',
        '/v1/payouts',
        opt(p, { query: { businessId: p?.businessId } }),
      ),
  };

  // ------------------------------------------------------------------ AI platform
  const ai = {
    status: (o?: Sig) => r<T.AiStatus>('GET', '/v1/ai/status', opt(o)),
    agents: (o?: Sig) => r<{ items: T.AiAgent[] }>('GET', '/v1/ai/agents', opt(o)),

    /** Non-streaming by default: pass `{ stream: true }` for server-sent events (not consumed by this client yet). */
    chat: (input: T.AiChatInput, o?: Sig) =>
      r<T.AiChatResult>('POST', '/v1/ai/chat', opt(o, { body: { ...input, stream: false } })),
    conversations: (p?: PageParams) =>
      r<T.Page<T.AiConversationSummary>>(
        'GET',
        '/v1/ai/conversations',
        opt(p, { query: pageQuery(p) }),
      ),
    messages: (conversationId: string, o?: Sig) =>
      r<{ items: T.AiMessage[] }>(
        'GET',
        `/v1/ai/conversations/${enc(conversationId)}/messages`,
        opt(o),
      ),
    deleteConversation: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/ai/conversations/${enc(id)}`, opt(o)),
    deleteAllConversations: (o?: Sig) => r<void>('DELETE', '/v1/ai/conversations', opt(o)),

    askCommunity: (id: string, input: { question: string; conversationId?: string }, o?: Sig) =>
      r<{
        conversationId: string;
        answer: string;
        documented: boolean;
        sources: T.AiSourceRef[];
        provider: string;
        model: string | null;
        notice: string | null;
        safety: T.AiSafety;
      }>('POST', `/v1/ai/community/${enc(id)}/ask`, opt(o, { body: input })),
    askBusiness: (id: string, input: { question: string; conversationId?: string }, o?: Sig) =>
      r<{
        conversationId: string;
        answer: string;
        documented: boolean;
        sources: T.AiSourceRef[];
        provider: string;
        model: string | null;
        notice: string | null;
        safety: T.AiSafety;
      }>('POST', `/v1/ai/business/${enc(id)}/ask`, opt(o, { body: input })),

    // -------------------------------------------------------------- creator drafting tools (all create a draft artifact)
    creatorTitles: (input: { topic: string; count?: number }, o?: Sig) =>
      r<T.AiDirectResult>('POST', '/v1/ai/creator/titles', opt(o, { body: input })),
    creatorDescription: (input: { notes: string; tone?: string }, o?: Sig) =>
      r<T.AiDirectResult>('POST', '/v1/ai/creator/descriptions', opt(o, { body: input })),
    creatorCaptions: (input: { description: string; tone?: string; count?: number }, o?: Sig) =>
      r<T.AiDirectResult>('POST', '/v1/ai/creator/captions', opt(o, { body: input })),
    creatorThumbnailConcepts: (input: { topic: string; count?: number }, o?: Sig) =>
      r<T.AiDirectResult>('POST', '/v1/ai/creator/thumbnail-concepts', opt(o, { body: input })),
    creatorTranslate: (
      input: { text: string; targetLanguage: string; sourceLanguage?: string },
      o?: Sig,
    ) => r<T.AiDirectResult>('POST', '/v1/ai/creator/translate', opt(o, { body: input })),

    // -------------------------------------------------------------- artifacts (drafts): the human decides
    artifacts: (p?: { status?: 'draft' | 'confirmed' | 'discarded'; limit?: number } & Sig) =>
      r<{ items: T.AiArtifact[] }>(
        'GET',
        '/v1/ai/artifacts',
        opt(p, { query: { status: p?.status, limit: p?.limit } }),
      ),
    artifact: (id: string, o?: Sig) =>
      r<T.AiArtifact>('GET', `/v1/ai/artifacts/${enc(id)}`, opt(o)),
    editArtifact: (id: string, patch: Record<string, unknown>, o?: Sig) =>
      r<T.AiArtifact>('PATCH', `/v1/ai/artifacts/${enc(id)}`, opt(o, { body: patch })),
    /** The one explicit "make it real" action. Nothing is ever applied without calling this. */
    confirmArtifact: (id: string, input: T.AiConfirmInput = {}, o?: Sig) =>
      r<T.AiConfirmResult>('POST', `/v1/ai/artifacts/${enc(id)}/confirm`, opt(o, { body: input })),
    discardArtifact: (id: string, o?: Sig) =>
      r<void>('POST', `/v1/ai/artifacts/${enc(id)}/discard`, opt(o)),

    // -------------------------------------------------------------- memory (transparent, consented, deletable)
    memories: (o?: Sig) =>
      r<{ items: T.AiMemory[]; enabled: boolean; consented: boolean; howItWorks: string }>(
        'GET',
        '/v1/ai/memories',
        opt(o),
      ),
    createMemory: (
      input: {
        content: string;
        source?: 'user_stated' | 'user_approved_suggestion';
        sourceRef?: string;
      },
      o?: Sig,
    ) => r<T.AiMemory>('POST', '/v1/ai/memories', opt(o, { body: input })),
    deleteMemory: (id: string, o?: Sig) => r<void>('DELETE', `/v1/ai/memories/${enc(id)}`, opt(o)),
    deleteAllMemories: (o?: Sig) => r<{ deleted: number }>('DELETE', '/v1/ai/memories', opt(o)),

    // -------------------------------------------------------------- translation & language
    translate: (
      input: {
        targetType: string;
        targetId?: string;
        text?: string;
        targetLanguage: string;
        sourceLanguage?: string;
      },
      o?: Sig,
    ) => r<T.AiTranslateResult>('POST', '/v1/ai/translate', opt(o, { body: input })),
    detectLanguage: (text: string, o?: Sig) =>
      r<T.AiLanguageDetection>('POST', '/v1/ai/language/detect', opt(o, { body: { text } })),

    // -------------------------------------------------------------- transparency
    usage: (o?: Sig) => r<T.AiUsageSummary>('GET', '/v1/ai/usage', opt(o)),
    toolCalls: (p?: { outcome?: 'allowed' | 'denied' | 'error'; limit?: number } & Sig) =>
      r<{ items: T.AiToolCallRecord[] }>(
        'GET',
        '/v1/ai/tool-calls',
        opt(p, { query: { outcome: p?.outcome, limit: p?.limit } }),
      ),
  };

  // ------------------------------------------------------------------ privacy center
  const privacy = {
    overview: (o?: Sig) => r<T.PrivacyOverview>('GET', '/v1/privacy/overview', opt(o)),

    consents: (o?: Sig) => r<{ items: T.ConsentStatus[] }>('GET', '/v1/privacy/consents', opt(o)),
    setConsent: (purpose: T.ConsentPurpose, granted: boolean, o?: Sig) =>
      r<{ purpose: T.ConsentPurpose; granted: boolean; changed: boolean; label: string }>(
        'PUT',
        `/v1/privacy/consents/${enc(purpose)}`,
        opt(o, { body: { granted } }),
      ),
    consentHistory: (p?: { purpose?: string } & Sig) =>
      r<{ items: T.ConsentHistoryEntry[] }>(
        'GET',
        '/v1/privacy/consents/history',
        opt(p, { query: { purpose: p?.purpose } }),
      ),

    advertising: (o?: Sig) => r<T.AdvertisingPrefs>('GET', '/v1/privacy/advertising', opt(o)),
    updateAdvertising: (
      input: { personalizedAds?: boolean; hiddenTopics?: string[]; limitSensitive?: boolean },
      o?: Sig,
    ) => r<T.AdvertisingPrefs>('PUT', '/v1/privacy/advertising', opt(o, { body: input })),

    visibility: (o?: Sig) => r<T.VisibilityOverview>('GET', '/v1/privacy/visibility', opt(o)),

    requestExport: (input: { password?: string } = {}, o?: Sig) =>
      r<{
        requestId: string;
        status: string;
        expiresAt: string;
        sizeBytes: number;
        next: string;
      }>('POST', '/v1/privacy/export', opt(o, { body: input })),
    requests: (o?: Sig) => r<{ items: T.PrivacyRequest[] }>('GET', '/v1/privacy/requests', opt(o)),
    createDownloadLink: (requestId: string, o?: Sig) =>
      r<{ path: string; expiresAt: string }>(
        'POST',
        `/v1/privacy/requests/${enc(requestId)}/download-link`,
        opt(o),
      ),

    connectedApps: (o?: Sig) =>
      r<{ items: T.ConnectedApp[] }>('GET', '/v1/privacy/connected-apps', opt(o)),
    revokeConnectedApp: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/privacy/connected-apps/${enc(id)}`, opt(o)),
  };

  // ------------------------------------------------------------------ creator economy
  const creator = {
    join: (input: { termsVersion: string; category?: string }, o?: Sig) =>
      r<T.CreatorProfile>('POST', '/v1/creator/join', opt(o, { body: input })),
    me: (o?: Sig) => r<T.CreatorMe>('GET', '/v1/creator/me', opt(o)),
    setMode: (mode: 'creator' | 'personal', o?: Sig) =>
      r<{ mode: string }>('PUT', '/v1/creator/mode', opt(o, { body: { mode } })),
    submitKyc: (input: { country: string; returnUrl?: string }, o?: Sig) =>
      r<T.CreatorProfile & { onboardingUrl: string | null }>(
        'POST',
        '/v1/creator/kyc',
        opt(o, { body: input }),
      ),

    dashboard: (p?: { days?: number } & Sig) =>
      r<T.CreatorDashboard>('GET', '/v1/creator/dashboard', opt(p, { query: { days: p?.days } })),
    revenue: (p?: { days?: number } & Sig) =>
      r<T.CreatorRevenue>('GET', '/v1/creator/revenue', opt(p, { query: { days: p?.days } })),

    payoutBalance: (o?: Sig) =>
      r<T.CreatorPayoutBalance>('GET', '/v1/creator/payouts/balance', opt(o)),
    requestPayout: (input: { currency: string; amountCents?: number }, o?: Sig & Idem) =>
      r<T.CreatorPayout>(
        'POST',
        '/v1/creator/payouts',
        opt(o, {
          body: input,
          headers: { 'idempotency-key': o?.idempotencyKey ?? newIdempotencyKey() },
        }),
      ),
    payouts: (o?: Sig) => r<{ items: T.CreatorPayout[] }>('GET', '/v1/creator/payouts', opt(o)),

    plans: (o?: Sig) => r<{ items: T.CreatorPlan[] }>('GET', '/v1/creator/plans', opt(o)),
    createPlan: (
      input: {
        name: string;
        description?: string;
        priceCents: number;
        currency: string;
        interval: T.SubscriptionInterval;
        tier?: number;
        benefits?: string[];
      },
      o?: Sig,
    ) => r<T.CreatorPlan>('POST', '/v1/creator/plans', opt(o, { body: input })),
    updatePlan: (
      id: string,
      patch: { name?: string; description?: string; benefits?: string[]; active?: boolean },
      o?: Sig,
    ) => r<T.CreatorPlan>('PATCH', `/v1/creator/plans/${enc(id)}`, opt(o, { body: patch })),

    subscribers: (p?: { status?: string } & Sig) =>
      r<{ items: T.CreatorSubscriber[] }>(
        'GET',
        '/v1/creator/subscribers',
        opt(p, { query: { status: p?.status } }),
      ),
    removeSubscriber: (id: string, o?: Sig) =>
      r<T.CreatorSubscription>('POST', `/v1/creator/subscribers/${enc(id)}/cancel`, opt(o)),

    mySubscriptions: (o?: Sig) =>
      r<{ items: T.CreatorSubscription[] }>('GET', '/v1/me/subscriptions', opt(o)),
    cancelSubscription: (id: string, input: { immediately?: boolean } = {}, o?: Sig) =>
      r<T.CreatorSubscription>(
        'POST',
        `/v1/subscriptions/${enc(id)}/cancel`,
        opt(o, { body: input }),
      ),
    resumeSubscription: (id: string, o?: Sig) =>
      r<T.CreatorSubscription>('POST', `/v1/subscriptions/${enc(id)}/resume`, opt(o)),

    supporters: (o?: Sig) =>
      r<{ tips: T.CreatorSupporterTip[]; gifts: T.CreatorSupporterGift[] }>(
        'GET',
        '/v1/creator/supporters',
        opt(o),
      ),
    giftCatalog: (o?: Sig) => r<{ items: T.GiftCatalogItem[] }>('GET', '/v1/gifts/catalog', opt(o)),

    affiliateLinks: (o?: Sig) =>
      r<{ items: T.AffiliateLinkStats[]; attribution: string }>(
        'GET',
        '/v1/creator/affiliate/links',
        opt(o),
      ),
    createAffiliateLink: (input: { productId: string; commissionBps: number }, o?: Sig) =>
      r<T.AffiliateLink>('POST', '/v1/creator/affiliate/links', opt(o, { body: input })),
    setAffiliateLinkActive: (id: string, active: boolean, o?: Sig) =>
      r<T.AffiliateLink>(
        'PATCH',
        `/v1/creator/affiliate/links/${enc(id)}`,
        opt(o, { body: { active } }),
      ),
    affiliateConversions: (o?: Sig) =>
      r<{ items: T.AffiliateConversion[] }>('GET', '/v1/creator/affiliate/conversions', opt(o)),
    setProductAffiliateOptIn: (productId: string, maxBps: number, o?: Sig) =>
      r<{ productId: string; maxBps: number }>(
        'PUT',
        `/v1/products/${enc(productId)}/affiliate`,
        opt(o, { body: { maxBps } }),
      ),

    partnerships: (o?: Sig) =>
      r<{ items: T.Partnership[] }>('GET', '/v1/creator/partnerships', opt(o)),
    partnership: (id: string, o?: Sig) =>
      r<T.Partnership>('GET', `/v1/partnerships/${enc(id)}`, opt(o)),
    proposePartnership: (
      input: {
        businessId: string;
        title: string;
        brief?: string;
        amountCents: number;
        currency: string;
        deliverables: Array<{ title: string; kind?: string; dueAt?: string }>;
      },
      o?: Sig,
    ) => r<T.Partnership>('POST', '/v1/creator/partnerships', opt(o, { body: input })),
    counterPartnership: (
      id: string,
      input: {
        title?: string;
        brief?: string;
        amountCents?: number;
        currency?: string;
        deliverables?: Array<{ title: string; kind?: string; dueAt?: string }>;
        note?: string;
      },
      o?: Sig,
    ) => r<T.Partnership>('POST', `/v1/partnerships/${enc(id)}/counter`, opt(o, { body: input })),
    acceptPartnership: (id: string, expectedVersion?: number, o?: Sig) =>
      r<T.Partnership>(
        'POST',
        `/v1/partnerships/${enc(id)}/accept`,
        opt(o, { body: { expectedVersion } }),
      ),
    declinePartnership: (id: string, note?: string, o?: Sig) =>
      r<T.Partnership>('POST', `/v1/partnerships/${enc(id)}/decline`, opt(o, { body: { note } })),
    startPartnership: (id: string, o?: Sig) =>
      r<T.Partnership>('POST', `/v1/partnerships/${enc(id)}/start`, opt(o, { body: {} })),
    cancelPartnership: (id: string, note?: string, o?: Sig) =>
      r<T.Partnership>('POST', `/v1/partnerships/${enc(id)}/cancel`, opt(o, { body: { note } })),
    submitDeliverable: (id: string, deliverableId: string, postId: string, o?: Sig) =>
      r<T.Partnership>(
        'POST',
        `/v1/partnerships/${enc(id)}/deliverables/${enc(deliverableId)}/submit`,
        opt(o, { body: { postId } }),
      ),
  };

  // ------------------------------------------------------------------ creator studio
  const studio = {
    status: (o?: Sig) => r<T.StudioCapabilities>('GET', '/v1/studio/status', opt(o)),
    validateEdl: (input: { edl: unknown; durationMs: number; kind?: 'video' | 'audio' }, o?: Sig) =>
      r<{ valid: boolean; issues: T.StudioEdlIssue[] }>(
        'POST',
        '/v1/studio/edl/validate',
        opt(o, { body: input }),
      ),
    validateCaptions: (input: { cues?: T.StudioCue[]; vtt?: string; srt?: string }, o?: Sig) =>
      r<{ valid: boolean; cues: number; error?: string; issues: unknown[] }>(
        'POST',
        '/v1/studio/captions/validate',
        opt(o, { body: input }),
      ),

    createProject: (input: { title: string; mediaId: string; description?: string }, o?: Sig) =>
      r<T.StudioProject>('POST', '/v1/studio/projects', opt(o, { body: input })),
    projects: (o?: Sig) => r<{ items: T.StudioProject[] }>('GET', '/v1/studio/projects', opt(o)),
    project: (id: string, o?: Sig) =>
      r<T.StudioProject>('GET', `/v1/studio/projects/${enc(id)}`, opt(o)),
    updateProject: (id: string, patch: { title?: string; description?: string }, o?: Sig) =>
      r<T.StudioProject>('PATCH', `/v1/studio/projects/${enc(id)}`, opt(o, { body: patch })),
    deleteProject: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/studio/projects/${enc(id)}`, opt(o)),

    setEdl: (id: string, edl: unknown, expectedVersion?: number, o?: Sig) =>
      r<T.StudioProject>(
        'PUT',
        `/v1/studio/projects/${enc(id)}/edl`,
        opt(o, { body: { edl, expectedVersion } }),
      ),

    captionTracks: (id: string, o?: Sig) =>
      r<{ items: T.StudioCaptionTrack[] }>(
        'GET',
        `/v1/studio/projects/${enc(id)}/captions`,
        opt(o),
      ),
    captionTrack: (id: string, lang: string, o?: Sig) =>
      r<T.StudioCaptionTrackDetail>(
        'GET',
        `/v1/studio/projects/${enc(id)}/captions/${enc(lang)}`,
        opt(o),
      ),
    putCaptionTrack: (
      id: string,
      lang: string,
      input: {
        label?: string;
        kind?: 'captions' | 'subtitles';
        cues?: T.StudioCue[];
        vtt?: string;
        srt?: string;
      },
      o?: Sig,
    ) =>
      r<T.StudioCaptionTrack>(
        'PUT',
        `/v1/studio/projects/${enc(id)}/captions/${enc(lang)}`,
        opt(o, { body: input }),
      ),
    deleteCaptionTrack: (id: string, lang: string, o?: Sig) =>
      r<void>('DELETE', `/v1/studio/projects/${enc(id)}/captions/${enc(lang)}`, opt(o)),
    transcribe: (id: string, language?: string, o?: Sig) =>
      r<T.StudioCaptionTrack>(
        'POST',
        `/v1/studio/projects/${enc(id)}/transcribe`,
        opt(o, { body: { language } }),
      ),

    render: (id: string, o?: Sig) =>
      r<{
        job: T.StudioRenderJob;
        project: T.StudioProject;
        outputMediaId: string | null;
        reused: boolean;
      }>('POST', `/v1/studio/projects/${enc(id)}/render`, opt(o, { body: {} })),
    renders: (id: string, o?: Sig) =>
      r<{ items: T.StudioRenderJob[] }>('GET', `/v1/studio/projects/${enc(id)}/renders`, opt(o)),

    generateSuggestions: (
      id: string,
      input: { kinds: T.StudioSuggestionKind[]; lang?: string },
      o?: Sig,
    ) =>
      r<{ items: T.StudioSuggestion[]; skipped: Array<{ kind: string; reason: string }> }>(
        'POST',
        `/v1/studio/projects/${enc(id)}/suggestions`,
        opt(o, { body: input }),
      ),
    suggestions: (id: string, o?: Sig) =>
      r<{ items: T.StudioSuggestion[] }>(
        'GET',
        `/v1/studio/projects/${enc(id)}/suggestions`,
        opt(o),
      ),
    acceptSuggestion: (
      id: string,
      sid: string,
      input: { index?: number; text?: string } = {},
      o?: Sig,
    ) =>
      r<T.StudioProject>(
        'POST',
        `/v1/studio/projects/${enc(id)}/suggestions/${enc(sid)}/accept`,
        opt(o, { body: input }),
      ),
    dismissSuggestion: (id: string, sid: string, o?: Sig) =>
      r<T.StudioSuggestion>(
        'POST',
        `/v1/studio/projects/${enc(id)}/suggestions/${enc(sid)}/dismiss`,
        opt(o, { body: {} }),
      ),

    publish: (
      id: string,
      input: {
        confirm: boolean;
        mode?: 'now' | 'scheduled';
        publishAt?: string;
        body?: string;
        visibility?: string;
        circleId?: string;
        audience?: string[];
        topics?: string[];
        language?: string;
        license?: string;
      },
      o?: Sig,
    ) =>
      r<{ publication: T.StudioPublication; postId: string | null }>(
        'POST',
        `/v1/studio/projects/${enc(id)}/publish`,
        opt(o, { body: input }),
      ),
    publication: (id: string, o?: Sig) =>
      r<{ publication: T.StudioPublication | null }>(
        'GET',
        `/v1/studio/projects/${enc(id)}/publication`,
        opt(o),
      ),
    cancelPublication: (id: string, o?: Sig) =>
      r<T.StudioPublication>('DELETE', `/v1/studio/projects/${enc(id)}/publication`, opt(o)),
  };

  // ------------------------------------------------------------------ live
  const live = {
    list: (
      p?: {
        status?: 'live' | 'scheduled' | 'ended';
        hostId?: string;
        limit?: number;
        before?: string;
      } & Sig,
    ) =>
      r<{ items: T.LiveSession[] }>(
        'GET',
        '/v1/live',
        opt(p, {
          query: { status: p?.status, hostId: p?.hostId, limit: p?.limit, before: p?.before },
        }),
      ),
    mine: (o?: Sig) => r<{ items: T.LiveSession[] }>('GET', '/v1/live/mine', opt(o)),
    create: (
      input: {
        title: string;
        description?: string;
        visibility?: T.LiveVisibility;
        mediaMode?: T.LiveMediaMode;
        scheduledFor?: string;
        ticketTypeId?: string;
        language?: string;
      },
      o?: Sig,
    ) => r<T.LiveSession>('POST', '/v1/live', opt(o, { body: input })),
    get: (id: string, o?: Sig) => r<T.LiveSession>('GET', `/v1/live/${enc(id)}`, opt(o)),
    update: (
      id: string,
      patch: {
        title?: string;
        description?: string;
        scheduledFor?: string | null;
        language?: string | null;
      },
      o?: Sig,
    ) => r<T.LiveSession>('PATCH', `/v1/live/${enc(id)}`, opt(o, { body: patch })),
    updateSettings: (
      id: string,
      patch: { chatEnabled?: boolean; slowModeSec?: number; blockedTerms?: string[] },
      o?: Sig,
    ) => r<T.LiveSession>('PATCH', `/v1/live/${enc(id)}/settings`, opt(o, { body: patch })),
    start: (id: string, o?: Sig) =>
      r<{ session: T.LiveSession; ingest: unknown }>(
        'POST',
        `/v1/live/${enc(id)}/start`,
        opt(o, { body: {} }),
      ),
    end: (id: string, reason?: string, o?: Sig) =>
      r<T.LiveSession>('POST', `/v1/live/${enc(id)}/end`, opt(o, { body: { reason } })),
    cancel: (id: string, o?: Sig) =>
      r<T.LiveSession>('POST', `/v1/live/${enc(id)}/cancel`, opt(o, { body: {} })),

    team: (id: string, o?: Sig) =>
      r<{ items: T.LiveTeamMember[] }>('GET', `/v1/live/${enc(id)}/team`, opt(o)),
    setTeamMember: (id: string, userId: string, role: 'cohost' | 'moderator', o?: Sig) =>
      r<{ items: T.LiveTeamMember[] }>(
        'PUT',
        `/v1/live/${enc(id)}/team/${enc(userId)}`,
        opt(o, { body: { role } }),
      ),
    removeTeamMember: (id: string, userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/live/${enc(id)}/team/${enc(userId)}`, opt(o)),

    join: (id: string, o?: Sig) =>
      r<T.LiveJoinResult>('POST', `/v1/live/${enc(id)}/join`, opt(o, { body: {} })),
    leave: (id: string, o?: Sig) =>
      r<void>('POST', `/v1/live/${enc(id)}/leave`, opt(o, { body: {} })),

    messages: (id: string, p?: { limit?: number; before?: string } & Sig) =>
      r<{ items: T.LiveMessage[]; nextBefore: string | null }>(
        'GET',
        `/v1/live/${enc(id)}/messages`,
        opt(p, { query: { limit: p?.limit, before: p?.before } }),
      ),
    postMessage: (id: string, body: string, o?: Sig) =>
      r<T.LiveMessage>('POST', `/v1/live/${enc(id)}/messages`, opt(o, { body: { body } })),
    hideMessage: (id: string, mid: string, o?: Sig) =>
      r<void>('DELETE', `/v1/live/${enc(id)}/messages/${enc(mid)}`, opt(o)),

    react: (id: string, kind: T.LiveReactionKind, count = 1, o?: Sig) =>
      r<{ kind: string; total: number }>(
        'POST',
        `/v1/live/${enc(id)}/reactions`,
        opt(o, { body: { kind, count } }),
      ),
    reactionTotals: (id: string, o?: Sig) =>
      r<{ totals: Record<string, number> }>('GET', `/v1/live/${enc(id)}/reactions`, opt(o)),

    polls: (id: string, o?: Sig) =>
      r<{ items: T.LivePoll[] }>('GET', `/v1/live/${enc(id)}/polls`, opt(o)),
    createPoll: (
      id: string,
      input: { question: string; options: string[]; multiple?: boolean },
      o?: Sig,
    ) => r<T.LivePoll>('POST', `/v1/live/${enc(id)}/polls`, opt(o, { body: input })),
    votePoll: (id: string, pollId: string, optionIds: string[], o?: Sig) =>
      r<T.LivePoll>(
        'POST',
        `/v1/live/${enc(id)}/polls/${enc(pollId)}/vote`,
        opt(o, { body: { optionIds } }),
      ),
    closePoll: (id: string, pollId: string, o?: Sig) =>
      r<T.LivePoll>('POST', `/v1/live/${enc(id)}/polls/${enc(pollId)}/close`, opt(o, { body: {} })),

    questions: (id: string, p?: { status?: 'open' | 'answered'; limit?: number } & Sig) =>
      r<{ items: T.LiveQuestion[] }>(
        'GET',
        `/v1/live/${enc(id)}/questions`,
        opt(p, { query: { status: p?.status, limit: p?.limit } }),
      ),
    askQuestion: (id: string, body: string, o?: Sig) =>
      r<T.LiveQuestion>('POST', `/v1/live/${enc(id)}/questions`, opt(o, { body: { body } })),
    upvoteQuestion: (id: string, qid: string, on: boolean, o?: Sig) =>
      r<T.LiveQuestion>(
        on ? 'PUT' : 'DELETE',
        `/v1/live/${enc(id)}/questions/${enc(qid)}/upvote`,
        opt(o),
      ),
    answerQuestion: (id: string, qid: string, answer: string, o?: Sig) =>
      r<T.LiveQuestion>(
        'POST',
        `/v1/live/${enc(id)}/questions/${enc(qid)}/answer`,
        opt(o, { body: { answer } }),
      ),
    dismissQuestion: (id: string, qid: string, o?: Sig) =>
      r<void>('DELETE', `/v1/live/${enc(id)}/questions/${enc(qid)}`, opt(o)),

    moderation: (id: string, o?: Sig) =>
      r<{ items: T.LiveModeratedEntry[] }>('GET', `/v1/live/${enc(id)}/moderation`, opt(o)),
    mute: (id: string, userId: string, minutes: number, o?: Sig) =>
      r<void>(
        'PUT',
        `/v1/live/${enc(id)}/participants/${enc(userId)}/mute`,
        opt(o, { body: { minutes } }),
      ),
    unmute: (id: string, userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/live/${enc(id)}/participants/${enc(userId)}/mute`, opt(o)),
    ban: (id: string, userId: string, reason: string, o?: Sig) =>
      r<void>(
        'PUT',
        `/v1/live/${enc(id)}/participants/${enc(userId)}/ban`,
        opt(o, { body: { reason } }),
      ),
    unban: (id: string, userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/live/${enc(id)}/participants/${enc(userId)}/ban`, opt(o)),

    products: (id: string, o?: Sig) =>
      r<{ items: T.LiveProduct[]; pinned: T.LiveProduct | null }>(
        'GET',
        `/v1/live/${enc(id)}/products`,
        opt(o),
      ),
    addProduct: (id: string, productId: string, o?: Sig) =>
      r<{ items: T.LiveProduct[]; pinned: T.LiveProduct | null }>(
        'PUT',
        `/v1/live/${enc(id)}/products/${enc(productId)}`,
        opt(o, { body: {} }),
      ),
    removeProduct: (id: string, productId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/live/${enc(id)}/products/${enc(productId)}`, opt(o)),
    pinProduct: (id: string, productId: string, o?: Sig) =>
      r<{ items: T.LiveProduct[]; pinned: T.LiveProduct | null }>(
        'PUT',
        `/v1/live/${enc(id)}/products/${enc(productId)}/pin`,
        opt(o, { body: {} }),
      ),
    unpinProduct: (id: string, productId: string, o?: Sig) =>
      r<{ items: T.LiveProduct[]; pinned: T.LiveProduct | null }>(
        'DELETE',
        `/v1/live/${enc(id)}/products/${enc(productId)}/pin`,
        opt(o),
      ),
  };

  const memory = {
    create: (
      input: {
        kind?: T.MemoryKind;
        title: string;
        summary?: string;
        dateStart?: string;
        dateEnd?: string;
        privacy?: T.MemoryPrivacy;
        items?: T.MemoryItemRef[];
        links?: T.MemoryLinkRef[];
      },
      o?: Sig,
    ) => r<T.MemoryView>('POST', '/v1/memories', opt(o, { body: input })),
    list: (
      p?: {
        kind?: T.MemoryKind;
        privacy?: T.MemoryPrivacy;
        q?: string;
        cursor?: string;
        limit?: number;
      } & Sig,
    ) =>
      r<{ items: T.MemorySummary[]; nextCursor: string | null }>(
        'GET',
        '/v1/memories',
        opt(p, {
          query: {
            kind: p?.kind,
            privacy: p?.privacy,
            q: p?.q,
            cursor: p?.cursor,
            limit: p?.limit,
          },
        }),
      ),
    byUser: (username: string, p?: { cursor?: string; limit?: number } & Sig) =>
      r<{ items: T.MemorySummary[]; nextCursor: string | null }>(
        'GET',
        `/v1/users/${enc(username)}/memories`,
        opt(p, { query: pageQuery(p) }),
      ),
    get: (id: string, o?: Sig) => r<T.MemoryView>('GET', `/v1/memories/${enc(id)}`, opt(o)),
    update: (
      id: string,
      patch: {
        title?: string;
        summary?: string;
        dateStart?: string | null;
        dateEnd?: string | null;
        privacy?: T.MemoryPrivacy;
      },
      o?: Sig,
    ) => r<T.MemoryView>('PATCH', `/v1/memories/${enc(id)}`, opt(o, { body: patch })),
    remove: (id: string, o?: Sig) => r<void>('DELETE', `/v1/memories/${enc(id)}`, opt(o)),

    addItems: (id: string, items: T.MemoryItemRef[], o?: Sig) =>
      r<{ added: number }>('POST', `/v1/memories/${enc(id)}/items`, opt(o, { body: { items } })),
    reorderItems: (id: string, items: T.MemoryItemRef[], o?: Sig) =>
      r<void>('PUT', `/v1/memories/${enc(id)}/items/order`, opt(o, { body: { items } })),
    removeItem: (id: string, type: T.MemoryItemType, itemId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/memories/${enc(id)}/items/${enc(type)}/${enc(itemId)}`, opt(o)),
    addLinks: (id: string, links: T.MemoryLinkRef[], o?: Sig) =>
      r<T.MemoryView>('POST', `/v1/memories/${enc(id)}/links`, opt(o, { body: { links } })),
    removeLink: (id: string, type: T.MemoryLinkType, entityId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/memories/${enc(id)}/links/${enc(type)}/${enc(entityId)}`, opt(o)),

    recap: (id: string, o?: Sig) =>
      r<{ recap: T.MemoryRecap; text: string }>('GET', `/v1/memories/${enc(id)}/recap`, opt(o)),
    applyRecap: (id: string, o?: Sig) =>
      r<{ summary: string }>('POST', `/v1/memories/${enc(id)}/recap/apply`, opt(o, { body: {} })),

    timeline: (
      p?: {
        from?: string;
        to?: string;
        placeId?: string;
        eventId?: string;
        personId?: string;
        types?: T.MemoryItemType[];
        order?: 'asc' | 'desc';
        cursor?: string;
        limit?: number;
      } & Sig,
    ) =>
      r<{ items: T.MemoryTimelineEntry[]; nextCursor: string | null }>(
        'GET',
        '/v1/memory/timeline',
        opt(p, {
          query: {
            from: p?.from,
            to: p?.to,
            placeId: p?.placeId,
            eventId: p?.eventId,
            personId: p?.personId,
            types: p?.types?.join(','),
            order: p?.order,
            cursor: p?.cursor,
            limit: p?.limit,
          },
        }),
      ),
    onThisDay: (p?: { date?: string } & Sig) =>
      r<{ suggestions: T.OnThisDaySuggestion[] }>(
        'GET',
        '/v1/memory/on-this-day',
        opt(p, { query: { date: p?.date } }),
      ),
    acceptOnThisDay: (input: { date: string; year: number; title?: string }, o?: Sig) =>
      r<T.MemoryView>('POST', '/v1/memory/on-this-day/accept', opt(o, { body: input })),
    tripSuggestions: (o?: Sig) =>
      r<{ suggestions: T.MemoryTripSuggestion[] }>('GET', '/v1/memory/trips/suggestions', opt(o)),
    acceptTrip: (input: { key: string; title?: string }, o?: Sig) =>
      r<T.MemoryView>('POST', '/v1/memory/trips/accept', opt(o, { body: input })),
    dismissSuggestion: (key: string, o?: Sig) =>
      r<void>('POST', '/v1/memory/suggestions/dismiss', opt(o, { body: { key } })),

    createAiDraft: (id: string, kind: T.MemoryAiDraftKind, o?: Sig) =>
      r<T.MemoryAiDraft>('POST', `/v1/memories/${enc(id)}/ai-drafts`, opt(o, { body: { kind } })),
    aiDrafts: (id: string, o?: Sig) =>
      r<{ items: T.MemoryAiDraft[] }>('GET', `/v1/memories/${enc(id)}/ai-drafts`, opt(o)),
    confirmAiDraft: (id: string, draftId: string, text?: string, o?: Sig) =>
      r<T.MemoryView>(
        'POST',
        `/v1/memories/${enc(id)}/ai-drafts/${enc(draftId)}/confirm`,
        opt(o, { body: { text } }),
      ),
    discardAiDraft: (id: string, draftId: string, o?: Sig) =>
      r<void>(
        'POST',
        `/v1/memories/${enc(id)}/ai-drafts/${enc(draftId)}/discard`,
        opt(o, { body: {} }),
      ),

    exportSlideshow: (id: string, o?: Sig) =>
      r<T.MemorySlideshowExport>(
        'POST',
        `/v1/memories/${enc(id)}/exports/slideshow`,
        opt(o, { body: {} }),
      ),
  };

  const real = {
    startCaptureSession: (input: { deviceId: string; clientTime?: number }, o?: Sig) =>
      r<T.RealCaptureSession>('POST', '/v1/real/capture-sessions', opt(o, { body: input })),
    createCapture: (
      input: {
        captureToken: string;
        deviceId: string;
        frontMediaId?: string;
        rearMediaId?: string;
        caption?: string;
        capturedAt: string;
        latitude?: number;
        longitude?: number;
        visibility?: T.RealVisibility;
        circleId?: string;
        audience?: string[];
        edits?: string[];
        attestation?: string;
      },
      o?: Sig,
    ) => r<T.RealCapture>('POST', '/v1/real/captures', opt(o, { body: input })),
    mine: (p?: { cursor?: string; limit?: number } & Sig) =>
      r<{ items: T.RealCapture[]; nextCursor: string | null }>(
        'GET',
        '/v1/real/captures',
        opt(p, { query: pageQuery(p) }),
      ),
    tray: (p?: { limit?: number } & Sig) =>
      r<{ items: T.RealTrayGroup[] }>(
        'GET',
        '/v1/real/tray',
        opt(p, { query: { limit: p?.limit } }),
      ),
    reminders: (o?: Sig) => r<T.RealReminderSettings>('GET', '/v1/real/reminders', opt(o)),
    setReminders: (input: T.RealReminderSettings, o?: Sig) =>
      r<T.RealReminderSettings>('PUT', '/v1/real/reminders', opt(o, { body: input })),
    get: (id: string, o?: Sig) => r<T.RealCapture>('GET', `/v1/real/captures/${enc(id)}`, opt(o)),
    remove: (id: string, o?: Sig) => r<void>('DELETE', `/v1/real/captures/${enc(id)}`, opt(o)),
    react: (id: string, kind: T.RealReactionKind, o?: Sig) =>
      r<{ reactionCount: number }>(
        'PUT',
        `/v1/real/captures/${enc(id)}/reaction`,
        opt(o, { body: { kind } }),
      ),
    removeReaction: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/real/captures/${enc(id)}/reaction`, opt(o)),
    share: (
      id: string,
      input: {
        visibility: 'public' | 'followers' | 'friends' | 'circle' | 'selected' | 'private';
        circleId?: string;
        audience?: string[];
        body?: string;
        include?: 'both' | 'front' | 'rear';
        includeLocation?: boolean;
      },
      o?: Sig,
    ) =>
      r<{ postId: string }>('POST', `/v1/real/captures/${enc(id)}/share`, opt(o, { body: input })),
    postReceipt: (postId: string, o?: Sig) =>
      r<T.RealPostReceipt>('GET', `/v1/real/posts/${enc(postId)}`, opt(o)),
  };

  const together = {
    create: (
      input: {
        title: string;
        description?: string;
        eventId?: string;
        placeId?: string;
        startsAt?: string;
        endsAt?: string;
        visibility?: T.ExperienceVisibility;
      },
      o?: Sig,
    ) => r<T.TogetherExperienceView>('POST', '/v1/together', opt(o, { body: input })),
    mine: (
      p?: {
        membership?: 'joined' | 'invited';
        includeArchived?: boolean;
        cursor?: string;
        limit?: number;
      } & Sig,
    ) =>
      r<{ items: T.TogetherExperience[]; nextCursor: string | null }>(
        'GET',
        '/v1/together',
        opt(p, {
          query: {
            membership: p?.membership,
            includeArchived: p?.includeArchived,
            cursor: p?.cursor,
            limit: p?.limit,
          },
        }),
      ),
    get: (id: string, o?: Sig) =>
      r<T.TogetherExperienceView>('GET', `/v1/together/${enc(id)}`, opt(o)),
    update: (
      id: string,
      patch: {
        title?: string;
        description?: string;
        eventId?: string | null;
        placeId?: string | null;
        startsAt?: string | null;
        endsAt?: string | null;
        visibility?: T.ExperienceVisibility;
      },
      o?: Sig,
    ) => r<T.TogetherExperienceView>('PATCH', `/v1/together/${enc(id)}`, opt(o, { body: patch })),
    close: (id: string, o?: Sig) =>
      r<T.TogetherExperienceView>('POST', `/v1/together/${enc(id)}/close`, opt(o, { body: {} })),
    reopen: (id: string, o?: Sig) =>
      r<T.TogetherExperienceView>('POST', `/v1/together/${enc(id)}/reopen`, opt(o, { body: {} })),
    archive: (id: string, o?: Sig) =>
      r<T.TogetherExperienceView>('POST', `/v1/together/${enc(id)}/archive`, opt(o, { body: {} })),
    remove: (id: string, o?: Sig) => r<void>('DELETE', `/v1/together/${enc(id)}`, opt(o)),

    members: (id: string, o?: Sig) =>
      r<{ items: T.TogetherMember[] }>('GET', `/v1/together/${enc(id)}/members`, opt(o)),
    invite: (id: string, userId: string, role: 'contributor' | 'viewer' = 'contributor', o?: Sig) =>
      r<{ status: string }>(
        'POST',
        `/v1/together/${enc(id)}/members`,
        opt(o, { body: { userId, role } }),
      ),
    setMemberRole: (id: string, userId: string, role: 'contributor' | 'viewer', o?: Sig) =>
      r<void>(
        'PATCH',
        `/v1/together/${enc(id)}/members/${enc(userId)}`,
        opt(o, { body: { role } }),
      ),
    removeMember: (id: string, userId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/together/${enc(id)}/members/${enc(userId)}`, opt(o)),
    accept: (id: string, o?: Sig) =>
      r<T.TogetherExperienceView>('POST', `/v1/together/${enc(id)}/accept`, opt(o, { body: {} })),
    decline: (id: string, o?: Sig) =>
      r<T.TogetherExperienceView>('POST', `/v1/together/${enc(id)}/decline`, opt(o, { body: {} })),
    leave: (id: string, keepContributions = false, o?: Sig) =>
      r<void>('POST', `/v1/together/${enc(id)}/leave`, opt(o, { body: { keepContributions } })),
    setProfileOptIn: (id: string, show: boolean, o?: Sig) =>
      r<void>('PUT', `/v1/together/${enc(id)}/profile`, opt(o, { body: { show } })),
    suggestedInvites: (id: string, o?: Sig) =>
      r<{ suggestions: T.TogetherSuggestedInvite[]; reason: string | null }>(
        'GET',
        `/v1/together/${enc(id)}/suggested-invites`,
        opt(o),
      ),

    addContribution: (
      id: string,
      input: { mediaId?: string; realCaptureId?: string; body?: string; takenAt?: string },
      o?: Sig,
    ) =>
      r<T.TogetherContribution>(
        'POST',
        `/v1/together/${enc(id)}/contributions`,
        opt(o, { body: input }),
      ),
    timeline: (
      id: string,
      p?: { order?: 'asc' | 'desc'; contributorId?: string; cursor?: string; limit?: number } & Sig,
    ) =>
      r<{ items: T.TogetherContribution[]; nextCursor: string | null }>(
        'GET',
        `/v1/together/${enc(id)}/timeline`,
        opt(p, {
          query: {
            order: p?.order,
            contributorId: p?.contributorId,
            cursor: p?.cursor,
            limit: p?.limit,
          },
        }),
      ),
    removeContribution: (id: string, contributionId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/together/${enc(id)}/contributions/${enc(contributionId)}`, opt(o)),
    setCover: (id: string, contributionId: string | null, o?: Sig) =>
      r<{ cover: T.TogetherCover | null }>(
        'PUT',
        `/v1/together/${enc(id)}/cover`,
        opt(o, { body: { contributionId } }),
      ),
    exportAsMemory: (id: string, o?: Sig) =>
      r<{ memoryId: string }>('POST', `/v1/together/${enc(id)}/memory`, opt(o, { body: {} })),

    profileExperiences: (username: string, p?: { cursor?: string; limit?: number } & Sig) =>
      r<{ items: T.TogetherExperience[]; nextCursor: string | null }>(
        'GET',
        `/v1/users/${enc(username)}/experiences`,
        opt(p, { query: pageQuery(p) }),
      ),
  };

  // ------------------------------------------------------------------ developer platform
  const developer = {
    apps: (o?: Sig) => r<{ items: T.DeveloperApp[] }>('GET', '/v1/developer/apps', opt(o)),
    createApp: (
      input: {
        name: string;
        description?: string;
        redirectUris?: string[];
        confidential?: boolean;
        homepageUrl?: string;
        privacyUrl?: string;
      },
      o?: Sig,
    ) => r<T.DeveloperAppCreated>('POST', '/v1/developer/apps', opt(o, { body: input })),
    app: (id: string, o?: Sig) =>
      r<T.DeveloperAppDetail>('GET', `/v1/developer/apps/${enc(id)}`, opt(o)),
    updateApp: (
      id: string,
      patch: {
        name?: string;
        description?: string | null;
        redirectUris?: string[];
        homepageUrl?: string | null;
        privacyUrl?: string | null;
      },
      o?: Sig,
    ) => r<T.DeveloperApp>('PATCH', `/v1/developer/apps/${enc(id)}`, opt(o, { body: patch })),
    rotateAppSecret: (id: string, o?: Sig) =>
      r<T.RotatedClientSecret>(
        'POST',
        `/v1/developer/apps/${enc(id)}/rotate-secret`,
        opt(o, { body: {} }),
      ),
    deleteApp: (id: string, o?: Sig) => r<void>('DELETE', `/v1/developer/apps/${enc(id)}`, opt(o)),

    keys: (appId: string, o?: Sig) =>
      r<{ items: T.DeveloperApiKey[] }>('GET', `/v1/developer/apps/${enc(appId)}/keys`, opt(o)),
    createKey: (
      appId: string,
      input: {
        name?: string;
        scopes?: T.ApiKeyScope[];
        expiresInDays?: number;
        rateLimitPerMin?: number;
      },
      o?: Sig,
    ) =>
      r<T.DeveloperApiKeyCreated>(
        'POST',
        `/v1/developer/apps/${enc(appId)}/keys`,
        opt(o, { body: input }),
      ),
    revokeKey: (appId: string, keyId: string, o?: Sig) =>
      r<void>('DELETE', `/v1/developer/apps/${enc(appId)}/keys/${enc(keyId)}`, opt(o)),

    webhookEvents: (o?: Sig) =>
      r<{ items: T.WebhookEventTypeInfo[] }>('GET', '/v1/developer/webhook-events', opt(o)),
    webhooks: (appId: string, o?: Sig) =>
      r<{ items: T.DeveloperWebhook[] }>(
        'GET',
        `/v1/developer/apps/${enc(appId)}/webhooks`,
        opt(o),
      ),
    createWebhook: (
      appId: string,
      input: { url: string; events: string[]; description?: string },
      o?: Sig,
    ) =>
      r<T.DeveloperWebhookCreated>(
        'POST',
        `/v1/developer/apps/${enc(appId)}/webhooks`,
        opt(o, { body: input }),
      ),
    updateWebhook: (
      id: string,
      patch: {
        url?: string;
        events?: string[];
        description?: string | null;
        active?: boolean;
      },
      o?: Sig,
    ) =>
      r<T.DeveloperWebhook>('PATCH', `/v1/developer/webhooks/${enc(id)}`, opt(o, { body: patch })),
    rotateWebhookSecret: (id: string, o?: Sig) =>
      r<T.RotatedWebhookSecret>(
        'POST',
        `/v1/developer/webhooks/${enc(id)}/rotate-secret`,
        opt(o, { body: {} }),
      ),
    testWebhook: (id: string, o?: Sig) =>
      r<T.WebhookTestQueued>(
        'POST',
        `/v1/developer/webhooks/${enc(id)}/test`,
        opt(o, { body: {} }),
      ),
    deliveries: (id: string, p?: { cursor?: string; limit?: number } & Sig) =>
      r<{ items: T.WebhookDelivery[]; nextCursor: string | null }>(
        'GET',
        `/v1/developer/webhooks/${enc(id)}/deliveries`,
        opt(p, { query: pageQuery(p) }),
      ),
    deleteWebhook: (id: string, o?: Sig) =>
      r<void>('DELETE', `/v1/developer/webhooks/${enc(id)}`, opt(o)),
  };

  return {
    mode,
    auth,
    account,
    profile,
    topics,
    settings,
    graph,
    posts,
    comments,
    reactions,
    saves,
    polls,
    feed,
    conversations,
    messages,
    realtime,
    communities,
    meta,
    admin,
    search,
    discover,
    notifications,
    media,
    moments,
    events,
    places,
    business,
    bookings,
    commerce,
    payments,
    ai,
    privacy,
    creator,
    studio,
    live,
    memory,
    real,
    together,
    developer,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
