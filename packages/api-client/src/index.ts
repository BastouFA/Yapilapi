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
  PublicCommunityPreview,
  PublicEventPreview,
  PublicPostPreview,
  PublicProfilePreview,
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
      register: (b: { email: string; password: string; username: string; displayName: string; birthDate?: string; locale?: string; inviteCode?: string }) =>
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
      followers: (id: string, cursor?: string) => get<Page<PublicUser> & { viewerFollows: string[] }>(`/v1/users/${id}/followers${qs({ cursor })}`),
      following: (id: string, cursor?: string) => get<Page<PublicUser> & { viewerFollows: string[] }>(`/v1/users/${id}/following${qs({ cursor })}`),
      reposts: (id: string, cursor?: string) => get<Page<Post>>(`/v1/users/${id}/reposts${qs({ cursor })}`),
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
      view: (id: string) => post<{ views: number }>(`/v1/posts/${id}/view`),
      pin: (postId: string | null) => put<{ pinnedPostId: string | null }>('/v1/me/pinned-post', { postId }),
      repost: (id: string) => put<{ reposted: boolean; reposts: number }>(`/v1/posts/${id}/repost`),
      unrepost: (id: string) => del<{ reposted: boolean; reposts: number }>(`/v1/posts/${id}/repost`),
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
    studio: {
      /** Your uploaded videos, newest first, for picking one to edit. */
      videos: () => get<{ items: StudioVideo[] }>('/v1/me/videos'),
      /** Trim keeps one segment; clips make one new video per segment (up to 20). Times are in seconds. */
      createEdits: (mediaId: string, b: { kind: 'trim' | 'clip'; segments: { start: number; end: number }[] }) =>
        post<{ items: MediaEdit[] }>(`/v1/media/${mediaId}/edits`, b),
      edits: (mediaId: string) => get<{ items: MediaEdit[] }>(`/v1/media/${mediaId}/edits`),
      /** autoCaptions is only reported to the owner: whether automatic captions are set up on this server. */
      captions: (mediaId: string) => get<{ items: CaptionTrack[]; autoCaptions?: boolean }>(`/v1/media/${mediaId}/captions`),
      captionCues: (mediaId: string, lang: string) =>
        get<{ track: CaptionTrack; cues: CaptionCue[] }>(`/v1/media/${mediaId}/captions/${encodeURIComponent(lang)}`),
      saveCaptions: (mediaId: string, lang: string, b: { label: string; cues: CaptionCue[] }) =>
        put<{ track: CaptionTrack }>(`/v1/media/${mediaId}/captions/${encodeURIComponent(lang)}`, b),
      uploadCaptions: (mediaId: string, lang: string, file: File | Blob, label: string) => {
        const fd = new FormData();
        fd.append('label', label);
        fd.append('file', file, 'captions.vtt');
        return req<{ track: CaptionTrack }>('PUT', `/v1/media/${mediaId}/captions/${encodeURIComponent(lang)}/file`, fd);
      },
      deleteCaptions: (mediaId: string, lang: string) => del<{ ok: true }>(`/v1/media/${mediaId}/captions/${encodeURIComponent(lang)}`),
      /** Fails with code "not_configured" (501) when the server has no speech-to-text provider. */
      transcribe: (mediaId: string, b: { lang: string; label: string }) => post<{ track: CaptionTrack }>(`/v1/media/${mediaId}/captions/transcribe`, b),
    },
    moments: {
      list: () => get<{ items: StoryGroup[] }>('/v1/moments'),
      create: (b: {
        body?: string;
        mediaId?: string;
        mediaUrl?: string;
        mediaKind?: 'image' | 'video' | 'audio';
        expiresIn?: '1h' | '24h' | 'permanent' | 'custom';
        visibility?: string;
      }) => post<{ moment: { id: string; expiresAt: string | null } }>('/v1/moments', b),
      view: (id: string) => post(`/v1/moments/${id}/view`),
      like: (id: string, liked: boolean) => put<{ liked: boolean }>(`/v1/moments/${id}/like`, { liked }),
      viewers: (id: string) => get<{ items: { user: PublicUser; liked: boolean; viewedAt: string }[] }>(`/v1/moments/${id}/viewers`),
      reply: (id: string, body: string) => post<{ conversationId: string }>(`/v1/moments/${id}/reply`, { body }),
      remove: (id: string) => del(`/v1/moments/${id}`),
    },
    reels: (cursor?: string) => get<Page<Post> & { authors: Record<string, { followers: number; following: boolean }> }>(`/v1/reels${qs({ cursor })}`),
    conversations: {
      list: () => get<{ items: Conversation[] }>('/v1/conversations'),
      get: (id: string) => get<{ conversation: Conversation }>(`/v1/conversations/${id}`),
      create: (memberIds: string[], title?: string) => post<{ conversation: Conversation }>('/v1/conversations', { memberIds, title }),
      messages: (id: string, cursor?: string) => get<Page<Message>>(`/v1/conversations/${id}/messages${qs({ cursor })}`),
      send: (id: string, body: string, clientId?: string, attachments: { mediaId: string; name?: string }[] = []) =>
        post<{ message: Message }>(`/v1/conversations/${id}/messages`, { body, clientId, attachments }),
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
      faq: (slug: string) => get<{ items: FaqEntry[]; canEdit: boolean }>(`/v1/communities/${slug}/faq`),
      addFaq: (slug: string, b: { question: string; answer: string }) => post<{ faq: FaqEntry }>(`/v1/communities/${slug}/faq`, b),
      updateFaq: (slug: string, id: string, b: Partial<{ question: string; answer: string; position: number }>) =>
        patch<{ faq: FaqEntry }>(`/v1/communities/${slug}/faq/${id}`, b),
      deleteFaq: (slug: string, id: string) => del(`/v1/communities/${slug}/faq/${id}`),
      similar: (slug: string, q: string) =>
        get<{ faq: (FaqEntry & { score: number })[]; posts: { post: Post; score: number }[] }>(`/v1/communities/${slug}/similar${qs({ q })}`),
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
      mine: () => get<{ items: { id: string; slug: string; name: string }[] }>('/v1/me/businesses'),
      analytics: (id: string, days = 30) => get<BusinessAnalytics>(`/v1/businesses/${id}/analytics${qs({ days })}`),
      get: (slug: string) => get<{ business: Record<string, any>; places: Record<string, any>[]; products: Record<string, any>[] }>(`/v1/businesses/${slug}`),
    },
    people: {
      /** People to add to a conversation: connections first, prefix matches as you type. */
      suggest: (q = '', limit = 8) =>
        get<{ items: { user: PublicUser; relation: 'friend' | 'following' | null; canMessage: boolean }[] }>(`/v1/people/suggest${qs({ q, limit })}`),
    },
    payments: {
      config: () => get<{ provider: string; publishableKey?: string }>('/v1/payments/config'),
      /** Development provider only: finish a test payment. */
      devComplete: (orderId: string) => post<{ status: string }>('/v1/payments/dev/complete', { orderId }),
    },
    orders: {
      create: (items: { productId: string; quantity: number }[], idempotencyKey: string, liveSessionId?: string) =>
        post<{ order: Record<string, any>; payment?: { provider: string; clientSecret: string } }>('/v1/orders', { items, idempotencyKey, liveSessionId }),
      list: () => get<{ items: Record<string, any>[] }>('/v1/orders'),
      get: (id: string) => get<{ order: Record<string, any> }>(`/v1/orders/${id}`),
    },
    realtime: {
      /** A 60-second ticket for opening the realtime socket when the API is on another host. */
      ticket: () => post<{ ticket: string }>('/v1/realtime/ticket'),
    },
    trending: (limit = 10) => get<{ items: TrendingTag[] }>(`/v1/trending${qs({ limit })}`),
    tags: {
      get: (tag: string) => get<TagSummary>(`/v1/tags/${encodeURIComponent(tag)}`),
      posts: (tag: string, sort: 'recent' | 'top' = 'recent', cursor?: string) =>
        get<Page<Post>>(`/v1/tags/${encodeURIComponent(tag)}/posts${qs({ sort, cursor })}`),
      follow: (tag: string) => put<{ following: boolean }>(`/v1/tags/${encodeURIComponent(tag)}/follow`),
      unfollow: (tag: string) => del<{ following: boolean }>(`/v1/tags/${encodeURIComponent(tag)}/follow`),
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
    /** What anyone can see of a shared link without an account (link previews, signed-out views). */
    public: {
      post: (id: string) => get<{ post: PublicPostPreview }>(`/v1/public/posts/${encodeURIComponent(id)}`),
      user: (username: string) => get<{ profile: PublicProfilePreview }>(`/v1/public/users/${encodeURIComponent(username)}`),
      event: (id: string) => get<{ event: PublicEventPreview }>(`/v1/public/events/${encodeURIComponent(id)}`),
      community: (slug: string) => get<{ community: PublicCommunityPreview }>(`/v1/public/communities/${encodeURIComponent(slug)}`),
    },
    passkeys: {
      list: () => get<{ items: { id: string; label: string; created_at: string; last_used_at: string | null; backed_up: boolean }[] }>('/v1/auth/passkeys'),
      registerOptions: () => post<{ options: any; challengeId: string }>('/v1/auth/passkeys/register/options'),
      registerVerify: (challengeId: string, response: unknown, label: string) => post('/v1/auth/passkeys/register/verify', { challengeId, response, label }),
      remove: (id: string) => del(`/v1/auth/passkeys/${id}`),
      loginOptions: () => post<{ options: any; challengeId: string }>('/v1/auth/passkeys/login/options'),
      loginVerify: (challengeId: string, response: unknown) => post<{ user: Me; token: string }>('/v1/auth/passkeys/login/verify', { challengeId, response }),
    },
    push: {
      config: () => get<{ webPush: boolean; vapidPublicKey: string | null }>('/v1/push/config'),
      subscribe: (b: { kind: 'webpush'; endpoint: string; keys: { p256dh: string; auth: string } } | { kind: 'expo'; endpoint: string }) =>
        post('/v1/push/subscriptions', b),
      unsubscribe: (endpoint: string) => del('/v1/push/subscriptions', { endpoint }),
    },
    miniApps: {
      directory: (surface: string) =>
        get<{ items: { id: string; name: string; description: string; permissions: string[] }[] }>(`/v1/mini-apps${qs({ surface })}`),
      installed: (surface: string, surfaceId: string) =>
        get<{ items: { id: string; name: string; description: string; entryUrl: string; permissions: string[] }[] }>(
          `/v1/mini-apps/installed${qs({ surface, surfaceId })}`,
        ),
      install: (id: string, surface: string, surfaceId: string) => post(`/v1/mini-apps/${id}/install`, { surface, surfaceId }),
      context: (id: string, surface: string, surfaceId: string) =>
        post<{ token: string; permissions: string[] }>(`/v1/mini-apps/${id}/context`, { surface, surfaceId }),
    },
    economy: {
      plans: (userId: string) =>
        get<{
          items: { id: string; name: string; description: string; priceCents: number; currency: string }[];
          mySubscription: { plan_id: string; status: string; current_period_end: string | null } | null;
        }>(`/v1/users/${userId}/plans`),
      createPlan: (b: { name: string; description?: string; priceCents: number; currency: string }) => post('/v1/creator/plans', b),
      subscribe: (planId: string, idempotencyKey: string) =>
        post<{ subscription: { id: string; status: string }; payment: { orderId: string; clientSecret: string } }>(`/v1/creator/plans/${planId}/subscribe`, {
          idempotencyKey,
        }),
      tip: (userId: string, b: { amountCents: number; currency: string; message?: string; postId?: string; liveId?: string; idempotencyKey: string }) =>
        post<{ payment: { orderId: string; clientSecret: string; provider: string } }>(`/v1/users/${userId}/tips`, b),
      subscribers: () => get<{ active: number; cancelled: number }>('/v1/creator/subscribers'),
      mySubscriptions: () =>
        get<{ items: { id: string; status: string; plan: string; priceCents: number; currency: string; creator: PublicUser }[] }>('/v1/me/subscriptions'),
      cancel: (id: string) => post(`/v1/creator/subscriptions/${id}/cancel`),
    },
    reviews: {
      list: (placeId: string) =>
        get<{ average: number | null; count: number; items: { id: string; rating: number; body: string; createdAt: string; author: PublicUser }[] }>(
          `/v1/places/${placeId}/reviews`,
        ),
      save: (placeId: string, rating: number, body: string) => put(`/v1/places/${placeId}/reviews`, { rating, body }),
    },
    bookings: {
      create: (placeId: string, b: { partySize: number; startsAt: string; note?: string }) =>
        post<{ booking: { id: string; status: string } }>(`/v1/places/${placeId}/bookings`, b),
      mine: () =>
        get<{ items: { id: string; status: string; party_size: number; starts_at: string; place_id: string; place_name: string }[] }>('/v1/me/bookings'),
      forPlace: (placeId: string) =>
        get<{ items: { id: string; status: string; party_size: number; starts_at: string; note: string; guest: string }[] }>(`/v1/places/${placeId}/bookings`),
      decide: (id: string, confirm: boolean) => post(`/v1/bookings/${id}/decide`, { confirm }),
      cancel: (id: string) => post(`/v1/bookings/${id}/cancel`),
    },
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
      clips: (id: string) =>
        get<{
          enabled: boolean;
          recording: { status: 'pending' | 'ready' | 'none' | 'failed' | null; mediaId: string | null };
          clips: {
            id: string;
            startMs: number;
            endMs: number;
            status: string;
            error: string | null;
            media: { id: string; url: string; posterUrl: string | null; hlsUrl: string | null } | null;
          }[];
        }>(`/v1/live/${id}/clips`),
      update: (id: string, b: { title?: string; ticketProductId?: string | null }) => patch<{ live: LiveSummary }>(`/v1/live/${id}`, b),
      products: (id: string) => get<{ items: LiveProduct[] }>(`/v1/live/${id}/products`),
      pin: (id: string, productId: string) => post(`/v1/live/${id}/products`, { productId }),
      unpin: (id: string, productId: string) => del(`/v1/live/${id}/products/${productId}`),
      create: (b: { title: string; visibility?: string; ticketProductId?: string }) =>
        post<{ live: LiveSummary; ingest: { url: string; streamKey: string }; message: string }>('/v1/live', b),
      start: (id: string) => post<{ live: LiveSummary }>(`/v1/live/${id}/start`),
      end: (id: string) => post<{ live: LiveSummary }>(`/v1/live/${id}/end`),
      join: (id: string) => post<{ live: LiveSummary }>(`/v1/live/${id}/join`),
      leave: (id: string) => post(`/v1/live/${id}/leave`),
      chat: (id: string) => get<{ items: LiveChatMessage[] }>(`/v1/live/${id}/chat`),
      send: (id: string, body: string, kind: 'chat' | 'question' = 'chat') => post<{ message: LiveChatMessage }>(`/v1/live/${id}/chat`, { body, kind }),
      ban: (id: string, userId: string) => post(`/v1/live/${id}/ban`, { userId }),
    },
    agents: {
      run: (kind: AgentKind, prompt: string, businessId?: string) => post<AgentResult>(`/v1/ai/agents/${kind}`, { prompt, businessId }),
    },
    plus: {
      get: () => get<PlusInfo>('/v1/plus'),
      /** Start paying for 30 days of Plus; open checkout with the returned payment. */
      checkout: (idempotencyKey: string) =>
        post<{ priceCents: number; currency: string; days: number; payment: { provider: string; orderId: string; clientSecret: string } }>(
          '/v1/plus/checkout',
          {
            idempotencyKey,
          },
        ),
    },
    invites: {
      mine: () => get<InvitesInfo>('/v1/invites'),
      /** Who a code belongs to (public). */
      preview: (code: string) => get<{ code: string; inviter: PublicUser }>(`/v1/invites/${encodeURIComponent(code)}`),
      accept: (code: string) => post<{ inviter: PublicUser }>('/v1/invites/accept', { code }),
    },
    ads: {
      next: () => get<{ ad: SponsoredAd | null }>('/v1/ads/next'),
      click: (campaignId: string) => post(`/v1/ads/${campaignId}/click`),
      hide: (campaignId: string) => post(`/v1/ads/${campaignId}/hide`),
      campaigns: () => get<{ items: AdCampaign[] }>('/v1/ads/campaigns'),
      create: (b: {
        postId: string;
        name: string;
        topics?: string[];
        locales?: string[];
        cpmCents?: number;
        startsAt?: string;
        endsAt?: string;
        businessId?: string;
      }) => post<{ campaign: AdCampaign }>('/v1/ads/campaigns', b),
      setStatus: (id: string, status: 'active' | 'paused' | 'ended') => patch<{ campaign: AdCampaign }>(`/v1/ads/campaigns/${id}`, { status }),
      fund: (id: string, amountCents: number, idempotencyKey: string) =>
        post<{ payment: { provider: string; clientSecret: string; orderId: string } }>(`/v1/ads/campaigns/${id}/fund`, { amountCents, idempotencyKey }),
      stats: (id: string) =>
        get<{ campaign: AdCampaign; days: { day: string; impressions: number; clicks: number; hides: number; reach: number }[] }>(
          `/v1/ads/campaigns/${id}/stats`,
        ),
    },
    family: {
      list: () => get<{ items: FamilyLink[] }>('/v1/family'),
      invite: (username: string) => post<{ link: { id: string; status: string } }>('/v1/family/invite', { username }),
      accept: (id: string) => post(`/v1/family/${id}/accept`),
      end: (id: string) => post(`/v1/family/${id}/end`),
      setControls: (id: string, b: TeenControls) => put<{ controls: TeenControls }>(`/v1/family/${id}/controls`, b),
      heartbeat: () =>
        post<{ minutesToday: number; dailyLimitMinutes: number | null; overLimit: boolean; quietNow: boolean; supervised: boolean }>('/v1/me/usage/heartbeat'),
    },
    admin: {
      cases: (status = 'open') => get<{ items: Record<string, any>[] }>(`/v1/admin/moderation/cases${qs({ status })}`),
      decide: (id: string, decision: string, note?: string) => post(`/v1/admin/moderation/cases/${id}/decide`, { decision, note }),
      summary: () => get<{ summary: Record<string, number>; meaningfulByAction: { name: string; n: number }[] }>('/v1/admin/analytics/summary'),
      setFlag: (key: string, enabled: boolean) => put<{ flags: Record<string, boolean> }>(`/v1/admin/flags/${key}`, { enabled }),
      users: (q = '') => get<{ items: Record<string, any>[] }>(`/v1/admin/users${qs({ q })}`),
      setUserStatus: (id: string, status: 'active' | 'suspended') => put(`/v1/admin/users/${id}/status`, { status }),
      auditLogs: () => get<{ items: Record<string, any>[] }>('/v1/admin/audit-logs'),
      regionalRules: () => get<{ items: RegionalRule[] }>('/v1/admin/regional-rules'),
      addRegionalRule: (
        b:
          | { kind: 'blocked_term'; country: string; term: string; legalBasis: string }
          | { kind: 'restrict_topic'; country: string; topic: string; legalBasis: string },
      ) => post<{ rule: RegionalRule }>('/v1/admin/regional-rules', b),
      deleteRegionalRule: (id: string) => del(`/v1/admin/regional-rules/${id}`),
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
  /** Ticketed lives: playbackUrl stays null until the viewer holds a paid ticket. */
  ticket: { productId: string; title: string; priceCents: number; currency: string; hasTicket: boolean } | null;
  playbackUrl: string | null;
}

export interface LiveProduct {
  id: string;
  kind: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  inventory: number | null;
}

export interface LiveChatMessage {
  id: string;
  kind: 'chat' | 'question' | 'reaction' | 'gift';
  body: string;
  answered: boolean;
  amountCents?: number;
  currency?: string;
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

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  position: number;
  updatedAt: string;
}

export interface SponsoredAd {
  campaignId: string;
  label: 'Sponsored';
  post: Post;
  why: string[];
}

export interface AdCampaign {
  id: string;
  name: string;
  status: 'draft' | 'pending_review' | 'active' | 'paused' | 'ended' | 'rejected';
  postId: string;
  topics: string[];
  locales: string[];
  cpmCents: number;
  currency: string;
  budgetCents: number;
  spentCents: number;
  businessId: string | null;
  /** Unspent budget given back after the campaign was rejected or ended. */
  refundedCents: number;
  impressions: number;
  clicks: number;
  ctr: number;
  startsAt: string | null;
  endsAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  /** Why a campaign was rejected, written by the reviewer. */
  reviewNote: string | null;
  createdAt: string;
}

export interface TeenControls {
  messagesFrom: 'friends' | 'nobody';
  dailyLimitMinutes: number | null;
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string;
}

export interface FamilyLink {
  id: string;
  role: 'guardian' | 'teen';
  status: 'pending' | 'active';
  guardian: PublicUser | null;
  teen: PublicUser | null;
  controls: TeenControls | null;
  usage?: { day: string; minutes: number }[];
  createdAt: string;
}

export type AgentKind = 'discover' | 'travel' | 'shopping' | 'business';

export interface AgentEntity {
  type: 'event' | 'place' | 'community' | 'person' | 'product' | 'business';
  id: string;
  title: string;
  subtitle?: string;
  startsAt?: string;
  href: string;
}

export interface AgentResult {
  agent: AgentKind;
  text: string;
  recommendations: (AgentEntity & { reason: string })[];
  actions: { kind: 'rsvp' | 'book' | 'buy' | 'follow' | 'join'; target: AgentEntity; label: string }[];
  provider: string;
  model: string;
  contextScopes: string[];
  notice?: string;
}

export interface RegionalRule {
  id: string;
  country: string;
  kind: 'blocked_term' | 'restrict_topic';
  term: string | null;
  topic: string | null;
  legalBasis: string;
  withheldPosts: number;
  createdAt: string;
}

export interface BusinessAnalytics {
  days: number;
  bookingsByStatus: Record<string, { bookings: number; guests: number }>;
  upcomingBookings: number;
  reviews: { count: number; average: number | null };
  topProducts: { title: string; currency: string; units: number; revenue_cents: number }[];
  views: { day: string; business: number; places: number; visitors: number }[];
  visitorsTotal: number;
  ratingTrend: { week: string; reviews: number; average: number }[];
  ads: { impressions: number; clicks: number; spentCents: number };
}

export interface StudioVideo {
  id: string;
  url: string;
  variants: Record<string, string>;
  posterUrl: string | null;
  hlsUrl: string | null;
  durationMs: number | null;
  altText: string | null;
  /** Poster, MP4 and HLS are ready. Only processed videos can be edited. */
  processed: boolean;
  /** Set when this video is a trim or clip of another one. */
  editOf: string | null;
  createdAt: string;
}

export interface MediaEdit {
  id: string;
  kind: 'trim' | 'clip';
  /** Seconds into the source video. */
  start: number;
  end: number;
  status: 'queued' | 'rendering' | 'processing' | 'ready' | 'failed';
  error: string | null;
  createdAt: string;
  result: {
    id: string;
    url: string;
    variants: Record<string, string>;
    posterUrl: string | null;
    hlsUrl: string | null;
    durationMs: number | null;
    ready: boolean;
  } | null;
}

export interface CaptionTrack {
  id: string;
  lang: string;
  label: string;
  source: 'manual' | 'upload' | 'auto';
  status: 'processing' | 'ready' | 'failed';
  /** The .vtt file, served with a text/vtt content type. */
  url: string | null;
  cueCount: number;
  /** Why automatic captions failed (owner only). */
  error: string | null;
  updatedAt: string;
}

export interface CaptionCue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

export interface Story {
  id: string;
  body: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | 'audio' | null;
  posterUrl: string | null;
  hlsUrl: string | null;
  durationMs: number | null;
  locationText: string | null;
  expiresAt: string | null;
  createdAt: string;
  seen: boolean;
  liked: boolean;
  /** Only on your own stories. */
  views?: number;
}

export interface StoryGroup {
  author: PublicUser;
  mine: boolean;
  allSeen: boolean;
  moments: Story[];
}

export interface TrendingTag {
  tag: string;
  /** Public posts with the tag in the last 7 days. */
  posts: number;
  people: number;
  /** More posts today than yesterday. */
  rising: boolean;
}

export interface TagSummary {
  tag: string;
  posts: number;
  people: number;
  postsThisWeek: number;
  related: string[];
  following: boolean;
}

export interface PlusInfo {
  priceCents: number;
  currency: string;
  days: number;
  autoRenews: false;
  benefits: (
    | { id: 'no_ads' }
    | { id: 'long_reels'; minutes: number; standardMinutes: number }
    | { id: 'big_uploads'; megabytes: number; standardMegabytes: number }
    | { id: 'badge' }
  )[];
  /** Null when signed out. `until` is only set while Plus is active. */
  status: { active: boolean; until: string | null; canExtend: boolean } | null;
  history: { source: 'purchase' | 'referral'; days: number; startsAt: string; endsAt: string; createdAt: string }[];
}

export interface InvitesInfo {
  code: string;
  link: string;
  joined: number;
  confirmed: number;
  reward: { perPeople: number; days: number; max: number; earned: number };
  /** Confirmed people still needed for the next free month; null once the limit is reached. */
  toNextReward: number | null;
  /** True for a new account that joined without a code: it can still enter one (POST /v1/invites/accept). */
  canEnterCode: boolean;
  enterCodeDays: number;
  people: { user: PublicUser; joinedAt: string; confirmed: boolean }[];
}
