import type { Comment, Community, Conversation, EventItem, FeedMode, Me, Message, NotificationItem, Page, Post, Profile, PublicUser } from '@yapilapi/shared';

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
    const s = new URLSearchParams(
      Object.entries(o)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return s ? `?${s}` : '';
  };

  return {
    raw: { get, post, put, patch, del },
    auth: {
      me: () => get<{ user: Me }>('/v1/auth/me'),
      register: (b: { email: string; password: string; username: string; displayName: string; birthDate?: string }) =>
        post<{ user: Me; token: string }>('/v1/auth/register', b),
      login: (b: { email: string; password: string }) =>
        post<{ user?: Me; token?: string; mfaRequired?: boolean; challengeToken?: string }>('/v1/auth/login', b),
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
      moderation: () =>
        get<{ items: { id: string; target_type: string; decision: string; status: string; appeal_status: string | null }[] }>('/v1/me/moderation'),
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
      list: () =>
        get<{
          items: {
            author: PublicUser;
            moments: { id: string; body: string; mediaUrl: string | null; mediaKind: string | null; expiresAt: string | null; createdAt: string }[];
          }[];
        }>('/v1/moments'),
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
    businesses: {
      get: (slug: string) => get<{ business: Record<string, any>; places: Record<string, any>[]; products: Record<string, any>[] }>(`/v1/businesses/${slug}`),
    },
    orders: {
      create: (items: { productId: string; quantity: number }[], idempotencyKey: string) =>
        post<{ order: Record<string, any>; payment?: { provider: string; clientSecret: string } }>('/v1/orders', { items, idempotencyKey }),
      list: () => get<{ items: Record<string, any>[] }>('/v1/orders'),
    },
    search: (q: string, type = 'all') => get<{ query: string; intent: Record<string, any>; results: Record<string, any> }>(`/v1/search${qs({ q, type })}`),
    now: () =>
      get<{ events: EventItem[]; trendingTopics: { topic: string; posts: number }[]; activeCommunities: { slug: string; name: string; posts: number }[] }>(
        '/v1/now',
      ),
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
    creator: {
      analytics: () =>
        get<{ totals: Record<string, number>; topPosts: Record<string, any>[]; followerGrowth: { day: string; new_followers: number }[] }>(
          '/v1/creator/analytics',
        ),
    },
    flags: () => get<{ flags: Record<string, boolean> }>('/v1/flags'),
    uploads: {
      /** Chunked, resumable upload. Retries each chunk and resumes from what the server already has. */
      resumable: async (file: File, onProgress?: (fraction: number) => void, altText?: string) => {
        const s = await post<{ uploadId: string; chunkSize: number; totalChunks: number }>('/v1/uploads', {
          filename: file.name,
          mime: file.type,
          size: file.size,
        });
        const status = await get<{ missing: number[] }>(`/v1/uploads/${s.uploadId}`);
        let done = s.totalChunks - status.missing.length;
        for (const i of status.missing) {
          const chunk = file.slice(i * s.chunkSize, Math.min(file.size, (i + 1) * s.chunkSize));
          for (let attempt = 0; ; attempt++) {
            try {
              const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
              if (opts.token) headers.authorization = `Bearer ${opts.token}`;
              const res = await f(`${opts.baseUrl}/v1/uploads/${s.uploadId}/chunks/${i}`, { method: 'PUT', body: chunk, headers, credentials: 'include' });
              if (!res.ok) throw new ApiError(res.status, 'upload_failed', 'A part of the upload failed.');
              break;
            } catch (e) {
              if (attempt >= 4) throw e;
              await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            }
          }
          onProgress?.(++done / s.totalChunks);
        }
        return post<{ media: { id: string; kind: 'image' | 'video' | 'audio'; url: string; altText: string | null } }>(`/v1/uploads/${s.uploadId}/complete`, {
          altText,
        });
      },
    },
    calls: {
      start: (conversationId: string, kind: 'audio' | 'video') =>
        post<{ call: CallInfo; iceServers: RTCIceServer[] }>(`/v1/conversations/${conversationId}/calls`, { kind }),
      get: (id: string) => get<{ call: CallInfo; iceServers: RTCIceServer[] }>(`/v1/calls/${id}`),
      answer: (id: string) => post<{ call: CallInfo; iceServers: RTCIceServer[] }>(`/v1/calls/${id}/answer`),
      decline: (id: string) => post(`/v1/calls/${id}/decline`),
      end: (id: string) => post(`/v1/calls/${id}/end`),
      signal: (id: string, toUserId: string, type: 'offer' | 'answer' | 'candidate', data: unknown) => post(`/v1/calls/${id}/signal`, { toUserId, type, data }),
    },
    real: {
      feed: () => get<{ items: Post[] }>('/v1/real'),
      create: (b: { mediaIds: string[]; caption?: string; visibility?: string }) => post<{ post: Post }>('/v1/real', b),
    },
    together: {
      list: () => get<{ items: { id: string; title: string; status: string; closesAt: string; contributions: number; members: number }[] }>('/v1/together'),
      get: (id: string) => get<{ together: TogetherDetail }>(`/v1/together/${id}`),
      create: (b: { title: string; memberIds: string[]; eventId?: string }) => post<{ together: TogetherDetail }>('/v1/together', b),
      contribute: (id: string, mediaId: string, caption: string) =>
        post<{ together: TogetherDetail }>(`/v1/together/${id}/contributions`, { mediaId, caption }),
      close: (id: string) => post<{ together: TogetherDetail }>(`/v1/together/${id}/close`),
    },
    oauth: {
      consent: (query: string) =>
        get<{ app: { id: string; name: string; description: string; website: string | null; ownerName: string }; scopes: string[]; redirectUri: string }>(
          `/v1/oauth/authorize?${query}`,
        ),
      decide: (params: Record<string, string>, approve: boolean) => post<{ redirectTo: string }>('/v1/oauth/authorize', { ...params, approve }),
      connectedApps: () =>
        get<{ items: { id: string; name: string; website: string | null; scopes: string[]; connected_at: string; last_used_at: string | null }[] }>(
          '/v1/me/connected-apps',
        ),
      disconnect: (appId: string) => del(`/v1/me/connected-apps/${appId}`),
      setRedirectUris: (appId: string, redirectUris: string[]) =>
        put<{ redirectUris: string[] }>(`/v1/developer/apps/${appId}/redirect-uris`, { redirectUris }),
    },
    mfa: {
      status: () =>
        get<{ enabled: boolean; recoveryCodesLeft: number; factors: { id: string; kind: string; label: string; last_used_at: string | null }[] }>(
          '/v1/auth/mfa',
        ),
      setup: () => post<{ secret: string; otpauthUri: string }>('/v1/auth/mfa/totp/setup'),
      confirm: (code: string) => post<{ enabled: true; recoveryCodes: string[] }>('/v1/auth/mfa/totp/confirm', { code }),
      verify: (challengeToken: string, code: string) => post<{ user: Me; token: string }>('/v1/auth/mfa/verify', { challengeToken, code }),
      disable: (password: string, code: string) => post('/v1/auth/mfa/disable', { password, code }),
      newRecoveryCodes: (code: string) => post<{ recoveryCodes: string[] }>('/v1/auth/mfa/recovery-codes', { code }),
    },
    developer: {
      apps: () =>
        get<{ items: { id: string; name: string; description: string; redirect_uris: string[]; active_keys: number; webhooks: number }[] }>(
          '/v1/developer/apps',
        ),
      createApp: (b: { name: string; description?: string; website?: string }) => post<{ app: { id: string; name: string } }>('/v1/developer/apps', b),
      deleteApp: (id: string) => del(`/v1/developer/apps/${id}`),
      keys: (appId: string) =>
        get<{
          items: { id: string; name: string; prefix: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null; created_at: string }[];
        }>(`/v1/developer/apps/${appId}/keys`),
      createKey: (appId: string, b: { name: string; scopes: string[] }) => post<{ secret: string; message: string }>(`/v1/developer/apps/${appId}/keys`, b),
      revokeKey: (appId: string, keyId: string) => del(`/v1/developer/apps/${appId}/keys/${keyId}`),
      webhooks: (appId: string) =>
        get<{
          items: { id: string; url: string; events: string[]; active: boolean }[];
          deliveries: { id: string; event: string; status: string; attempts: number; response_code: number | null; created_at: string }[];
          events: string[];
        }>(`/v1/developer/apps/${appId}/webhooks`),
      createWebhook: (appId: string, url: string, events: string[]) => post<{ secret: string }>(`/v1/developer/apps/${appId}/webhooks`, { url, events }),
      deleteWebhook: (appId: string, id: string) => del(`/v1/developer/apps/${appId}/webhooks/${id}`),
      ping: (appId: string, id: string) => post(`/v1/developer/apps/${appId}/webhooks/${id}/ping`),
    },
    memories: {
      list: () => get<{ items: MemorySummary[] }>('/v1/memories'),
      get: (id: string) =>
        get<{
          memory: MemorySummary;
          posts: Post[];
          events: EventItem[];
          moments: { id: string; body: string; media_url: string | null; media_kind: string | null }[];
          hiddenItems: number;
        }>(`/v1/memories/${id}`),
      create: (b: { title: string; kind?: string; description?: string }) => post<{ memory: MemorySummary }>('/v1/memories', b),
      remove: (id: string) => del(`/v1/memories/${id}`),
      suggestions: () => get<{ events: EventItem[]; onThisDay: Post[] }>('/v1/memories/suggestions'),
      fromEvent: (eventId: string) => post<{ memoryId: string }>(`/v1/memories/from-event/${eventId}`),
      addItem: (id: string, itemType: 'post' | 'moment' | 'event', itemId: string) => post(`/v1/memories/${id}/items`, { itemType, itemId }),
      removeItem: (id: string, itemType: string, itemId: string) => del(`/v1/memories/${id}/items/${itemType}/${itemId}`),
      share: (id: string, userIds: string[]) => put<{ visibility: string }>(`/v1/memories/${id}/shares`, { userIds }),
      recap: (id: string) => post<{ recap: string; notice?: string }>(`/v1/memories/${id}/recap`),
    },
    live: {
      list: () => get<{ items: LiveSummary[] }>('/v1/live'),
      get: (id: string) => get<{ live: LiveSummary }>(`/v1/live/${id}`),
      create: (b: { title: string; visibility?: string }) =>
        post<{ live: LiveSummary; ingest: { url: string; streamKey: string }; message: string }>('/v1/live', b),
      start: (id: string) => post<{ live: LiveSummary }>(`/v1/live/${id}/start`),
      end: (id: string) => post<{ live: LiveSummary }>(`/v1/live/${id}/end`),
      join: (id: string) => post<{ live: LiveSummary }>(`/v1/live/${id}/join`),
      leave: (id: string) => post(`/v1/live/${id}/leave`),
      chat: (id: string) => get<{ items: LiveChatMessage[] }>(`/v1/live/${id}/chat`),
      send: (id: string, body: string, kind: 'chat' | 'question' = 'chat') => post<{ message: LiveChatMessage }>(`/v1/live/${id}/chat`, { body, kind }),
      ban: (id: string, userId: string) => post(`/v1/live/${id}/ban`, { userId }),
    },
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

export interface MemorySummary {
  id: string;
  title: string;
  kind: string;
  description: string;
  recap: string | null;
  startsAt: string | null;
  endsAt: string | null;
  visibility: 'private' | 'friends' | 'selected';
  mine: boolean;
  itemCount: number;
  createdAt: string;
}

export interface LiveSummary {
  id: string;
  title: string;
  status: 'scheduled' | 'live' | 'ended';
  visibility: string;
  host: PublicUser;
  viewers: number;
  peakViewers: number;
  startedAt: string | null;
  endedAt: string | null;
  myRole: 'host' | 'cohost' | 'moderator' | 'viewer' | null;
  playbackUrl: string | null;
}

export interface LiveChatMessage {
  id: string;
  kind: 'chat' | 'question' | 'reaction';
  body: string;
  answered: boolean;
  author: PublicUser;
  createdAt: string;
}

export interface CallInfo {
  id: string;
  conversationId: string;
  callerId: string;
  kind: 'audio' | 'video';
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'declined';
  participants: string[];
}

export interface TogetherDetail {
  id: string;
  title: string;
  status: 'open' | 'closed';
  eventId: string | null;
  closesAt: string | null;
  myRole: 'creator' | 'member';
  members: { user: PublicUser; role: string }[];
  contributions: { id: string; caption: string; capturedAt: string; media: { url: string; kind: string; altText: string | null } | null; author: PublicUser }[];
}
