import type {
  AccountInfo,
  InteractionSettings,
  Circle,
  CircleKind,
  DataSaverMode,
  TranslatableKind,
  Translation,
  TranslationSettings,
  NowStatus,
  NowStatusAudience,
  NowStatusIcon,
  Board,
  BoardDetail,
  BoardVisibility,
  SavedFilter,
  ChapterAudience,
  ChapterGradient,
  ChapterSymbol,
  Comment,
  CommentPage,
  ReelHighlight,
  ReelMoment,
  CommentPolicy,
  CommentSort,
  Community,
  Conversation,
  EventItem,
  FeedMode,
  Me,
  Message,
  NotificationItem,
  Page,
  Post,
  PostVersion,
  DraftDetail,
  EditPostInput,
  Profile,
  PublicCommunityPreview,
  PublicSitemap,
  PublicEventPreview,
  PublicPostPreview,
  PublicProfilePreview,
  PublicUser,
  PhotoTag,
  CreateRecapInput,
  Recap,
  RecapCandidates,
  RecapSource,
  RoomDetail,
  RoomMediaSession,
  RoomReaction,
  RoomSummary,
  Sound,
  MusicSource,
  MusicSourceInfo,
  MusicTab,
  MusicTrack,
  EditorParamsInput,
  TagPermission,
  ConversationYaps,
  PinnedMessage,
  ViewOnceInfo,
  ChatList,
  ChatPoll,
  ChatReminder,
  StickerResults,
  StoryCard,
  StoryMusic,
  StoryMusicInput,
  StorySticker,
  StoryStickerInput,
  DualComposeInput,
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
  /**
   * Extra headers for every request, read each time. Clients on Data saver send
   * `Save-Data: on`, which makes responses lighter (no large photo sizes).
   */
  headers?: () => Record<string, string>;
  /**
   * Runs on every file before media.upload and uploads.resumable send it. The web
   * app makes photos smaller here on Data saver.
   */
  prepareUpload?: (file: File) => Promise<File>;
}

/** Typed client for the YAPILAPI API, shared by web, mobile and admin. */
export function createClient(opts: ClientOptions) {
  const f = opts.fetch ?? fetch;

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { ...(opts.headers?.() ?? {}) };
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
      /** `website` is the web form's hidden honeypot field: people leave it empty. */
      register: (b: {
        email: string;
        password: string;
        username: string;
        displayName: string;
        /** YYYY-MM-DD. Required: under 13 can't join. */
        birthDate: string;
        locale?: string;
        inviteCode?: string;
        website?: string;
      }) => post<{ user: Me; token: string }>('/v1/auth/register', b),
      /** `remember: false` ("Stay signed in" off): the web session ends when the browser closes. */
      login: (b: { email: string; password: string; remember?: boolean }) =>
        post<{ user?: Me; token?: string; mfaRequired?: boolean; challengeToken?: string }>('/v1/auth/login', b),
      logout: () => post<{ ok: true }>('/v1/auth/logout'),
      /** Ends every session of the account, this one included. */
      logoutAll: () => post<{ ok: true; revoked: number }>('/v1/auth/logout-all'),
      /** Ends every other session; this one stays signed in. */
      revokeOtherSessions: () => post<{ revoked: number }>('/v1/auth/sessions/revoke-others'),
      /** Other devices are signed out; this one stays signed in. */
      changePassword: (currentPassword: string, newPassword: string) => post<{ ok: true }>('/v1/auth/password/change', { currentPassword, newPassword }),
      /** Recent sign-ins and security changes (newest first, at most 50). */
      securityEvents: () => get<{ items: { type: string; ip: string | null; created_at: string }[] }>('/v1/auth/security-events'),
      verifyEmail: (token: string) => post('/v1/auth/verify-email', { token }),
      resendVerification: () => post('/v1/auth/verify-email/resend'),
      forgot: (email: string) => post<{ message: string }>('/v1/auth/password/forgot', { email }),
      reset: (token: string, password: string) => post('/v1/auth/password/reset', { token, password }),
      sessions: () => get<{ items: { id: string; device: string; ip: string; last_seen_at: string; current: boolean }[] }>('/v1/auth/sessions'),
      revokeSession: (id: string) => del(`/v1/auth/sessions/${id}`),
      checkUsername: (username: string) => post<{ available: boolean }>('/v1/auth/check-username', { username }),
      /** Once, for an account made before a birth date was required (Me.needsBirthDate). */
      setBirthDate: (birthDate: string) => post<{ user: Me }>('/v1/me/birth-date', { birthDate }),
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
      unmute: (id: string) => del(`/v1/users/${id}/mute`),
      restrict: (id: string) => post(`/v1/users/${id}/restrict`),
      unrestrict: (id: string) => del(`/v1/users/${id}/restrict`),
      followers: (id: string, cursor?: string) => get<Page<PublicUser> & { viewerFollows: string[] }>(`/v1/users/${id}/followers${qs({ cursor })}`),
      following: (id: string, cursor?: string) => get<Page<PublicUser> & { viewerFollows: string[] }>(`/v1/users/${id}/following${qs({ cursor })}`),
      reposts: (id: string, cursor?: string) => get<Page<Post>>(`/v1/users/${id}/reposts${qs({ cursor })}`),
      /** Posts someone is tagged in that you can see. `hidden` is true when their profile is private and you don't follow them. */
      tagged: (username: string, cursor?: string) =>
        get<Page<Post> & { hidden?: boolean }>(`/v1/users/${encodeURIComponent(username)}/tagged${qs({ cursor })}`),
    },
    me: {
      updateProfile: (b: Record<string, unknown>) => patch<{ profile: Profile }>('/v1/me/profile', b),
      setInterests: (topics: string[]) => put<{ interests: string[] }>('/v1/me/interests', { topics }),
      /** `steps` is recorded (counts only) in the onboarding_completed analytics event. */
      completeOnboarding: (b: { platform?: 'web' | 'mobile'; steps?: OnboardingStep[] } = {}) => post('/v1/me/onboarding/complete', b),
      /** `kind: 'creators'` suggests people who post publicly, for onboarding. */
      suggestions: (o: { kind?: 'people' | 'creators'; limit?: number } = {}) =>
        get<{ items: { user: PublicUser; bio: string; reason: string }[] }>(`/v1/me/suggestions${qs(o)}`),
      sharing: () => get<{ settings: SharingSettings }>('/v1/me/sharing'),
      setSharing: (b: Partial<Pick<SharingSettings, 'findableByContacts' | 'allowDownload'>>) => put<{ settings: SharingSettings }>('/v1/me/sharing', b),
      /** Who may tag you in photos. */
      tagging: () => get<{ allowFrom: TagPermission }>('/v1/me/tagging'),
      setTagging: (allowFrom: TagPermission) => put<{ allowFrom: TagPermission }>('/v1/me/tagging', { allowFrom }),
      /** Words and phrases hidden from comments on your posts. */
      hiddenWords: () => get<{ words: string[] }>('/v1/me/hidden-words'),
      /** Replace your hidden words; comments already on your posts are checked again. */
      setHiddenWords: (words: string[]) => put<{ words: string[] }>('/v1/me/hidden-words', { words }),
      /** Data saver as saved on the account (also Me.dataSaver). Each device may override it locally. */
      dataSaver: () => get<{ mode: DataSaverMode }>('/v1/me/data-saver'),
      setDataSaver: (mode: DataSaverMode) => put<{ mode: DataSaverMode }>('/v1/me/data-saver', { mode }),
      /** "Languages I understand" and "Translate automatically" (also Me.translation). */
      translation: () => get<TranslationSettings>('/v1/me/translation'),
      setTranslation: (b: TranslationSettings) => put<TranslationSettings>('/v1/me/translation', b),
      /** Posts and reels you've been invited to co-author and haven't answered yet, newest first. */
      collabInvites: () => get<{ items: Post[] }>('/v1/me/collab-invites'),
      friendRequests: () => get<{ items: { id: string; from: PublicUser; createdAt: string }[] }>('/v1/me/friend-requests'),
      acceptFriend: (id: string) => post(`/v1/friend-requests/${id}/accept`),
      declineFriend: (id: string) => post(`/v1/friend-requests/${id}/decline`),
      preferences: () => get<{ notifications: Record<string, boolean>; attention: Record<string, unknown> }>('/v1/me/preferences'),
      /** Email, phone, date of birth and when the account was made (Settings > Account). */
      account: () => get<{ account: AccountInfo }>('/v1/me/account'),
      /** Who can message, comment on and mention you; quiet hours; sensitive media. */
      interactions: () => get<{ settings: InteractionSettings }>('/v1/me/interactions'),
      setInteractions: (b: Partial<Omit<InteractionSettings, 'sensitiveLocked'>>) => put<{ settings: InteractionSettings }>('/v1/me/interactions', b),
      /** "Report a problem" from Settings > Help. */
      reportProblem: (b: { body: string; platform: 'web' | 'ios' | 'android' | 'other'; appVersion?: string; page?: string }) =>
        post<{ report: { id: string } }>('/v1/me/problems', b),
      muted: () => get<{ items: PublicUser[] }>('/v1/me/muted'),
      restricted: () => get<{ items: PublicUser[] }>('/v1/me/restricted'),
      setNotificationPrefs: (categories: Record<string, boolean>) => put('/v1/me/preferences/notifications', { categories }),
      setAttention: (b: Record<string, unknown>) => put('/v1/me/preferences/attention', b),
      privacy: () => get<{ consents: { purpose: string; granted: boolean }[]; dataSummary: Record<string, number>; requests: unknown[] }>('/v1/me/privacy'),
      setConsent: (purpose: string, granted: boolean) => put('/v1/me/consents', { purpose, granted }),
      exportData: () => get<Record<string, unknown>>('/v1/me/export'),
      deleteAccount: (password: string) => del('/v1/me', { password }),
      /** Everything you saved, newest first, with your notes (post.viewer.note). */
      saved: (filter?: SavedFilter, cursor?: string) => get<Page<Post>>(`/v1/me/saved${qs({ filter, cursor })}`),
      circles: () => get<{ items: Circle[] }>('/v1/me/circles'),
      /** Make one of your uploaded photos your cover. Refused (409 media_processing) until the photo has been prepared. */
      setCover: (mediaId: string, altText?: string) => put<{ profile: Profile }>('/v1/me/cover', { mediaId, altText }),
      /** setCover, trying again while the photo is still being prepared (up to about a minute). */
      setCoverWhenReady: async (mediaId: string, altText?: string, o: { intervalMs?: number; timeoutMs?: number } = {}) => {
        const started = Date.now();
        for (;;) {
          try {
            return await put<{ profile: Profile }>('/v1/me/cover', { mediaId, altText });
          } catch (e) {
            if (!(e instanceof ApiError) || e.code !== 'media_processing' || Date.now() - started > (o.timeoutMs ?? 60_000)) throw e;
          }
          await new Promise((r) => setTimeout(r, o.intervalMs ?? 1200));
        }
      },
      removeCover: () => del<{ profile: Profile }>('/v1/me/cover'),
      /** Your "Now" status, with who it's for, or null. */
      status: () => get<{ status: NowStatus | null }>('/v1/me/status'),
      /** Set your "Now" status (up to 60 characters). It ends after 24 hours. */
      setStatus: (b: { text: string; icon?: NowStatusIcon | null; audience?: NowStatusAudience }) => put<{ status: NowStatus }>('/v1/me/status', b),
      clearStatus: () => del<{ status: null }>('/v1/me/status'),
      moderation: () =>
        get<{ items: { id: string; target_type: string; decision: string; status: string; appeal_status: string | null }[] }>('/v1/me/moderation'),
    },
    /** Confirming a phone number (an alternative to confirming the email address). */
    verification: {
      status: () => get<VerificationStatus>('/v1/me/verification'),
      setPhone: (phone: string) => put<VerificationStatus>('/v1/me/phone', { phone }),
      removePhone: () => del<VerificationStatus>('/v1/me/phone'),
      sendCode: () => post<{ sent: boolean; alreadyVerified?: boolean; expiresInSeconds?: number; resendAfterSeconds?: number }>('/v1/me/phone/code'),
      verifyPhone: (code: string) => post<VerificationStatus>('/v1/me/phone/verify', { code }),
    },
    topics: () => get<{ items: { slug: string; name: string }[] }>('/v1/topics'),
    feed: (mode: FeedMode, cursor?: string) => get<Page<Post> & { mode: FeedMode }>(`/v1/feed${qs({ mode, cursor })}`),
    feedback: (b: { signal: string; postId?: string; authorId?: string; topic?: string }) => post('/v1/feed/feedback', b),
    posts: {
      create: (b: Record<string, unknown>) => post<{ post: Post; moderation?: { status: string; message: string } }>('/v1/posts', b),
      get: (id: string) => get<{ post: Post }>(`/v1/posts/${id}`),
      remove: (id: string) => del(`/v1/posts/${id}`),
      /** Change your post's text, who can see it, or its photo descriptions. */
      edit: (id: string, b: EditPostInput) => patch<{ post: Post; moderation?: { status: string; message: string } }>(`/v1/posts/${id}`, b),
      /** Every version of an edited post's text, newest first. */
      history: (id: string) => get<{ items: PostVersion[] }>(`/v1/posts/${id}/history`),
      like: (id: string) => put<{ liked: boolean; likes: number }>(`/v1/posts/${id}/reaction`, { kind: 'like' }),
      unlike: (id: string) => del<{ liked: boolean; likes: number }>(`/v1/posts/${id}/reaction`),
      save: (id: string) => put(`/v1/posts/${id}/save`),
      view: (id: string) => post<{ views: number }>(`/v1/posts/${id}/view`),
      pin: (postId: string | null) => put<{ pinnedPostId: string | null }>('/v1/me/pinned-post', { postId }),
      repost: (id: string) => put<{ reposted: boolean; reposts: number }>(`/v1/posts/${id}/repost`),
      unrepost: (id: string) => del<{ reposted: boolean; reposts: number }>(`/v1/posts/${id}/repost`),
      /** Who reposted a post, newest first (private accounts only for their followers). */
      reposters: (id: string, cursor?: string) => get<Page<PublicUser>>(`/v1/posts/${id}/reposters${qs({ cursor })}`),
      /** Unsave; the post also comes off the boards you own. */
      unsave: (id: string) => del(`/v1/posts/${id}/save`),
      /** Whether you saved it, your private note, and which of your boards it's on. */
      saveState: (id: string) => get<{ saved: boolean; note: string; boardIds: string[] }>(`/v1/posts/${id}/save`),
      /** Your private note on a save (saves the post if needed). An empty note clears it. */
      setSaveNote: (id: string, note: string) => put<{ saved: true; note: string }>(`/v1/posts/${id}/save/note`, { note }),
      vote: (id: string, optionId: string) => post<{ poll: Post['poll'] }>(`/v1/posts/${id}/vote`, { optionId }),
      why: (id: string) => get<{ reasons: string[] }>(`/v1/posts/${id}/why`),
      /** Top-level comments, Top (default) or Newest; the pinned one first. Replies: comments.replies. */
      comments: (id: string, cursor?: string, sort?: CommentSort) => get<CommentPage>(`/v1/posts/${id}/comments${qs({ sort, cursor })}`),
      /** Comment, or reply with `parentId` (a reply to a reply joins the top-level thread). */
      comment: (id: string, body: string, parentId?: string, atMs?: number) =>
        post<{ comment: Comment }>(`/v1/posts/${id}/comments`, { body, parentId, ...(atMs === undefined ? {} : { atMs }) }),
      /** Reels: comments anchored to a time in the video, in time order, for the bubbles on the scrubber. */
      momentComments: (id: string) => get<{ items: ReelMoment[] }>(`/v1/posts/${id}/moment-comments`),
      /** Reels, creator only: replace the named highlights in the video (an empty list removes them). */
      setHighlights: (id: string, highlights: ReelHighlight[]) => put<{ highlights: ReelHighlight[] }>(`/v1/posts/${id}/highlights`, { highlights }),
      /** Reels: where you are, to continue from there next time (early or final positions clear it). */
      resume: (id: string, positionMs: number, durationMs?: number) =>
        put<{ resumeMs: number | null }>(`/v1/posts/${id}/resume`, { positionMs, ...(durationMs ? { durationMs } : {}) }),
      clearResume: (id: string) => del<{ resumeMs: null }>(`/v1/posts/${id}/resume`),
      /** Author: who can comment. */
      setCommentPolicy: (id: string, policy: CommentPolicy) => put<{ commentPolicy: CommentPolicy }>(`/v1/posts/${id}/comment-settings`, { policy }),
      /** Author: pin one top-level comment to the top, or unpin with null. */
      pinComment: (id: string, commentId: string | null) =>
        commentId
          ? put<{ pinnedCommentId: string | null }>(`/v1/posts/${id}/pinned-comment`, { commentId })
          : del<{ pinnedCommentId: string | null }>(`/v1/posts/${id}/pinned-comment`),
      /** Author: comments hidden by your hidden words. */
      hiddenComments: (id: string, cursor?: string) => get<Page<Comment>>(`/v1/posts/${id}/comments/hidden${qs({ cursor })}`),
      /** Duets and remixes of a reel, newest first. */
      remixes: (id: string, mode?: 'duet' | 'remix', cursor?: string) => get<Page<Post>>(`/v1/posts/${id}/remixes${qs({ mode, cursor })}`),
      /** Allow or stop duets and remixes of your reel. */
      setAllowRemix: (id: string, allowRemix: boolean) => put<{ allowRemix: boolean }>(`/v1/posts/${id}/remix-settings`, { allowRemix }),
      /** Ask for a reel as a watermarked video to share elsewhere; poll shareVideoStatus until it's ready. */
      shareVideo: (id: string) => post<ShareVideoState>(`/v1/posts/${id}/share-video`),
      shareVideoStatus: (id: string) => get<ShareVideoState>(`/v1/posts/${id}/share-video`),
      /** Original author: invite more co-authors (at most 3 in all). */
      inviteCollaborators: (id: string, userIds: string[]) => post<{ post: Post }>(`/v1/posts/${id}/collaborators`, { userIds }),
      /** Original author: cancel an invite or take a co-author off the post. */
      removeCollaborator: (id: string, userId: string) => del<{ post: Post }>(`/v1/posts/${id}/collaborators/${userId}`),
      /** Invitee: accept co-authoring. The post then shows on your profile and reaches your followers. */
      acceptCollab: (id: string) => post<{ post: Post }>(`/v1/posts/${id}/collab/accept`),
      declineCollab: (id: string) => post<{ ok: true }>(`/v1/posts/${id}/collab/decline`),
      /** Co-author: leave the post. It comes off your profile; the original author keeps it. */
      leaveCollab: (id: string) => del<{ ok: true }>(`/v1/posts/${id}/collab`),
      /** Original author: tag someone in one of the post's photos. */
      addTag: (id: string, b: { mediaId: string; userId: string; x: number; y: number }) => post<{ tag: PhotoTag }>(`/v1/posts/${id}/tags`, b),
      /** The original author, or the person tagged, removes a photo tag. */
      removeTag: (id: string, tagId: string) => del<{ ok: true }>(`/v1/posts/${id}/tags/${tagId}`),
    },
    /** Your drafts and scheduled posts (create them with posts.create and `draft: true` or `scheduledAt`). */
    comments: {
      replies: (id: string, cursor?: string) => get<Page<Comment>>(`/v1/comments/${id}/replies${qs({ cursor })}`),
      /** Within COMMENT_EDIT_MINUTES of posting it. */
      edit: (id: string, body: string) => patch<{ comment: Comment }>(`/v1/comments/${id}`, { body }),
      remove: (id: string) => del<{ ok: true; comments: number }>(`/v1/comments/${id}`),
      like: (id: string) => put<{ liked: boolean; likes: number }>(`/v1/comments/${id}/like`),
      unlike: (id: string) => del<{ liked: boolean; likes: number }>(`/v1/comments/${id}/like`),
      /** Only the comment's writer can see who liked it. */
      likers: (id: string, cursor?: string) => get<Page<PublicUser>>(`/v1/comments/${id}/likes${qs({ cursor })}`),
      /** Post author: let a hidden comment through. */
      unhide: (id: string) => post<{ comment: Comment }>(`/v1/comments/${id}/unhide`),
    },
    drafts: {
      list: () => get<{ items: Post[] }>('/v1/me/drafts'),
      get: (id: string) => get<DraftDetail>(`/v1/drafts/${id}`),
      /** Save what the composer has now; `scheduledAt` also moves it to that time. */
      save: (id: string, b: Record<string, unknown>) => put<{ post: Post }>(`/v1/drafts/${id}`, b),
      publish: (id: string) => post<{ post: Post; moderation?: { status: string; message: string } }>(`/v1/drafts/${id}/publish`),
      schedule: (id: string, scheduledAt: string) => put<{ post: Post }>(`/v1/drafts/${id}/schedule`, { scheduledAt }),
      /** Cancel a scheduled post: it goes back to your drafts. */
      unschedule: (id: string) => del<{ post: Post }>(`/v1/drafts/${id}/schedule`),
      remove: (id: string) => del<{ ok: true }>(`/v1/drafts/${id}`),
    },
    sounds: {
      /** Sounds you can use in a reel, most used first; `q` matches the name or its owner. */
      list: (q = '', limit = 12) => get<{ items: Sound[] }>(`/v1/sounds${qs({ q, limit })}`),
      get: (id: string) => get<{ sound: Sound }>(`/v1/sounds/${id}`),
      rename: (id: string, title: string) => patch<{ sound: Sound }>(`/v1/sounds/${id}`, { title }),
      reels: (id: string, sort: 'recent' | 'top' = 'recent', cursor?: string) => get<Page<Post>>(`/v1/sounds/${id}/reels${qs({ sort, cursor })}`),
    },
    /**
     * Music for reels, posts and stories: in-app sounds and songs from the catalogue providers that are
     * on. Each song carries its licence; business accounts only get songs cleared for commercial use.
     */
    music: {
      sources: () => get<{ items: MusicSourceInfo[] }>('/v1/music/sources'),
      list: (p: { q?: string; tab?: MusicTab; source?: MusicSource; limit?: number } = {}) =>
        get<{ items: MusicTrack[]; sources: MusicSourceInfo[] }>(`/v1/music${qs(p)}`),
      track: (id: string) => get<{ track: MusicTrack }>(`/v1/music/tracks/${id}`),
      posts: (id: string, cursor?: string) => get<Page<Post>>(`/v1/music/tracks/${id}/posts${qs({ cursor })}`),
      /** Save a song or a sound for later (the picker's Saved tab), or take it off. */
      save: (track: Pick<MusicTrack, 'id' | 'source'>, on: boolean) => {
        const path = track.source === 'library' ? `/v1/sounds/${track.id}/save` : `/v1/music/tracks/${track.id}/save`;
        return on ? put<{ saved: boolean }>(path) : del<{ saved: boolean }>(path);
      },
    },
    /** Your circles. Only you see them; nobody is told which circles they're in. */
    circles: {
      list: () => get<{ items: Circle[] }>('/v1/me/circles'),
      get: (id: string) => get<{ circle: Circle }>(`/v1/me/circles/${id}`),
      create: (b: { name: string; kind?: CircleKind }) => post<{ circle: Circle }>('/v1/me/circles', b),
      update: (id: string, b: { name?: string; kind?: CircleKind }) => patch<{ circle: Circle }>(`/v1/me/circles/${id}`, b),
      remove: (id: string) => del<{ ok: true }>(`/v1/me/circles/${id}`),
      members: (id: string) => get<{ items: PublicUser[] }>(`/v1/me/circles/${id}/members`),
      addMembers: (id: string, userIds: string[]) => post<{ ok: true; added: number; circle: Circle }>(`/v1/me/circles/${id}/members`, { userIds }),
      removeMember: (id: string, userId: string) => del<{ ok: true; circle: Circle }>(`/v1/me/circles/${id}/members/${userId}`),
    },
    closeFriends: {
      list: () => get<{ items: { user: PublicUser; addedAt: string; followsYou: boolean }[] }>('/v1/me/close-friends'),
      add: (userId: string) => put<{ closeFriend: boolean }>(`/v1/me/close-friends/${userId}`),
      remove: (userId: string) => del<{ closeFriend: boolean }>(`/v1/me/close-friends/${userId}`),
    },
    /** Your expired stories, private to you. `month` is YYYY-MM (UTC). */
    archive: {
      months: () => get<{ items: { month: string; count: number }[] }>('/v1/me/archive/months'),
      list: (month?: string) => get<{ items: ArchivedStory[] }>(`/v1/me/archive${qs({ month })}`),
      remove: (id: string) => del<{ ok: true }>(`/v1/me/archive/${id}`),
    },
    chapters: {
      /** Chapters on a profile that you may see. */
      forUser: (userId: string) => get<{ items: Chapter[] }>(`/v1/users/${userId}/chapters`),
      /** Chapters you own, contribute to or are invited to. */
      mine: () => get<{ items: Chapter[] }>('/v1/me/chapters'),
      get: (id: string) => get<ChapterDetail>(`/v1/chapters/${id}`),
      create: (b: Partial<ChapterInput> & { title: string; momentIds?: string[] }) => post<{ chapter: Chapter }>('/v1/chapters', b),
      update: (id: string, b: Partial<ChapterInput> & { coverStoryId?: string | null }) => patch<{ chapter: Chapter }>(`/v1/chapters/${id}`, b),
      remove: (id: string) => del<{ ok: true }>(`/v1/chapters/${id}`),
      seal: (id: string) => post<{ chapter: Chapter }>(`/v1/chapters/${id}/seal`),
      addStory: (id: string, momentId: string) => post<{ added: boolean }>(`/v1/chapters/${id}/stories`, { momentId }),
      removeStory: (id: string, momentId: string) => del<{ ok: true }>(`/v1/chapters/${id}/stories/${momentId}`),
      invite: (id: string, userId: string) => post<{ invited: true }>(`/v1/chapters/${id}/contributors`, { userId }),
      join: (id: string) => post<{ chapter: Chapter }>(`/v1/chapters/${id}/join`),
      /** The owner removes a contributor, or you leave (or decline) with your own id. */
      removeContributor: (id: string, userId: string) => del<{ ok: true }>(`/v1/chapters/${id}/contributors/${userId}`),
      showOnProfile: (id: string, showOnProfile: boolean) => patch<{ showOnProfile: boolean }>(`/v1/chapters/${id}/membership`, { showOnProfile }),
      guestbook: (id: string) => get<{ open: boolean; items: GuestbookEntry[] }>(`/v1/chapters/${id}/guestbook`),
      sign: (id: string, body: string) => post<{ entry: Omit<GuestbookEntry, 'author'> }>(`/v1/chapters/${id}/guestbook`, { body }),
      hideLine: (id: string, entryId: string, hidden: boolean) => put<{ hidden: boolean }>(`/v1/chapters/${id}/guestbook/${entryId}/hidden`, { hidden }),
      deleteLine: (id: string, entryId: string) => del<{ ok: true }>(`/v1/chapters/${id}/guestbook/${entryId}`),
    },
    /** Boards: named collections of saved posts, private, shared with collaborators, or public on your profile. */
    boards: {
      /** Boards you own, then ones you collaborate on or are invited to. With `postId`, each says whether that post is on it. */
      mine: (postId?: string) => get<{ items: Board[] }>(`/v1/boards${qs({ postId })}`),
      /** The Boards tab on a profile: public boards only. */
      forUser: (username: string) => get<{ items: Board[] }>(`/v1/users/${encodeURIComponent(username)}/boards`),
      get: (id: string) => get<BoardDetail>(`/v1/boards/${id}`),
      /** Posts on a board in its order, only the ones you can see, with your notes. `removable`: the ones on this page you may take off. */
      items: (id: string, filter?: SavedFilter, cursor?: string) =>
        get<Page<Post> & { removable: string[] }>(`/v1/boards/${id}/items${qs({ filter, cursor })}`),
      create: (b: { name: string; description?: string; visibility?: BoardVisibility; postIds?: string[] }) => post<{ board: Board }>('/v1/boards', b),
      /** Owner only. `coverPostId: null` goes back to the first item. */
      update: (id: string, b: { name?: string; description?: string; visibility?: BoardVisibility; coverPostId?: string | null }) =>
        patch<{ board: Board }>(`/v1/boards/${id}`, b),
      /** Owner only. The posts stay in your saves. */
      remove: (id: string) => del<{ ok: true }>(`/v1/boards/${id}`),
      addItem: (id: string, postId: string) => post<{ added: boolean }>(`/v1/boards/${id}/items`, { postId }),
      removeItem: (id: string, postId: string) => del<{ ok: true }>(`/v1/boards/${id}/items/${postId}`),
      /** The new order of the posts you can see on the board (all of them). */
      reorder: (id: string, postIds: string[]) => put<{ ok: true }>(`/v1/boards/${id}/order`, { postIds }),
      invite: (id: string, userId: string) => post<BoardDetail>(`/v1/boards/${id}/collaborators`, { userId }),
      /** Owner: take someone off or cancel an invite. */
      removeCollaborator: (id: string, userId: string) => del<{ ok: true }>(`/v1/boards/${id}/collaborators/${userId}`),
      /** Accept an invitation. */
      join: (id: string) => post<{ board: Board }>(`/v1/boards/${id}/join`),
      /** Decline an invitation or leave a board. */
      leave: (id: string) => del<{ ok: true }>(`/v1/boards/${id}/membership`),
    },
    contacts: {
      /** The salt and identifier kinds to hash with (see contactHashInput in @yapilapi/shared). */
      salt: () => get<ContactHashing>('/v1/contacts/salt'),
      /** Send only hashes, at most `maxHashes` per call. */
      match: (hashes: string[], source?: 'web' | 'mobile') => post<{ items: ContactMatch[] }>('/v1/contacts/match', { hashes, source }),
    },
    media: {
      /** `viewOnce`: stored privately for a view-once chat message (no public address; url is empty). */
      upload: async (file: File, altText?: string, o: { viewOnce?: boolean } = {}) => {
        if (opts.prepareUpload) file = await opts.prepareUpload(file);
        const fd = new FormData();
        if (altText) fd.append('altText', altText);
        fd.append('file', file);
        return req<{ media: { id: string; kind: 'image' | 'video' | 'audio'; url: string; altText: string | null } }>(
          'POST',
          `/v1/media${o.viewOnce ? '?viewOnce=true' : ''}`,
          fd,
        );
      },
      /** One of your media items, with its processing status. */
      get: (id: string) => get<{ media: MediaItemStatus }>(`/v1/media/${id}`),
      /**
       * Apply the editor to one of your uploads: a look, adjustments, crop, turn, flips, text and,
       * for videos, trim, mute and cover. Makes a new media item; wait for it with waitUntilReady.
       */
      edit: (id: string, b: EditorParamsInput) =>
        post<{ media: { id: string; kind: 'image' | 'video'; url: string; altText: string | null; status: 'processing'; editOf: string } }>(
          `/v1/media/${id}/edit`,
          b,
        ),
      /** A "Both sides" photo from two of your uploaded photos (back, and front in a corner). Wait for it with waitUntilReady. */
      dual: (b: DualComposeInput) =>
        post<{ media: { id: string; kind: 'image'; url: string; altText: string | null; status: 'processing'; editOf: string } }>(`/v1/media/dual`, b),
      /** Poll GET /v1/media/:id until it is ready (resolves) or failed (rejects). */
      waitUntilReady: async (id: string, o: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}) => {
        const started = Date.now();
        for (;;) {
          if (o.signal?.aborted) throw new ApiError(0, 'aborted', 'Stopped waiting.');
          const { media } = await get<{ media: MediaItemStatus }>(`/v1/media/${id}`);
          if (media.status === 'ready') return media;
          if (media.status === 'failed') throw new ApiError(422, 'edit_failed', media.error ?? "We couldn't apply your edits.");
          if (Date.now() - started > (o.timeoutMs ?? 10 * 60_000)) throw new ApiError(0, 'timeout', 'This is taking longer than usual. Try again in a moment.');
          await new Promise((r) => setTimeout(r, o.intervalMs ?? 1500));
        }
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
        stickers?: StoryStickerInput[];
        allowReshare?: boolean;
        /** A sound from the library, played in a loop (on a video, instead of its own sound). */
        music?: StoryMusicInput;
      }) => post<{ moment: { id: string; expiresAt: string | null; tags: string[] } }>('/v1/moments', b),
      /** One story (as a group of one), for links, story cards and notifications. */
      get: (id: string) => get<{ group: StoryGroup }>(`/v1/moments/${id}`),
      /** Your own story: whether others may reshare it. */
      update: (id: string, b: { allowReshare: boolean }) => patch<{ allowReshare: boolean }>(`/v1/moments/${id}`, b),
      /** Add a public story, or one that mentions you, to your own story. */
      reshare: (id: string, b: { body?: string; visibility?: string; expiresIn?: '1h' | '24h' | 'permanent'; stickers?: StoryStickerInput[] } = {}) =>
        post<{ moment: { id: string } }>(`/v1/moments/${id}/reshare`, b),
      /** Send a story to people or conversations as a story card. */
      send: (id: string, b: { userIds?: string[]; conversationIds?: string[]; body?: string }) =>
        post<{ conversationIds: string[]; failed: { id: string; message: string }[] }>(`/v1/moments/${id}/send`, b),
      vote: (id: string, stickerId: string, option: 0 | 1) =>
        post<{ voted: number; results: [number, number]; votes: number }>(`/v1/moments/${id}/stickers/${stickerId}/vote`, { option }),
      answer: (id: string, stickerId: string, text: string) => post<{ answered: number }>(`/v1/moments/${id}/stickers/${stickerId}/answers`, { text }),
      slide: (id: string, stickerId: string, value: number) => post<{ mine: number }>(`/v1/moments/${id}/stickers/${stickerId}/slide`, { value }),
      remind: (id: string, stickerId: string, on: boolean) =>
        on
          ? put<{ reminding: boolean }>(`/v1/moments/${id}/stickers/${stickerId}/reminder`)
          : del<{ reminding: boolean }>(`/v1/moments/${id}/stickers/${stickerId}/reminder`),
      view: (id: string) => post(`/v1/moments/${id}/view`),
      like: (id: string, liked: boolean) => put<{ liked: boolean }>(`/v1/moments/${id}/like`, { liked }),
      /** Your own story: who saw it, sticker results, reshares. */
      viewers: (id: string) =>
        get<{ items: { user: PublicUser; liked: boolean; viewedAt: string }[]; results: StickerResults[]; reshares: number; allowReshare: boolean }>(
          `/v1/moments/${id}/viewers`,
        ),
      reply: (id: string, body: string) => post<{ conversationId: string }>(`/v1/moments/${id}/reply`, { body }),
      remove: (id: string) => del(`/v1/moments/${id}`),
    },
    reels: (cursor?: string) => get<Page<Post> & { authors: Record<string, { followers: number; following: boolean }> }>(`/v1/reels${qs({ cursor })}`),
    conversations: {
      list: () => get<{ items: Conversation[] }>('/v1/conversations'),
      get: (id: string) => get<{ conversation: Conversation }>(`/v1/conversations/${id}`),
      create: (memberIds: string[], title?: string) => post<{ conversation: Conversation }>('/v1/conversations', { memberIds, title }),
      messages: (id: string, cursor?: string) => get<Page<Message>>(`/v1/conversations/${id}/messages${qs({ cursor })}`),
      /** `kind: 'yap'` sends a hold-to-talk voice clip; `viewOnce` sends one photo or video uploaded with `viewOnce`. */
      send: (
        id: string,
        body: string,
        clientId?: string,
        attachments: { mediaId: string; name?: string }[] = [],
        o: { kind?: 'message' | 'yap'; viewOnce?: boolean; replyToId?: string } = {},
      ) => post<{ message: Message; notice?: string }>(`/v1/conversations/${id}/messages`, { body, clientId, attachments, ...o }),
      /** Text search in this chat (messages you can see, since you joined), newest first. */
      search: (id: string, q: string, cursor?: string) => get<Page<Message>>(`/v1/conversations/${id}/search${qs({ q, cursor })}`),
      /** Pinned messages (up to 3). */
      pins: (id: string) => get<{ items: PinnedMessage[]; max: number }>(`/v1/conversations/${id}/pins`),
      /** Disappearing messages: 86400, 604800 or 7776000 seconds, or null for off. */
      setDisappearing: (id: string, seconds: number | null) =>
        put<{ disappearingSeconds: number | null; message: Message | null }>(`/v1/conversations/${id}/disappearing`, { seconds }),
      /** "Let Yaps play out loud" here; null goes back to the default (on for yaps from friends). */
      setYaps: (id: string, playOutLoud: boolean | null) => put<{ yaps: ConversationYaps }>(`/v1/conversations/${id}/yaps`, { playOutLoud }),
      read: (id: string) => post(`/v1/conversations/${id}/read`),
      /** A poll: 2 to 10 options; one choice unless `multiple`; `endsAt` from 5 minutes to 30 days ahead. */
      createPoll: (
        id: string,
        input: {
          question: string;
          options: string[];
          multiple?: boolean;
          anonymous?: boolean;
          allowAddOptions?: boolean;
          endsAt?: string | null;
          clientId?: string;
        },
      ) => post<{ message: Message }>(`/v1/conversations/${id}/polls`, input),
      /** A shared list (checklist) with its first items, up to 100. */
      createList: (id: string, input: { title: string; items?: string[]; clientId?: string }) =>
        post<{ message: Message }>(`/v1/conversations/${id}/lists`, input),
      /** Your reminders waiting in this chat. */
      reminders: (id: string) => get<{ items: ChatReminder[] }>(`/v1/conversations/${id}/reminders`),
      createPlan: (id: string, title: string, details: Record<string, unknown>) => post(`/v1/conversations/${id}/plans`, { title, details }),
      plans: (id: string) => get<{ items: { id: string; title: string; details: Record<string, unknown>; status: string }[] }>(`/v1/conversations/${id}/plans`),
    },
    messages: {
      /** Edit your own message's text, within 15 minutes of sending it. */
      edit: (id: string, body: string) => patch<{ message: Message }>(`/v1/messages/${id}`, { body }),
      /** Unsend for everyone: a "Message unsent" line stays in its place. */
      unsend: (id: string) => post<{ message: Message | null }>(`/v1/messages/${id}/unsend`),
      /** Delete for me: gone from your view of the chat only. */
      deleteForMe: (id: string) => post<{ ok: true }>(`/v1/messages/${id}/delete-for-me`),
      react: (id: string, emoji: string) => put<{ ok: true }>(`/v1/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
      unreact: (id: string, emoji: string) => del<{ ok: true }>(`/v1/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
      pin: (id: string) => put<{ items: PinnedMessage[] }>(`/v1/messages/${id}/pin`),
      unpin: (id: string) => del<{ items: PinnedMessage[] }>(`/v1/messages/${id}/pin`),
      /** Vote, change your vote, or take it back (an empty list). */
      vote: (id: string, optionIds: string[]) => put<{ poll: ChatPoll | null }>(`/v1/messages/${id}/poll/vote`, { optionIds }),
      addPollOption: (id: string, text: string) => post<{ poll: ChatPoll | null }>(`/v1/messages/${id}/poll/options`, { text }),
      /** End the poll now (the person who made it). */
      endPoll: (id: string) => post<{ poll: ChatPoll | null }>(`/v1/messages/${id}/poll/end`),
      addListItem: (id: string, text: string) => post<{ list: ChatList | null }>(`/v1/messages/${id}/list/items`, { text }),
      /** Tick an item off, or back on. */
      tickListItem: (id: string, itemId: string, done: boolean) => patch<{ list: ChatList | null }>(`/v1/messages/${id}/list/items/${itemId}`, { done }),
      removeListItem: (id: string, itemId: string) => del<{ list: ChatList | null }>(`/v1/messages/${id}/list/items/${itemId}`),
      /** Every item, in the new order. */
      reorderList: (id: string, itemIds: string[]) => put<{ list: ChatList | null }>(`/v1/messages/${id}/list/order`, { itemIds }),
      /** "Remind me" at a time (just you), or "Remind the group" (group admins). */
      remind: (id: string, at: string, scope: 'me' | 'group' = 'me') => post<{ reminder: ChatReminder }>(`/v1/messages/${id}/reminders`, { at, scope }),
      cancelReminder: (reminderId: string) => del<{ ok: true }>(`/v1/reminders/${reminderId}`),
    },
    yaps: {
      /** "Pause Yaps" everywhere. */
      settings: () => get<{ paused: boolean }>('/v1/me/yaps'),
      setPaused: (paused: boolean) => put<{ paused: boolean }>('/v1/me/yaps', { paused }),
    },
    viewOnce: {
      /** A link to the file that works for a few minutes, only for you. Fetch it with `file`. */
      open: (messageId: string) => post<{ url: string; expiresAt: string; kind: string; mime: string | null }>(`/v1/messages/${messageId}/view-once/open`),
      /** Closed: it can't be opened again. */
      viewed: (messageId: string) => post<{ viewOnce: ViewOnceInfo }>(`/v1/messages/${messageId}/view-once/viewed`),
      /** A screenshot was detected while it was open; the sender is told. */
      screenshot: (messageId: string) => post<{ ok: true }>(`/v1/messages/${messageId}/view-once/screenshot`),
      /** Download the file behind a link from `open` (signed in, never cached). */
      file: async (url: string): Promise<Blob> => {
        const headers: Record<string, string> = {};
        if (opts.token) headers.authorization = `Bearer ${opts.token}`;
        let res: Response;
        try {
          res = await f(`${opts.baseUrl}${url}`, { headers, credentials: 'include', cache: 'no-store' });
        } catch {
          throw new ApiError(0, 'network', "Can't reach YAPILAPI. Check your connection and try again.");
        }
        if (!res.ok) {
          const e = ((await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null)?.error ?? {};
          throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'This photo or video is no longer available.');
        }
        return res.blob();
      },
    },
    communities: {
      list: (scope: 'discover' | 'mine' = 'discover') => get<{ items: Community[] }>(`/v1/communities${qs({ scope })}`),
      get: (slug: string) => get<{ community: Community & { membershipStatus: string | null }; chatConversationId: string | null }>(`/v1/communities/${slug}`),
      create: (b: Record<string, unknown>) => post<{ community: Community }>('/v1/communities', b),
      join: (slug: string) => post<{ status: string }>(`/v1/communities/${slug}/join`),
      leave: (slug: string) => post(`/v1/communities/${slug}/leave`),
      posts: (slug: string, cursor?: string) => get<Page<Post> & { locked?: boolean }>(`/v1/communities/${slug}/posts${qs({ cursor })}`),
      /** Members; moderators can also ask for `pending` join requests and `banned` people. */
      members: (slug: string, status: 'active' | 'pending' | 'banned' = 'active') =>
        get<{ items: { user: PublicUser; role: string; joinedAt?: string }[] }>(`/v1/communities/${slug}/members${status === 'active' ? '' : qs({ status })}`),
      /** Admins and owners change the name, description, who can join, topics and rules. */
      update: (slug: string, b: Partial<{ name: string; description: string; visibility: 'public' | 'private'; topics: string[]; rules: string[] }>) =>
        patch<{ community: Community & { membershipStatus: string | null } }>(`/v1/communities/${slug}`, b),
      approve: (slug: string, userId: string) => post<{ ok: true }>(`/v1/communities/${slug}/members/${userId}/approve`),
      decline: (slug: string, userId: string) => post<{ ok: true }>(`/v1/communities/${slug}/members/${userId}/decline`),
      setRole: (slug: string, userId: string, role: 'admin' | 'moderator' | 'organizer' | 'member' | 'guest') =>
        put<{ role: string }>(`/v1/communities/${slug}/members/${userId}/role`, { role }),
      ban: (slug: string, userId: string) => post<{ ok: true }>(`/v1/communities/${slug}/members/${userId}/ban`),
      unban: (slug: string, userId: string) => post<{ ok: true }>(`/v1/communities/${slug}/members/${userId}/unban`),
      faq: (slug: string) => get<{ items: FaqEntry[]; canEdit: boolean }>(`/v1/communities/${slug}/faq`),
      addFaq: (slug: string, b: { question: string; answer: string }) => post<{ faq: FaqEntry }>(`/v1/communities/${slug}/faq`, b),
      updateFaq: (slug: string, id: string, b: Partial<{ question: string; answer: string; position: number }>) =>
        patch<{ faq: FaqEntry }>(`/v1/communities/${slug}/faq/${id}`, b),
      deleteFaq: (slug: string, id: string) => del(`/v1/communities/${slug}/faq/${id}`),
      similar: (slug: string, q: string) =>
        get<{ faq: (FaqEntry & { score: number })[]; posts: { post: Post; score: number }[] }>(`/v1/communities/${slug}/similar${qs({ q })}`),
      rooms: (slug: string) =>
        get<{ items: RoomSummary[]; canStart: boolean; locked?: boolean; limits?: { speakers: number; listeners: number } }>(`/v1/communities/${slug}/rooms`),
      /** Start a room now, or schedule it with `scheduledFor` (ISO time). Moderators, admins and owners only. */
      startRoom: (slug: string, b: { title: string; scheduledFor?: string }) => post<{ room: RoomSummary }>(`/v1/communities/${slug}/rooms`, b),
    },
    /** Live audio rooms. Audio is WebRTC (see RoomMediaSession); these calls manage who is in the room and relay signaling. */
    rooms: {
      get: (id: string) => get<RoomEnvelope>(`/v1/rooms/${id}`),
      join: (id: string) => post<RoomEnvelope>(`/v1/rooms/${id}/join`),
      leave: (id: string) => post<{ ok: true }>(`/v1/rooms/${id}/leave`),
      heartbeat: (id: string) => post<{ ok: true }>(`/v1/rooms/${id}/heartbeat`),
      start: (id: string) => post<{ room: RoomSummary }>(`/v1/rooms/${id}/start`),
      end: (id: string) => post<{ room: RoomSummary }>(`/v1/rooms/${id}/end`),
      remind: (id: string, on: boolean) => post<{ remindMe: boolean }>(`/v1/rooms/${id}/remind`, { on }),
      hand: (id: string, raised: boolean) => post<{ raised: boolean }>(`/v1/rooms/${id}/hand`, { raised }),
      mute: (id: string, muted: boolean) => post<{ muted: boolean }>(`/v1/rooms/${id}/mute`, { muted }),
      /** Accept a host's invite to speak (hosts step up without one), or decline it. */
      speak: (id: string, accept = true) => post<{ role: 'speaker' | 'listener' }>(`/v1/rooms/${id}/speak`, { accept }),
      invite: (id: string, userId: string) => post<{ ok: true }>(`/v1/rooms/${id}/participants/${userId}/invite`),
      muteSpeaker: (id: string, userId: string) => post<{ ok: true }>(`/v1/rooms/${id}/participants/${userId}/mute`),
      /** Back to listening: a host moving a speaker, or a speaker stepping down (their own id). */
      toListener: (id: string, userId: string) => post<{ ok: true }>(`/v1/rooms/${id}/participants/${userId}/listener`),
      remove: (id: string, userId: string) => post<{ ok: true }>(`/v1/rooms/${id}/participants/${userId}/remove`),
      react: (id: string, kind: RoomReaction) => post<{ ok: true }>(`/v1/rooms/${id}/reactions`, { kind }),
      signal: (id: string, toUserId: string, type: 'offer' | 'answer' | 'candidate', data: unknown) =>
        post<{ ok: true }>(`/v1/rooms/${id}/signal`, { toUserId, type, data }),
    },
    events: {
      list: (scope: 'upcoming' | 'going' | 'hosting' | 'now' = 'upcoming') => get<{ items: EventItem[] }>(`/v1/events${qs({ scope })}`),
      get: (id: string) => get<{ event: EventItem }>(`/v1/events/${id}`),
      create: (b: Record<string, unknown>) => post<{ event: EventItem }>('/v1/events', b),
      /** The host changes an event; null clears an optional field. */
      update: (id: string, b: Record<string, unknown>) => patch<{ event: EventItem }>(`/v1/events/${id}`, b),
      /** The host cancels an event; people who answered are told. */
      cancel: (id: string) => del<{ ok: true }>(`/v1/events/${id}`),
      rsvp: (id: string, status: 'going' | 'interested' | 'not_going') => post<{ status: string; event: EventItem }>(`/v1/events/${id}/rsvp`, { status }),
      attendees: (id: string) => get<{ items: { user: PublicUser; status: string }[] }>(`/v1/events/${id}/attendees`),
    },
    places: {
      list: (params: Record<string, unknown> = {}) => get<{ items: Record<string, any>[] }>(`/v1/places${qs(params)}`),
      get: (id: string) => get<{ place: Record<string, any>; events: EventItem[]; products: Record<string, any>[] }>(`/v1/places/${id}`),
      /** Room left at each time (ISO), counted like a booking request. `left` is null when the place sets no limit. */
      availability: (id: string, at: string[]) =>
        get<{ takesBookings: boolean; capacity: number | null; slots: { startsAt: string; left: number | null }[] }>(
          `/v1/places/${id}/availability${qs({ at: at.join(',') })}`,
        ),
    },
    businesses: {
      mine: () => get<{ items: { id: string; slug: string; name: string }[] }>('/v1/me/businesses'),
      analytics: (id: string, days = 30) => get<BusinessAnalytics>(`/v1/businesses/${id}/analytics${qs({ days })}`),
      get: (slug: string) => get<{ business: Record<string, any>; places: Record<string, any>[]; products: Record<string, any>[] }>(`/v1/businesses/${slug}`),
    },
    people: {
      /** People to add to a conversation: connections first, prefix matches as you type. */
      /**
       * `scope=followers`: people who follow you. `scope=mutuals`: people you follow who follow you back and whom
       * you can invite to co-author a post. `canTag` says whether you may tag them in a photo.
       */
      suggest: (q = '', limit = 8, scope?: 'all' | 'followers' | 'mutuals') =>
        get<{ items: { user: PublicUser; relation: 'friend' | 'following' | null; canMessage: boolean; canTag: boolean }[] }>(
          `/v1/people/suggest${qs({ q, limit, scope })}`,
        ),
    },
    payments: {
      /** The default provider, and providers that take particular currencies (Paystack: NGN, GHS, KES, ZAR). */
      config: () => get<PaymentsConfig>('/v1/payments/config'),
      /** Development provider only: finish a test payment. */
      devComplete: (orderId: string) => post<{ status: string }>('/v1/payments/dev/complete', { orderId }),
    },
    orders: {
      create: (items: { productId: string; quantity: number }[], idempotencyKey: string, liveSessionId?: string) =>
        post<{ order: Record<string, any>; payment?: CheckoutPayment }>('/v1/orders', { items, idempotencyKey, liveSessionId }),
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
      /** "Stories now": active public stories with the tag. */
      stories: (tag: string) => get<{ items: StoryGroup[] }>(`/v1/tags/${encodeURIComponent(tag)}/stories`),
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
    /**
     * "See translation": a post, comment, story or message machine-translated into `target`.
     * Errors: 503 translation_off (turned off) or translation_unavailable (not working right now), 429 translation_limit, 404 when not visible.
     */
    translate: (b: { kind: TranslatableKind; id: string; target: string }) => post<{ translation: Translation }>('/v1/translate', b),
    ai: {
      assist: (b: { task: string; input?: string; conversationId?: string; communityId?: string; targetLanguage?: string }) =>
        post<{ output: unknown; provider: string; model: string; notice?: string; contextScopes: string[] }>('/v1/ai/assist', b),
      memories: () => get<{ items: { id: string; content: string; created_at: string }[] }>('/v1/ai/memories'),
      addMemory: (content: string) => post('/v1/ai/memories', { content }),
      deleteMemory: (id: string) => del(`/v1/ai/memories/${id}`),
    },
    creator: {
      /** The last 28 days: totals (views count each person once per post, reach once overall), top posts and reels, new followers per day. */
      analytics: () => get<CreatorAnalytics>('/v1/creator/analytics'),
      /** One of your posts (or one you co-authored): counts and views per day over the last 28 days. */
      postInsights: (postId: string) => get<{ insights: PostInsights }>(`/v1/posts/${postId}/insights`),
      /** What you earned from sales, subscriptions and tips, per currency, less fees and payouts. */
      earnings: () => get<{ balances: { currency: string; grossCents: number; feeCents: number; availableCents: number }[] }>('/v1/me/earnings'),
      /** Your payout requests and where each one is. */
      payouts: () => get<{ items: Payout[] }>('/v1/me/payouts'),
      /** Paid tips you got or sent; ones sent during a live are gifts. */
      tips: (direction: 'received' | 'sent' = 'received') => get<{ direction: 'received' | 'sent'; items: TipRecord[] }>(`/v1/me/tips${qs({ direction })}`),
    },
    flags: () => get<{ flags: Record<string, boolean> }>('/v1/flags'),
    /** What anyone can see of a shared link without an account (link previews, signed-out views). */
    public: {
      post: (id: string) => get<{ post: PublicPostPreview }>(`/v1/public/posts/${encodeURIComponent(id)}`),
      user: (username: string) => get<{ profile: PublicProfilePreview }>(`/v1/public/users/${encodeURIComponent(username)}`),
      event: (id: string) => get<{ event: PublicEventPreview }>(`/v1/public/events/${encodeURIComponent(id)}`),
      community: (slug: string) => get<{ community: PublicCommunityPreview }>(`/v1/public/communities/${encodeURIComponent(slug)}`),
      sitemap: () => get<PublicSitemap>('/v1/public/sitemap'),
    },
    passkeys: {
      list: () => get<{ items: { id: string; label: string; created_at: string; last_used_at: string | null; backed_up: boolean }[] }>('/v1/auth/passkeys'),
      registerOptions: () => post<{ options: any; challengeId: string }>('/v1/auth/passkeys/register/options'),
      registerVerify: (challengeId: string, response: unknown, label: string) => post('/v1/auth/passkeys/register/verify', { challengeId, response, label }),
      remove: (id: string) => del(`/v1/auth/passkeys/${id}`),
      loginOptions: () => post<{ options: any; challengeId: string }>('/v1/auth/passkeys/login/options'),
      loginVerify: (challengeId: string, response: unknown, remember?: boolean) =>
        post<{ user: Me; token: string }>('/v1/auth/passkeys/login/verify', { challengeId, response, ...(remember === false ? { remember } : {}) }),
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
        post<{ subscription: { id: string; status: string }; payment: CheckoutPayment }>(`/v1/creator/plans/${planId}/subscribe`, {
          idempotencyKey,
        }),
      tip: (userId: string, b: { amountCents: number; currency: string; message?: string; postId?: string; liveId?: string; idempotencyKey: string }) =>
        post<{ payment: CheckoutPayment }>(`/v1/users/${userId}/tips`, b),
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
        get<{
          items: {
            id: string;
            status: string;
            party_size: number;
            starts_at: string;
            place_id: string | null;
            place_name: string | null;
            product_id: string | null;
            product_title: string | null;
          }[];
        }>('/v1/me/bookings'),
      forPlace: (placeId: string) =>
        get<{ items: { id: string; status: string; party_size: number; starts_at: string; note: string; guest: string }[] }>(`/v1/places/${placeId}/bookings`),
      decide: (id: string, confirm: boolean) => post(`/v1/bookings/${id}/decide`, { confirm }),
      cancel: (id: string) => post(`/v1/bookings/${id}/cancel`),
    },
    uploads: {
      /** Chunked, resumable upload. Retries each chunk and resumes from what the server already has. */
      resumable: async (file: File, onProgress?: (fraction: number) => void, altText?: string) => {
        if (opts.prepareUpload) file = await opts.prepareUpload(file);
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
      verify: (challengeToken: string, code: string, remember?: boolean) =>
        post<{ user: Me; token: string }>('/v1/auth/mfa/verify', { challengeToken, code, ...(remember === false ? { remember } : {}) }),
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
      update: (id: string, b: { title?: string; description?: string }) => patch<{ memory: MemorySummary }>(`/v1/memories/${id}`, b),
      remove: (id: string) => del(`/v1/memories/${id}`),
      suggestions: () => get<{ events: EventItem[]; onThisDay: Post[] }>('/v1/memories/suggestions'),
      fromEvent: (eventId: string) => post<{ memoryId: string }>(`/v1/memories/from-event/${eventId}`),
      addItem: (id: string, itemType: 'post' | 'moment' | 'event', itemId: string) => post(`/v1/memories/${id}/items`, { itemType, itemId }),
      removeItem: (id: string, itemType: string, itemId: string) => del(`/v1/memories/${id}/items/${itemType}/${itemId}`),
      share: (id: string, userIds: string[]) => put<{ visibility: string }>(`/v1/memories/${id}/shares`, { userIds }),
      recap: (id: string) => post<{ recap: string; notice?: string }>(`/v1/memories/${id}/recap`),
    },
    /**
     * Recap videos from a memory, "On this day" or one of your chapters. Only you see
     * them. Post one as a reel with posts.create (format 'reel', the recap's video as
     * the media, its sound as soundId), or send it in a chat as an attachment.
     */
    recaps: {
      list: (q: { source?: RecapSource; sourceId?: string } = {}) =>
        get<{ items: Recap[]; remainingToday: number }>(`/v1/recaps${qs({ source: q.source, sourceId: q.sourceId })}`),
      candidates: (source: RecapSource, sourceId?: string) => get<RecapCandidates>(`/v1/recaps/candidates${qs({ source, sourceId })}`),
      create: (b: CreateRecapInput) => post<{ recap: Recap }>('/v1/recaps', b),
      get: (id: string) => get<{ recap: Recap }>(`/v1/recaps/${id}`),
      remove: (id: string) => del<{ ok: true; fileRemoved: boolean }>(`/v1/recaps/${id}`),
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
    shop: {
      /** What a person sells on their profile. */
      list: (userId: string) => get<{ items: ShopItem[] }>(`/v1/users/${userId}/shop`),
      create: (b: { kind: 'product' | 'digital' | 'service'; title: string; description?: string; priceCents: number; currency: string; inventory?: number }) =>
        post<{ product: { id: string; kind: string; title: string; priceCents: number; currency: string } }>('/v1/products', b),
      /** The file buyers of a digital product download (stored privately). */
      uploadFile: (productId: string, file: File | Blob, name?: string) => {
        const fd = new FormData();
        if (name) fd.append('file', file, name);
        else fd.append('file', file);
        return put<{ file: { name: string; mime: string; sizeBytes: number } }>(`/v1/products/${productId}/file`, fd);
      },
      /** A download link for something you bought. It works for a few minutes. */
      download: (productId: string) => post<{ url: string; expiresAt: string }>(`/v1/products/${productId}/download`),
      purchases: () =>
        get<{
          items: {
            productId: string;
            title: string;
            orderId: string;
            boughtAt: string;
            file: { name: string; sizeBytes: number } | null;
            seller: PublicUser;
          }[];
        }>('/v1/me/purchases'),
      book: (productId: string, b: { startsAt: string; note?: string; idempotencyKey: string }) =>
        post<{
          booking: { id: string; status: string; startsAt: string };
          payment: CheckoutPayment | null;
          amount: { cents: number; currency: string; title: string };
        }>(`/v1/products/${productId}/book`, b),
      serviceBookings: () => get<{ items: ServiceBooking[] }>('/v1/me/service-bookings'),
      sales: (days = 30) => get<SalesReport>(`/v1/me/sales${qs({ days })}`),
    },
    boosts: {
      start: (
        postId: string,
        b: {
          budgetCents: number;
          currency: string;
          days: number;
          audience: { type: 'country'; countries: string[] } | { type: 'interests'; topics: string[] };
          idempotencyKey: string;
        },
      ) =>
        post<{ boost: { campaignId: string; budgetCents: number; currency: string; days: number; estimatedImpressions: number }; payment: CheckoutPayment }>(
          `/v1/posts/${postId}/boost`,
          b,
        ),
      forPost: (postId: string) => get<{ items: Boost[] }>(`/v1/posts/${postId}/boosts`),
      mine: () => get<{ items: (Boost & { postId: string; excerpt: string })[] }>('/v1/me/boosts'),
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
        post<{ payment: CheckoutPayment }>(`/v1/ads/campaigns/${id}/fund`, { amountCents, idempotencyKey }),
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
      riskAccounts: (status: 'open' | 'reviewed' = 'open') => get<{ items: RiskAccount[] }>(`/v1/admin/risk/accounts${qs({ status })}`),
      reviewRisk: (userId: string, action: 'clear' | 'confirm', note?: string) =>
        post<{ restricted: boolean; signals: number }>(`/v1/admin/risk/accounts/${userId}/review`, { action, note }),
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
  scheduledFor: string | null;
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

/** A room with the viewer's standing in it. `media` is set while the viewer is in the room. */
export interface RoomEnvelope {
  room: RoomDetail;
  removed: boolean;
  canHost: boolean;
  media: RoomMediaSession | null;
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
  contributions: {
    id: string;
    caption: string;
    capturedAt: string;
    media: { url: string; kind: string; altText: string | null; sensitive?: boolean } | null;
    author: PublicUser;
  }[];
}

export interface VerificationStatus {
  email: { address: string; verified: boolean };
  /** E.164. */
  phone: { number: string; verified: boolean } | null;
  /** A confirmed email or phone number. */
  verified: boolean;
  /** Whether confirming is needed to post publicly, message people who aren't friends and go live. */
  required: boolean;
}

export interface RiskSignal {
  id: string;
  kind: string;
  weight: number;
  detail: Record<string, unknown>;
  status: 'open' | 'cleared' | 'confirmed';
  createdAt: string;
  targetType: 'post' | 'message' | null;
  targetId: string | null;
  excerpt: string | null;
}

export interface RiskAccount {
  user: {
    id: string;
    username: string;
    displayName: string;
    email: string;
    status: string;
    createdAt: string;
    emailVerified: boolean;
    phoneVerified: boolean;
  };
  /** Set while the account is limited. */
  restrictedAt: string | null;
  /** Sum of the weights of its open signals. */
  score: number;
  signals: RiskSignal[];
}

export interface PaymentsConfig {
  provider: string;
  publishableKey?: string;
  providers?: { provider: string; publishableKey?: string; currencies: string[] }[];
}

/** What checkout needs for an order the API just created. With Paystack, clientSecret is Paystack's hosted checkout URL. */
export interface CreatorTopPost {
  id: string;
  excerpt: string;
  kind: string;
  format: 'post' | 'reel';
  like_count: number;
  comment_count: number;
  view_count: number;
  created_at: string;
}

export interface CreatorAnalytics {
  period: 'last_28_days';
  totals: { posts: number; likes: number; comments: number; saves: number; followers: number; views: number; reach: number };
  topPosts: CreatorTopPost[];
  topReels: CreatorTopPost[];
  followerGrowth: { day: string; new_followers: number }[];
}

export interface PostInsights {
  postId: string;
  format: 'post' | 'reel';
  createdAt: string;
  views: number;
  likes: number;
  comments: number;
  saves: number;
  reposts: number;
  viewsByDay: { day: string; views: number }[];
}

export interface Payout {
  id: string;
  amountCents: number;
  currency: string;
  status: 'pending' | 'verified' | 'paid' | 'failed';
  createdAt: string;
}

export interface TipRecord {
  id: string;
  amountCents: number;
  currency: string;
  message: string;
  postId: string | null;
  /** Sent during a live, where it showed in the chat. */
  gift: boolean;
  createdAt: string;
  /** Who sent it (tips you got) or who got it (tips you sent). */
  person: PublicUser;
}

export interface CheckoutPayment {
  provider: string;
  clientSecret: string;
  orderId: string;
}

export interface ShopItem {
  id: string;
  kind: 'product' | 'digital' | 'service' | 'booking';
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  inventory: number | null;
  /** Digital products: the file buyers get (never its location). */
  file: { name: string; mime: string; sizeBytes: number } | null;
  /** You bought this download. */
  owned: boolean;
}

export interface ServiceBooking {
  id: string;
  status: 'requested' | 'confirmed' | 'declined' | 'cancelled';
  startsAt: string;
  note: string;
  product: { id: string; title: string };
  amountCents: number;
  currency: string | null;
  customer: PublicUser;
}

export interface SalesReport {
  days: number;
  totals: { currency: string; orders: number; grossCents: number; feeCents: number; netCents: number }[];
  items: {
    orderId: string;
    status: 'paid' | 'refunded';
    createdAt: string;
    product: { id: string; title: string; kind: string };
    quantity: number;
    amountCents: number;
    currency: string;
    buyer: PublicUser;
  }[];
}

export interface Boost {
  campaignId: string;
  status: 'draft' | 'pending_review' | 'active' | 'paused' | 'ended' | 'rejected';
  audience: { type: 'country'; countries: string[] } | { type: 'interests'; topics: string[] };
  days: number | null;
  currency: string;
  budgetCents: number;
  spentCents: number;
  refundedCents: number;
  impressions: number;
  clicks: number;
  ctr: number;
  reviewNote: string | null;
  approvedAt: string | null;
  endsAt: string | null;
  createdAt: string;
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
  /** Only shown in these countries (empty: everywhere). */
  countries: string[];
  /** Set for boosts: how many days it runs once approved. */
  boostDays: number | null;
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

/** GET /v1/media/:id */
export interface MediaItemStatus {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  url: string;
  mime: string | null;
  altText: string | null;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  variants: Record<string, string>;
  /** Bytes of the original and of each processed size. */
  sizes?: Record<string, number>;
  posterUrl: string | null;
  hlsUrl: string | null;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** The upload this one was edited from, for editor results. */
  editOf: string | null;
  error: string | null;
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
  /** Detected language of the text, for "See translation". */
  lang?: string | null;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | 'audio' | null;
  posterUrl: string | null;
  hlsUrl: string | null;
  /** Processed sizes (thumb/medium for photos; thumb, mp4_360 and hls_360 for videos), for Data saver. */
  variants?: Record<string, string>;
  /** Bytes of the original and of each processed size. */
  sizes?: Record<string, number>;
  durationMs: number | null;
  locationText: string | null;
  /** Shared with the author's close friends only. */
  closeFriends: boolean;
  expiresAt: string | null;
  createdAt: string;
  seen: boolean;
  liked: boolean;
  /** Only on your own stories. */
  views?: number;
  /** Its photo or video is marked sensitive: show it blurred until the viewer chooses to see it. */
  sensitive?: boolean;
  /** Shared with everyone (can be reshared, and shows on tag pages). */
  public: boolean;
  /** Hashtags from the text and hashtag stickers. */
  tags: string[];
  stickers: StorySticker[];
  /** A reshare: the original story, which opens only if you can see it. */
  reshareOf: StoryCard | null;
  /** The story mentions you. */
  mentionsYou: boolean;
  /** You can add it to your own story. */
  canReshare: boolean;
  /** Your own stories: whether others may reshare it. */
  allowReshare?: boolean;
  /** Music playing with the story (null when there is none, or you can't see its sound). */
  music: StoryMusic | null;
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
  /** Comments using the tag, on posts you can see. */
  comments: number;
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

export interface OnboardingStep {
  step: 'interests' | 'follow' | 'friends';
  skipped: boolean;
  count: number;
}

export interface SharingSettings {
  /** "Let people who have my email or phone number find me". */
  findableByContacts: boolean;
  /** Others can save your reels as a video to share elsewhere. */
  allowDownload: boolean;
  /** Both stay off for people under 18. */
  locked: boolean;
}

export interface ContactHashing {
  salt: string;
  /** Identifier kinds the server matches today (email; phone later). */
  kinds: ('email' | 'phone')[];
  maxHashes: number;
  format: string;
}

export interface ContactMatch {
  user: PublicUser;
  following: boolean;
  followsYou: boolean;
  /** Which of the hashes you sent belong to this person. */
  hashes: string[];
}

export interface ShareVideoState {
  status: 'none' | 'queued' | 'processing' | 'ready' | 'failed';
  /** Set once ready. */
  url: string | null;
  /** A suggested name for the downloaded file. */
  fileName: string;
}

/** One of your stories after it expired, in your private archive. */
export interface ArchivedStory {
  id: string;
  body: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | 'audio' | null;
  posterUrl: string | null;
  hlsUrl: string | null;
  /** Processed sizes (thumb/medium for photos; thumb, mp4_360 and hls_360 for videos), for Data saver. */
  variants?: Record<string, string>;
  /** Bytes of the original and of each processed size. */
  sizes?: Record<string, number>;
  durationMs: number | null;
  locationText: string | null;
  sensitive?: boolean;
  /** Its photo or video failed a check: it stays here but can't go in a chapter. */
  blocked?: boolean;
  closeFriends: boolean;
  createdAt: string;
  expiresAt: string;
  chapters: { id: string; title: string }[];
}

export interface ChapterInput {
  title: string;
  description: string;
  audience: ChapterAudience;
  coverGradient: ChapterGradient;
  coverSymbol: ChapterSymbol;
  /** A time capsule's opening date (ISO). Null makes it an ordinary chapter again, until it's sealed. */
  opensAt: string | null;
}

export interface Chapter {
  id: string;
  title: string;
  description: string;
  audience: ChapterAudience;
  owner: PublicUser;
  /** One of its stories, or the chosen gradient and symbol. Always the gradient while a capsule is sealed. */
  cover:
    | { kind: 'story'; mediaUrl: string | null; mediaKind: 'image' | 'video' | 'audio' | null; posterUrl: string | null; text: string | null }
    | { kind: 'gradient'; gradient: ChapterGradient; symbol: ChapterSymbol };
  coverGradient: ChapterGradient;
  coverSymbol: ChapterSymbol;
  /** Only for the owner. */
  coverStoryId?: string | null;
  /** A time capsule. `sealed`: nothing more can be added. `open`: its date has come. */
  capsule: { opensAt: string; sealed: boolean; open: boolean } | null;
  storyCount: number;
  /** Has contributors. */
  shared: boolean;
  role: 'owner' | 'contributor' | 'invited' | null;
  /** You can add one of your stories now. */
  canAdd: boolean;
  /** For contributors: also shown on your profile. */
  showOnProfile?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterStory {
  id: string;
  body: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | 'audio' | null;
  posterUrl: string | null;
  hlsUrl: string | null;
  durationMs: number | null;
  sensitive?: boolean;
  locationText: string | null;
  createdAt: string;
  /** Who shared it: the credit on each story. */
  author: PublicUser;
  mine: boolean;
}

export interface ChapterDetail {
  chapter: Chapter;
  /** In playing order. Empty before a time capsule opens, except your own stories for you. */
  stories: ChapterStory[];
  /** Accepted contributors; the owner also sees people still invited. */
  contributors: { user: PublicUser; status: 'invited' | 'accepted' }[];
}

export interface GuestbookEntry {
  id: string;
  body: string;
  author: PublicUser;
  mine: boolean;
  /** Hidden by the owner (only the owner sees these). */
  hidden: boolean;
  /** Waiting for a check: only you see it for now. */
  pending: boolean;
  createdAt: string;
}
