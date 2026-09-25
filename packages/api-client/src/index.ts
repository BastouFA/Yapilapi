import type {
  Comment,
  Community,
  Conversation,
  EventItem,
  FeedMode,
  Me,
  Message,
  NotificationItem,
  Page,
  Post,
  Profile,
  PublicUser,
} from '@yapilapi/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** Base URL, e.g. "/api" behind the web app's proxy or "https://api.yapilapi.com". */
  baseUrl: string;
  /** Bearer token for mobile / server clients. Browsers use the httpOnly cookie instead. */
  token?: string;
  fetch?: typeof fetch;
}

/** Typed client for the YAPILAPI API, shared by web, mobile and admin. */
export function createClient(opts: ClientOptions) {
  const f = opts.fetch ?? fetch;

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await f(`${opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
        credentials: 'include',
      });
    } catch {
      throw new ApiError(0, 'network', "Can't reach YAPILAPI. Check your connection and try again.");
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Something went wrong. Try again.', e.details?.fields);
    }
    return json as T;
  }

  const get = <T>(p: string) => req<T>('GET', p);
  const post = <T>(p: string, b: unknown = {}) => req<T>('POST', p, b);
  const put = <T>(p: string, b: unknown = {}) => req<T>('PUT', p, b);
  const patch = <T>(p: string, b: unknown = {}) => req<T>('PATCH', p, b);
  const del = <T>(p: string, b?: unknown) => req<T>('DELETE', p, b);
  const qs = (o: Record<string, unknown>) => {
    const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    return s ? `?${s}` : '';
  };

  return {
    raw: { get, post, put, patch, del },
    auth: {
      me: () => get<{ user: Me }>('/v1/auth/me'),
      register: (b: { email: string; password: string; username: string; displayName: string; birthDate?: string }) => post<{ user: Me; token: string }>('/v1/auth/register', b),
      login: (b: { email: string; password: string }) => post<{ user: Me; token: string }>('/v1/auth/login', b),
      logout: () => post<{ ok: true }>('/v1/auth/logout'),
      verifyEmail: (token: string) => post('/v1/auth/verify-email', { token }),
      resendVerification: () => post('/v1/auth/verify-email/resend'),
      forgot: (email: string) => post<{ message: string }>('/v1/auth/password/forgot', { email }),
      reset: (token: string, password: string) => post('/v1/auth/password/reset', { token, password }),
      sessions: () => get<{ items: { id: string; device: string; ip: string; last_seen_at: string; current: boolean }[] }>('/v1/auth/sessions'),
      revokeSession: (id: string) => del(`/v1/auth/sessions/${id}`),
      checkUsername: (username: string) => post<{ available: boolean }>('/v1/auth/check-username', { username }),
    },
    users: {
      get: (username: string) => get<{ profile: Profile }>(`/v1/users/${encodeURIComponent(username)}`),
      posts: (username: string, cursor?: string) => get<Page<Post>>(`/v1/users/${encodeURIComponent(username)}/posts${qs({ cursor })}`),
      follow: (id: string) => post(`/v1/users/${id}/follow`),
      unfollow: (id: string) => del(`/v1/users/${id}/follow`),
      friendRequest: (id: string) => post<{ status: string }>(`/v1/users/${id}/friend-request`),
      unfriend: (id: string) => del(`/v1/users/${id}/friend`),
      block: (id: string) => post(`/v1/users/${id}/block`),
      unblock: (id: string) => del(`/v1/users/${id}/block`),
      mute: (id: string) => post(`/v1/users/${id}/mute`),
      followers: (id: string) => get<Page<PublicUser>>(`/v1/users/${id}/followers`),
      following: (id: string) => get<Page<PublicUser>>(`/v1/users/${id}/following`),
    },
    me: {
      updateProfile: (b: Record<string, unknown>) => patch<{ profile: Profile }>('/v1/me/profile', b),
      setInterests: (topics: string[]) => put<{ interests: string[] }>('/v1/me/interests', { topics }),
      completeOnboarding: () => post('/v1/me/onboarding/complete'),
      suggestions: () => get<{ items: { user: PublicUser; bio: string; reason: string }[] }>('/v1/me/suggestions'),
      friendRequests: () => get<{ items: { id: string; from: PublicUser; createdAt: string }[] }>('/v1/me/friend-requests'),
      acceptFriend: (id: string) => post(`/v1/friend-requests/${id}/accept`),
      declineFriend: (id: string) => post(`/v1/friend-requests/${id}/decline`),
      preferences: () => get<{ notifications: Record<string, boolean>; attention: Record<string, unknown> }>('/v1/me/preferences'),
      setNotificationPrefs: (categories: Record<string, boolean>) => put('/v1/me/preferences/notifications', { categories }),
      setAttention: (b: Record<string, unknown>) => put('/v1/me/preferences/attention', b),
      privacy: () => get<{ consents: { purpose: string; granted: boolean }[]; dataSummary: Record<string, number>; requests: unknown[] }>('/v1/me/privacy'),
      setConsent: (purpose: string, granted: boolean) => put('/v1/me/consents', { purpose, granted }),
      exportData: () => get<Record<string, unknown>>('/v1/me/export'),
      deleteAccount: (password: string) => del('/v1/me', { password }),
      saved: () => get<{ items: Post[] }>('/v1/me/saved'),
      circles: () => get<{ items: { id: string; name: string; kind: string; memberCount: number }[] }>('/v1/me/circles'),
      moderation: () => get<{ items: { id: string; target_type: string; decision: string; status: string; appeal_status: string | null }[] }>('/v1/me/moderation'),
    },
    topics: () => get<{ items: { slug: string; name: string }[] }>('/v1/topics'),
    feed: (mode: FeedMode, cursor?: string) => get<Page<Post> & { mode: FeedMode }>(`/v1/feed${qs({ mode, cursor })}`),
    feedback: (b: { signal: string; postId?: string; authorId?: string; topic?: string }) => post('/v1/feed/feedback', b),
    posts: {
      create: (b: Record<string, unknown>) => post<{ post: Post; moderation?: { status: string; message: string } }>('/v1/posts', b),
      get: (id: string) => get<{ post: Post }>(`/v1/posts/${id}`),
      remove: (id: string) => del(`/v1/posts/${id}`),
      like: (id: string) => put<{ liked: boolean; likes: number }>(`/v1/posts/${id}/reaction`, { kind: 'like' }),
      unlike: (id: string) => del<{ liked: boolean; likes: number }>(`/v1/posts/${id}/reaction`),
      save: (id: string) => put(`/v1/posts/${id}/save`),
      unsave: (id: string) => del(`/v1/posts/${id}/save`),
      vote: (id: string, optionId: string) => post<{ poll: Post['poll'] }>(`/v1/posts/${id}/vote`, { optionId }),
      why: (id: string) => get<{ reasons: string[] }>(`/v1/posts/${id}/why`),
      comments: (id: string, cursor?: string) => get<Page<Comment>>(`/v1/posts/${id}/comments${qs({ cursor })}`),
      comment: (id: string, body: string, parentId?: string) => post<{ comment: Comment }>(`/v1/posts/${id}/comments`, { body, parentId }),
    },
    media: {
      upload: (file: File, altText?: string) => {
        const fd = new FormData();
        if (altText) fd.append('altText', altText);
        fd.append('file', file);
        return req<{ media: { id: string; kind: 'image' | 'video' | 'audio'; url: string; altText: string | null } }>('POST', '/v1/media', fd);
      },
    },
    moments: {
      list: () => get<{ items: { author: PublicUser; moments: { id: string; body: string; mediaUrl: string | null; mediaKind: string | null; expiresAt: string | null; createdAt: string }[] }[] }>('/v1/moments'),
      create: (b: Record<string, unknown>) => post('/v1/moments', b),
    },
    conversations: {
      list: () => get<{ items: Conversation[] }>('/v1/conversations'),
      get: (id: string) => get<{ conversation: Conversation }>(`/v1/conversations/${id}`),
      create: (memberIds: string[], title?: string) => post<{ conversation: Conversation }>('/v1/conversations', { memberIds, title }),
      messages: (id: string, cursor?: string) => get<Page<Message>>(`/v1/conversations/${id}/messages${qs({ cursor })}`),
      send: (id: string, body: string, clientId?: string) => post<{ message: Message }>(`/v1/conversations/${id}/messages`, { body, clientId }),
      read: (id: string) => post(`/v1/conversations/${id}/read`),
      createPlan: (id: string, title: string, details: Record<string, unknown>) => post(`/v1/conversations/${id}/plans`, { title, details }),
      plans: (id: string) => get<{ items: { id: string; title: string; details: Record<string, unknown>; status: string }[] }>(`/v1/conversations/${id}/plans`),
    },
    communities: {
      list: (scope: 'discover' | 'mine' = 'discover') => get<{ items: Community[] }>(`/v1/communities${qs({ scope })}`),
      get: (slug: string) => get<{ community: Community & { membershipStatus: string | null }; chatConversationId: string | null }>(`/v1/communities/${slug}`),
      create: (b: Record<string, unknown>) => post<{ community: Community }>('/v1/communities', b),
      join: (slug: string) => post<{ status: string }>(`/v1/communities/${slug}/join`),
      leave: (slug: string) => post(`/v1/communities/${slug}/leave`),
      posts: (slug: string, cursor?: string) => get<Page<Post> & { locked?: boolean }>(`/v1/communities/${slug}/posts${qs({ cursor })}`),
      members: (slug: string) => get<{ items: { user: PublicUser; role: string }[] }>(`/v1/communities/${slug}/members`),
    },
    events: {
      list: (scope: 'upcoming' | 'going' | 'hosting' | 'now' = 'upcoming') => get<{ items: EventItem[] }>(`/v1/events${qs({ scope })}`),
      get: (id: string) => get<{ event: EventItem }>(`/v1/events/${id}`),
      create: (b: Record<string, unknown>) => post<{ event: EventItem }>('/v1/events', b),
      rsvp: (id: string, status: 'going' | 'interested' | 'not_going') => post<{ status: string; event: EventItem }>(`/v1/events/${id}/rsvp`, { status }),
      attendees: (id: string) => get<{ items: { user: PublicUser; status: string }[] }>(`/v1/events/${id}/attendees`),
    },
    places: {
      list: (params: Record<string, unknown> = {}) => get<{ items: Record<string, any>[] }>(`/v1/places${qs(params)}`),
      get: (id: string) => get<{ place: Record<string, any>; events: EventItem[]; products: Record<string, any>[] }>(`/v1/places/${id}`),
    },
    businesses: { get: (slug: string) => get<{ business: Record<string, any>; places: Record<string, any>[]; products: Record<string, any>[] }>(`/v1/businesses/${slug}`) },
    orders: {
      create: (items: { productId: string; quantity: number }[], idempotencyKey: string) => post<{ order: Record<string, any>; payment?: { provider: string; clientSecret: string } }>('/v1/orders', { items, idempotencyKey }),
      list: () => get<{ items: Record<string, any>[] }>('/v1/orders'),
    },
    search: (q: string, type = 'all') => get<{ query: string; intent: Record<string, any>; results: Record<string, any> }>(`/v1/search${qs({ q, type })}`),
    now: () => get<{ events: EventItem[]; trendingTopics: { topic: string; posts: number }[]; activeCommunities: { slug: string; name: string; posts: number }[] }>('/v1/now'),
    notifications: {
      list: (cursor?: string) => get<Page<NotificationItem> & { unread: number }>(`/v1/notifications${qs({ cursor })}`),
      markRead: (ids?: string[]) => post('/v1/notifications/read', ids ? { ids } : {}),
    },
    reports: { create: (b: { targetType: string; targetId: string; reason: string; details?: string }) => post<{ message: string }>('/v1/reports', b) },
    ai: {
      assist: (b: { task: string; input?: string; conversationId?: string; communityId?: string; targetLanguage?: string }) =>
        post<{ output: unknown; provider: string; model: string; notice?: string; contextScopes: string[] }>('/v1/ai/assist', b),
      memories: () => get<{ items: { id: string; content: string; created_at: string }[] }>('/v1/ai/memories'),
      addMemory: (content: string) => post('/v1/ai/memories', { content }),
      deleteMemory: (id: string) => del(`/v1/ai/memories/${id}`),
    },
    creator: { analytics: () => get<{ totals: Record<string, number>; topPosts: Record<string, any>[]; followerGrowth: { day: string; new_followers: number }[] }>('/v1/creator/analytics') },
    flags: () => get<{ flags: Record<string, boolean> }>('/v1/flags'),
    admin: {
      cases: (status = 'open') => get<{ items: Record<string, any>[] }>(`/v1/admin/moderation/cases${qs({ status })}`),
      decide: (id: string, decision: string, note?: string) => post(`/v1/admin/moderation/cases/${id}/decide`, { decision, note }),
      summary: () => get<{ summary: Record<string, number>; meaningfulByAction: { name: string; n: number }[] }>('/v1/admin/analytics/summary'),
      setFlag: (key: string, enabled: boolean) => put<{ flags: Record<string, boolean> }>(`/v1/admin/flags/${key}`, { enabled }),
      users: (q = '') => get<{ items: Record<string, any>[] }>(`/v1/admin/users${qs({ q })}`),
      setUserStatus: (id: string, status: 'active' | 'suspended') => put(`/v1/admin/users/${id}/status`, { status }),
      auditLogs: () => get<{ items: Record<string, any>[] }>('/v1/admin/audit-logs'),
    },
  };
}

export type YapilapiClient = ReturnType<typeof createClient>;
