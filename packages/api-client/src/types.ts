/** Response and request shapes of the YAPILAPI HTTP API (hand-maintained against docs/api/openapi.json and the modules). */

export type Uuid = string;
export type IsoDate = string;

export type Visibility =
  'public' | 'followers' | 'friends' | 'circle' | 'selected' | 'private' | 'community';
export const VISIBILITIES: readonly Visibility[] = [
  'public',
  'followers',
  'friends',
  'circle',
  'selected',
  'private',
  'community',
];
export type ReactionKind = 'like' | 'love' | 'laugh' | 'wow' | 'sad' | 'insightful';
export const REACTION_KINDS: readonly ReactionKind[] = [
  'like',
  'love',
  'laugh',
  'wow',
  'sad',
  'insightful',
];
export type AgeBand = 'teen' | 'adult';
export type ProfileMode = 'personal' | 'creator' | 'professional' | 'business';
export type CircleKind = 'family' | 'close_friends' | 'work' | 'business' | 'travel' | 'custom';
export type FeedMode = 'for_you' | 'following' | 'friends' | 'communities' | 'local' | 'custom';
export type FeedSignal = 'more_like_this' | 'less_like_this' | 'not_interested' | 'hide_creator';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ------------------------------------------------------------------ auth
export interface SelfUser {
  id: Uuid;
  email: string;
  emailVerified: boolean;
  status: string;
  platformRole: string;
  ageBand: AgeBand;
  locale: string;
  timezone: string;
  mfaEnabled: boolean;
  deletionScheduledFor: IsoDate | null;
  profile: {
    username: string;
    displayName: string;
    avatarUrl: string | null;
    mode: ProfileMode;
    onboardingCompleted: boolean;
  };
}
export interface MeResponse {
  user: SelfUser;
  /** Feature flags evaluated for this user, e.g. `{ COMMERCE: false }`. */
  flags: Record<string, boolean>;
}
export interface SessionGrant {
  /** Only present when the client asked for `deliver: 'token'` (bearer mode). Store it in secure storage, never localStorage. */
  token?: string;
  expiresAt: IsoDate;
}
export interface RegisterInput {
  email: string;
  password: string;
  username: string;
  displayName: string;
  /** YYYY-MM-DD */
  birthDate: string;
  locale?: string;
  timezone?: string;
  acceptTerms: true;
}
export type RegisterResult = { user: SelfUser } & SessionGrant;
export interface LoginInput {
  email: string;
  password: string;
  deviceLabel?: string;
}
export type LoginResult =
  | ({ mfaRequired: false; user: SelfUser } & SessionGrant)
  | { mfaRequired: true; challengeToken: string };
export type MfaVerifyInput = { challengeToken: string } & (
  { code: string; recoveryCode?: undefined } | { recoveryCode: string; code?: undefined }
);
export type MfaVerifyResult = { user: SelfUser } & SessionGrant;
export interface SessionInfo {
  id: Uuid;
  current: boolean;
  createdAt: IsoDate;
  lastSeenAt: IsoDate;
  userAgent: string | null;
  deviceLabel: string | null;
  ipHint: string | null;
}
export interface MfaSetup {
  secret: string;
  /** otpauth:// URI to render as a QR code on the client. */
  otpauthUri: string;
}

// ------------------------------------------------------------------ profiles / graph
export interface UserCard {
  id: Uuid;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  mode: ProfileMode;
  isPrivate: boolean;
}
export type FollowState = 'none' | 'pending' | 'active';
export type FriendshipState = 'none' | 'friends' | 'pending_out' | 'pending_in';
export interface ProfileLink {
  label: string;
  url: string;
}
export interface Profile {
  id: Uuid;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  mode: ProfileMode;
  links: ProfileLink[];
  locationText: string | null;
  isPrivate: boolean;
  counts: { followers: number; following: number; friends: number };
  joinedAt: IsoDate;
  /** True when the viewer may not see this profile's content (private account, not approved). */
  contentHidden: boolean;
  viewer: {
    isSelf: boolean;
    following: FollowState;
    followedBy: boolean;
    friendship: FriendshipState;
    muted: boolean;
    restricted: boolean;
  };
}
export interface UpdateProfileInput {
  displayName?: string;
  bio?: string;
  links?: ProfileLink[];
  locationText?: string | null;
  mode?: ProfileMode;
  isPrivate?: boolean;
  avatarUrl?: string | null;
  coverUrl?: string | null;
}
export interface Topic {
  slug: string;
  name: string;
}
export interface UsernameAvailability {
  available: boolean;
  reason?: 'invalid' | 'reserved' | 'taken';
}
export interface Circle {
  id: Uuid;
  kind: CircleKind;
  name: string;
  memberCount: number;
}
export type UserCardWithRequest = UserCard & { requestedAt: IsoDate };

// ------------------------------------------------------------------ settings
export type ThemePreference = 'system' | 'light' | 'dark';
export type SensitiveContent = 'hide' | 'limit' | 'allow';
export interface Preferences {
  locale: string;
  timezone: string;
  currency: string;
  theme: ThemePreference;
  reducedMotion: boolean;
  lowBandwidth: boolean;
  dailyLimitMinutes: number | null;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  focusMode: boolean;
  sensitiveContent: SensitiveContent;
  defaultPostVisibility: 'public' | 'followers' | 'friends' | 'private';
  whoCanMessage: 'everyone' | 'followers' | 'friends' | 'nobody';
  discoverable: boolean;
  personalization: boolean;
}
export type PreferencesUpdate = Partial<Preferences>;

// ------------------------------------------------------------------ content
export interface PostAuthor {
  id: Uuid;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  mode: ProfileMode;
}
export interface PostMedia {
  id: Uuid;
  kind: string;
  url: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  altText: string | null;
  blurhash: string | null;
  status: string;
}
export interface PollOption {
  id: Uuid;
  label: string;
  votes: number;
}
export interface Poll {
  question: string;
  multiple: boolean;
  closesAt: IsoDate | null;
  options: PollOption[];
  myVotes: Uuid[];
  totalVotes: number;
}
export interface Post {
  id: Uuid;
  author: PostAuthor;
  kind: string;
  body: string;
  language: string | null;
  visibility: Visibility;
  communityId: Uuid | null;
  eventId: Uuid | null;
  productId: Uuid | null;
  placeId: Uuid | null;
  circleId: Uuid | null;
  link: { url: string; preview: unknown } | null;
  location: { latitude: number; longitude: number } | null;
  media: PostMedia[];
  /** Topic display names (not slugs). */
  topics: string[];
  poll: Poll | null;
  counts: { likes: number; comments: number; shares: number; saves: number; views: number };
  viewer: { reaction: ReactionKind | null; saved: boolean; isAuthor: boolean };
  aiProvenance: unknown;
  rights: unknown;
  moderationStatus: string;
  editedAt: IsoDate | null;
  createdAt: IsoDate;
  /** Only on For You feed items. */
  reasons?: string[];
}
export interface CreatePostInput {
  body?: string;
  visibility?: Visibility;
  circleId?: Uuid;
  audience?: Uuid[];
  communityId?: Uuid;
  /** Topic slugs. */
  topics?: string[];
  mediaIds?: Uuid[];
  poll?: { question: string; options: string[]; multiple?: boolean; closesInHours?: number };
  linkUrl?: string;
  latitude?: number;
  longitude?: number;
  placeId?: Uuid;
  language?: string;
  license?: 'all_rights_reserved' | 'cc_by' | 'cc_by_nc' | 'cc0';
  aiAssistance?: { tools: string[] };
}
export interface Comment {
  id: Uuid;
  postId: Uuid;
  parentId: Uuid | null;
  body: string;
  author: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  counts: { likes: number; replies: number };
  viewer: { reaction: ReactionKind | null; isAuthor: boolean };
  pendingApproval: boolean;
  moderationStatus: string;
  editedAt: IsoDate | null;
  createdAt: IsoDate;
}

// ------------------------------------------------------------------ feed
export interface FeedParams {
  mode?: FeedMode;
  cursor?: string;
  limit?: number;
  /** local mode */
  lat?: number;
  lng?: number;
  radiusKm?: number;
  /** custom mode */
  circleId?: Uuid;
  topics?: string[];
}
export interface FeedPage extends Page<Post> {
  mode: FeedMode;
}
export interface FeedExplanation {
  reasons: string[];
  /** Feedback controls the server offers for this post, e.g. `more_like_this`, `mute_topic`. */
  controls: string[];
}

export interface Meta {
  app: string;
  tagline: string;
  flags: Record<string, boolean>;
}

// ------------------------------------------------------------------ messaging
export type ConversationKind = 'direct' | 'group' | 'community_channel';
export interface Person {
  id: Uuid;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}
export interface ConversationBase {
  id: Uuid;
  kind: ConversationKind;
  title: string | null;
  communityId: Uuid | null;
  channelName: string | null;
  channelKind: string | null;
  createdBy: Uuid | null;
  createdAt: IsoDate;
  lastMessageAt: IsoDate | null;
}
export interface InboxItem extends ConversationBase {
  /** The other person, for direct conversations. */
  peer: Person | null;
  /** Capped at 100 by the API. */
  unreadCount: number;
  pinned: boolean;
  mutedUntil: IsoDate | null;
  muted: boolean;
  lastReadAt: IsoDate | null;
  lastMessage: {
    id: Uuid;
    senderId: Uuid | null;
    kind: string;
    preview: string;
    createdAt: IsoDate;
  } | null;
}
export interface ConversationMember {
  userId: Uuid;
  role: 'owner' | 'admin' | 'member' | string;
  joinedAt: IsoDate;
  lastReadAt: IsoDate | null;
  profile: Person | null;
}
export interface Conversation extends ConversationBase {
  role: string | null;
  canSend: boolean;
  canManage: boolean;
  me: { lastReadAt: IsoDate | null; mutedUntil: IsoDate | null; muted: boolean; pinned: boolean };
  unreadCount: number;
  /** Absent for community channels. */
  members?: ConversationMember[];
  memberCount?: number;
  peer?: Person | null;
}
export interface MessageReplyPreview {
  id: Uuid;
  senderId: Uuid | null;
  kind: string;
  body: string;
  deleted: boolean;
}
export interface MessageAttachment {
  id: Uuid;
  kind: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  altText: string | null;
}
export interface Message {
  id: Uuid;
  conversationId: Uuid;
  senderId: Uuid | null;
  sender: Person | null;
  kind: string;
  body: string;
  /** True once deleted by the sender (or removed by moderation): the content is gone for everyone. */
  deleted: boolean;
  replyTo: MessageReplyPreview | null;
  attachments: MessageAttachment[];
  metadata: Record<string, unknown>;
  reactions: { counts: Partial<Record<ReactionKind, number>>; mine: ReactionKind | null };
  poll: {
    question: string;
    multiple: boolean;
    options: Array<{ id: string; label: string; votes: number }>;
    myVotes: string[];
    totalVotes: number;
  } | null;
  plan: { id: Uuid; title: string; status: string } | null;
  moderationStatus?: string;
  clientMessageId?: string | null;
  createdAt: IsoDate;
  editedAt: IsoDate | null;
}
export interface SendMessageInput {
  body?: string;
  replyToId?: Uuid;
  /** Makes retries idempotent: the same id never creates two messages. */
  clientMessageId?: string;
}
export interface WsTicket {
  ticket: string;
  expiresInSec: number;
  /** Path (with the ticket) of the WebSocket endpoint, relative to the API origin. */
  url: string;
}
/** Frames the server pushes over the realtime socket. Message payloads are viewer-neutral (no `mine` fields). */
export type RealtimeEvent =
  | { type: 'ready'; userId: Uuid; subscriptions: number; heartbeatMs: number }
  | { type: 'pong' }
  | { type: 'subscribed' | 'unsubscribed'; conversationId: Uuid; reason?: string }
  | { type: 'error'; code: string; conversationId?: Uuid }
  | { type: 'message.new' | 'message.updated'; conversationId: Uuid; message: Message }
  | { type: 'message.deleted'; conversationId: Uuid; messageId: Uuid }
  | { type: 'conversation.read'; conversationId: Uuid; userId: Uuid; lastReadAt: IsoDate }
  | { type: 'conversation.updated'; conversationId: Uuid; title: string }
  | {
      type: 'conversation.member.added' | 'conversation.member.removed';
      conversationId: Uuid;
      userId: Uuid;
    }
  | { type: 'conversation.member.updated'; conversationId: Uuid; userId: Uuid; role: string }
  | { type: 'conversation.added' | 'conversation.removed'; conversationId: Uuid }
  | { type: 'typing'; conversationId: Uuid; userId: Uuid; state: 'start' | 'stop' }
  | { type: string; [k: string]: unknown };

// ------------------------------------------------------------------ communities
export type CommunityVisibility = 'public' | 'private' | 'secret';
export type CommunityJoinPolicy = 'open' | 'request' | 'invite';
export type CommunityMemberStatus = 'active' | 'pending' | 'invited' | 'banned' | 'left';
export interface Community {
  id: Uuid;
  slug: string;
  name: string;
  description: string;
  visibility: CommunityVisibility;
  joinPolicy: CommunityJoinPolicy;
  memberCount: number;
  language: string | null;
  topics: string[];
  isPaid: boolean;
  priceCents: number | null;
  currency: string | null;
  createdAt: IsoDate;
  /** `summary` when the viewer may not see the community's content (private, not a member). */
  access: 'full' | 'summary';
  rules?: Array<{ title: string; body: string }>;
  viewer: {
    status: CommunityMemberStatus;
    roleKey?: string | null;
    rank?: number | null;
    permissions?: string[];
  } | null;
}
export interface CommunityInvitation extends Community {
  invitedAt: IsoDate;
}
export interface CreateCommunityInput {
  name: string;
  slug?: string;
  description?: string;
  visibility?: CommunityVisibility;
  joinPolicy?: CommunityJoinPolicy;
  /** Topic slugs. */
  topics?: string[];
  rules?: Array<{ title: string; body?: string }>;
  language?: string;
}
export interface CommunityMember {
  user: Person;
  status: CommunityMemberStatus;
  roleKey: string;
  roleName: string;
  rank: number;
  joinedAt: IsoDate | null;
}
export interface CommunityChannel {
  id: Uuid;
  name: string | null;
  kind: 'text' | 'voice' | string;
  archived: boolean;
  createdAt: IsoDate;
}

// ------------------------------------------------------------------ search & discover
export const SEARCH_TYPES = [
  'people',
  'creators',
  'posts',
  'videos',
  'communities',
  'events',
  'places',
  'businesses',
  'products',
  'topics',
] as const;
export type SearchResultType = (typeof SEARCH_TYPES)[number];
export interface SearchTimeWindow {
  label: string;
  from: IsoDate;
  to: IsoDate;
}
export interface SearchInterpretation {
  mode: 'natural_language' | 'keywords';
  explanation: string;
  entityTypes: SearchResultType[];
  keywords: string[];
  topics: string[];
  timeWindow: SearchTimeWindow | null;
  partySize: number | null;
  nearMe: boolean;
  priceHint: 'cheap' | 'moderate' | 'expensive' | null;
  placeKinds: string[];
  typesOverridden: boolean;
  needsLocation?: boolean;
  fellBack?: boolean;
}
/** A result item's shape depends on `type`; callers narrow on it. Always has `id`. */
export type SearchResultItem = Record<string, unknown> & { id: Uuid; type?: SearchResultType };
export interface SearchGroup {
  items: SearchResultItem[];
  nextCursor: string | null;
}
export interface SearchParams {
  q: string;
  types?: SearchResultType[];
  limit?: number;
  cursor?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  tz?: string;
  interpret?: 'auto' | 'off';
}
export interface SearchResponse {
  query: string;
  interpretedAs: SearchInterpretation;
  types: SearchResultType[];
  total: number;
  results: Partial<Record<SearchResultType, SearchGroup>>;
}
export interface SearchSuggestItem {
  type: SearchResultType;
  id: Uuid;
  label: string;
  sublabel: string | null;
  ref: Record<string, unknown>;
  score: number;
}
export interface SearchSuggestResponse {
  query: string;
  items: SearchSuggestItem[];
  recent: string[];
}
export interface SearchHistoryItem {
  query: string;
  searchCount: number;
  lastSearchedAt: IsoDate;
}
export interface SearchHistoryResponse {
  recording: boolean;
  items: SearchHistoryItem[];
}

export interface TrendingTopic {
  slug: string;
  name: string;
  postCount: number;
  authorCount: number;
  score: number;
}
export interface TrendingResponse extends Page<
  Post & { trendingScore: number; engagedBy: number; reasons: string[] }
> {
  window: '1h' | '6h' | '24h' | '7d';
  topics: TrendingTopic[];
}
export interface SuggestedPerson {
  user: UserCard & {
    bio: string;
    followerCount: number;
    viewer: { following: FollowState; friend: boolean };
  };
  reasons: string[];
  explanation: string;
  score: number;
}
export interface DiscoverPeoplePage extends Page<SuggestedPerson> {
  source: 'graph' | 'interests' | 'popular';
}
export interface DiscoverCommunityItem {
  id: Uuid;
  slug: string;
  name: string;
  description: string;
  memberCount: number;
  language: string | null;
  joinPolicy: CommunityJoinPolicy;
  isPaid: boolean;
  priceCents: number | null;
  currency: string | null;
  topics: string[];
  reasons: string[];
  explanation: string;
  score: number;
}
export interface DiscoverTopicItem {
  slug: string;
  name: string;
  postsThisWeek: number;
  communities: number;
  interested: boolean;
  reason: string;
}
export interface NowResponse {
  generatedAt: IsoDate;
  privacy: {
    minGroupSize: number;
    approximateCounts: true;
    locationStored: false;
    individualsShown: false;
  };
  live: { enabled: boolean; items: unknown[] };
  events: EventSummary[];
  trendingTopics: TrendingTopic[];
  activeCommunities: Array<{
    id: Uuid;
    slug: string;
    name: string;
    memberCount: number;
    activePeople: number;
    approximate: true;
  }>;
  nearby: null | {
    people: { count: number; approximate: true } | null;
    places: Array<{
      id: Uuid;
      name: string;
      kind: string;
      distanceKm: number | undefined;
      activePeople: number;
      approximate: true;
    }>;
  };
  needsLocation: boolean;
}

// ------------------------------------------------------------------ notifications
export type NotificationCategory =
  | 'messages'
  | 'friends'
  | 'creators'
  | 'communities'
  | 'events'
  | 'commerce'
  | 'security'
  | 'moderation'
  | 'system';
export type NotificationChannel = 'in_app' | 'push' | 'email';
export interface NotificationItem {
  id: Uuid;
  kind: string;
  category: NotificationCategory;
  actor: { id: Uuid; username: string; displayName: string; avatarUrl: string | null } | null;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: IsoDate;
}
export interface NotificationPreferenceCategory {
  category: NotificationCategory;
  label: string;
  inAppLocked: boolean;
  channels: Record<NotificationChannel, { enabled: boolean; default: boolean; custom: boolean }>;
}
export interface NotificationPreferenceOverride {
  kind: string;
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}
export interface NotificationSettings {
  timezone: string;
  quietHours: { start: number; end: number; isDefault: boolean } | null;
  focusMode: boolean;
  pausedUntil: IsoDate | null;
  urgentAlwaysDelivered: NotificationCategory[];
}
export interface NotificationPreferences {
  categories: NotificationPreferenceCategory[];
  overrides: NotificationPreferenceOverride[];
  settings: NotificationSettings;
}
export interface NotificationSettingsInput {
  quietHours?: { start: number; end: number } | null;
  focusMode?: boolean;
  pauseForMinutes?: number | null;
  timezone?: string;
}

// ------------------------------------------------------------------ media
export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export type MediaStatus = 'pending' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'blocked';
export interface MediaObject {
  id: Uuid;
  kind: MediaKind;
  status: MediaStatus;
  mimeType: string;
  url: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  altText: string | null;
  decorative: boolean;
  blurhash: string | null;
  needsAltText: boolean;
  variants?: Record<string, string>;
  createdAt: IsoDate;
}

// ------------------------------------------------------------------ moments
export type MomentKind = 'photo' | 'video' | 'text' | 'audio';
export type MomentVisibility = 'public' | 'followers' | 'friends' | 'circle' | 'selected';
export type MomentExpiry = '1h' | '24h' | 'custom' | 'permanent';
export interface MomentMusic {
  title: string;
  artist?: string;
  provider?: string;
  externalId?: string;
  startMs?: number;
  durationMs?: number;
}
export interface Moment {
  id: Uuid;
  author: PostAuthor;
  kind: MomentKind;
  body: string | null;
  media: PostMedia | null;
  music: MomentMusic | null;
  location: { latitude: number; longitude: number } | null;
  placeId: Uuid | null;
  visibility: MomentVisibility;
  expiresAt: IsoDate | null;
  viewer: { viewed: boolean; reaction: ReactionKind | null; isAuthor: boolean };
  viewCount: number;
  createdAt: IsoDate;
}
export interface MomentGroup {
  author: PostAuthor;
  hasUnseen: boolean;
  moments: Moment[];
}
export interface MomentTray {
  groups: MomentGroup[];
  hasMore: boolean;
}
export interface CreateMomentInput {
  kind: MomentKind;
  body?: string;
  mediaId?: Uuid;
  music?: MomentMusic;
  latitude?: number;
  longitude?: number;
  placeId?: Uuid;
  visibility?: MomentVisibility;
  circleId?: Uuid;
  audience?: Uuid[];
  expiry?: MomentExpiry;
  expiresAt?: IsoDate;
}

// ------------------------------------------------------------------ events
export type EventVisibility = 'public' | 'followers' | 'friends' | 'community' | 'private';
export type EventStatus = 'draft' | 'published' | 'cancelled' | 'completed';
export type RsvpStatus = 'going' | 'interested' | 'not_going';
export interface EventTicketType {
  id: Uuid;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  free: boolean;
  quantity: number;
  sold: number;
  remaining: number;
  maxPerUser: number;
  salesStart: IsoDate | null;
  salesEnd: IsoDate | null;
  onSale: boolean;
  archived: boolean;
}
export interface EventSummary {
  id: Uuid;
  title: string;
  description: string;
  startsAt: IsoDate;
  endsAt: IsoDate | null;
  timezone: string;
  locationText: string | null;
  location: { latitude: number; longitude: number } | null;
  placeId: Uuid | null;
  communityId: Uuid | null;
  visibility: EventVisibility;
  goingCount: number;
  interestedCount: number;
  coverUrl: string | null;
  host: { id: Uuid; username: string; displayName: string } | null;
  distanceKm?: number;
}
export interface EventDetail extends Omit<EventSummary, 'host'> {
  status: EventStatus;
  hasOnlineUrl: boolean;
  onlineUrl: string | null;
  place: { id: Uuid; name: string } | null;
  host: { id: Uuid; username: string; displayName: string; avatarUrl: string | null } | null;
  hostBusiness: { id: Uuid; slug: string; name: string; verified: boolean } | null;
  community: { id: Uuid; slug: string; name: string } | null;
  coHosts?: Array<{ id: Uuid; username: string; displayName: string; avatarUrl: string | null }>;
  capacity: number | null;
  counts: { going: number; interested: number; waitlist: number; spotsLeft: number | null };
  waitlistEnabled: boolean;
  rules: string;
  topics: string[];
  ticketTypes?: EventTicketType[];
  publishedAt: IsoDate | null;
  cancelledAt: IsoDate | null;
  cancelReason: string | null;
  completedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  viewer: {
    rsvp: RsvpStatus | 'waitlist' | 'attended' | null;
    saved: boolean;
    invited: boolean;
    isOrganiser: boolean;
    isManager: boolean;
  };
}
export interface CreateEventInput {
  title: string;
  description?: string;
  startsAt: IsoDate;
  endsAt?: IsoDate;
  timezone?: string;
  locationText?: string;
  latitude?: number;
  longitude?: number;
  placeId?: Uuid;
  onlineUrl?: string;
  capacity?: number;
  visibility?: EventVisibility;
  rules?: string;
  coverMediaId?: Uuid;
  topics?: string[];
  waitlistEnabled?: boolean;
  communityId?: Uuid;
  businessId?: Uuid;
  publish?: boolean;
}
export type UpdateEventInput = Partial<Omit<CreateEventInput, 'publish'>>;
export interface EventAttendee {
  user: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  status: 'going' | 'interested' | 'waitlist' | 'attended' | 'cancelled';
}
export interface MyTicket {
  status: RsvpStatus | 'waitlist' | 'attended' | 'not_going';
  checkinCode: string | null;
  ticketTypeId: Uuid | null;
}

// ------------------------------------------------------------------ places
export type PlaceKind = 'restaurant' | 'store' | 'venue' | 'attraction' | 'service';
export interface OpeningHours {
  mon?: Array<[string, string]>;
  tue?: Array<[string, string]>;
  wed?: Array<[string, string]>;
  thu?: Array<[string, string]>;
  fri?: Array<[string, string]>;
  sat?: Array<[string, string]>;
  sun?: Array<[string, string]>;
}
export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}
export interface Place {
  id: Uuid;
  name: string;
  kind: PlaceKind;
  description: string;
  latitude: number;
  longitude: number;
  address: Address | null;
  hours: OpeningHours | null;
  timezone: string;
  isOpenNow: boolean | null;
  phone: string | null;
  website: string | null;
  capacity: number | null;
  bookingEnabled: boolean;
  claimed: boolean;
  business: { id: Uuid; slug: string; name: string; verified: boolean } | null;
  rating: { average: number; count: number; breakdown?: Record<string, number> };
  coverUrl: string | null;
  photos?: Array<{ mediaId: Uuid; url: string; caption: string | null }>;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  distanceKm?: number;
  viewer: { saved: boolean; canEdit?: boolean; editRole?: string | null; myReviewId?: Uuid | null };
}
export interface CreatePlaceInput {
  name: string;
  kind: PlaceKind;
  description?: string;
  latitude: number;
  longitude: number;
  address?: Address;
  hours?: OpeningHours;
  timezone?: string;
  phone?: string;
  website?: string;
  capacity?: number;
}
export interface PlaceReview {
  id: Uuid;
  placeId: Uuid;
  author: { id: Uuid; username: string; displayName: string; avatarUrl: string | null } | null;
  rating: number;
  body: string;
  verifiedPurchase: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  ownerReply: { body: string; at: IsoDate | null } | null;
  viewer: { isAuthor: boolean };
  moderationStatus?: string;
}
export interface PlaceClaim {
  id: Uuid;
  placeId: Uuid;
  businessId: Uuid;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  evidence: string;
  createdAt: IsoDate;
}

// ------------------------------------------------------------------ business
export interface BusinessBookingSettings {
  slotMinutes: number;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  maxDurationMinutes: number;
  maxPartySize: number;
  autoConfirm: boolean;
}
export interface Business {
  id: Uuid;
  slug: string;
  name: string;
  category: string;
  description: string;
  contact: { email?: string; phone?: string; website?: string } | null;
  links: ProfileLink[];
  hours: OpeningHours | null;
  timezone: string;
  address: Address | null;
  verified: boolean;
  verifiedAt: IsoDate | null;
  followerCount: number;
  bookingSettings: BusinessBookingSettings;
  createdAt: IsoDate;
  logoUrl: string | null;
  coverUrl: string | null;
  legalName?: string;
  status?: string;
  aiAssistantEnabled?: boolean;
  ownerId?: Uuid;
  viewer: { role: string | null; permissions: string[]; following: boolean };
}
export interface CreateBusinessInput {
  name: string;
  slug?: string;
  category?: string;
  description?: string;
  legalName?: string;
  contact?: { email?: string; phone?: string; website?: string };
  links?: ProfileLink[];
  hours?: OpeningHours;
  timezone?: string;
  address?: Address;
  logoMediaId?: Uuid;
  coverMediaId?: Uuid;
}
export interface BusinessOffer {
  id: Uuid;
  title: string;
  description: string;
  code: string | null;
  discountBps: number | null;
  startsAt: IsoDate;
  endsAt: IsoDate | null;
  status: 'active' | 'expired' | 'archived';
  createdAt: IsoDate;
}
export interface BusinessService {
  id: Uuid;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  status: 'draft' | 'active';
  createdAt: IsoDate;
}
export interface BookableInfo {
  settings: BusinessBookingSettings;
  places: Array<{
    id: Uuid;
    name: string;
    kind: string;
    capacity: number | null;
    timezone: string;
    hasHours: boolean;
  }>;
  services: Array<{
    id: Uuid;
    title: string;
    description: string;
    priceCents: number;
    currency: string;
    timezone: string;
  }>;
}
export type BookingStatus =
  'requested' | 'confirmed' | 'declined' | 'cancelled' | 'completed' | 'no_show';
export interface Booking {
  id: Uuid;
  businessId: Uuid;
  placeId: Uuid | null;
  productId: Uuid | null;
  status: BookingStatus;
  customerId: Uuid;
  startsAt: IsoDate;
  endsAt: IsoDate;
  partySize: number;
  notes: string;
  reason: string | null;
  cancelledBy: string | null;
  orderId: Uuid | null;
  decidedAt: IsoDate | null;
  createdAt: IsoDate;
  business?: { id: Uuid; name: string; slug: string };
  customer?: { id: Uuid; username: string; displayName: string };
  targetName?: string;
}
export interface CreateBookingInput {
  placeId?: Uuid;
  productId?: Uuid;
  startsAt: IsoDate;
  durationMinutes?: number;
  partySize?: number;
  notes?: string;
}

// ------------------------------------------------------------------ commerce (products, orders)
export type ProductKind = 'physical' | 'service' | 'digital' | 'booking';
export type ProductStatus = 'draft' | 'active' | 'sold_out' | 'archived';
export interface ProductDelivery {
  methods: string[];
  estimateDays: number | null;
  shippingCents: number;
}
export interface ProductSeller {
  type: 'business' | 'user';
  id: Uuid | null;
  name?: string | null;
  slug?: string;
  username?: string | null;
}
export interface Product {
  id: Uuid;
  kind: ProductKind;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  taxBps: number;
  inStock: boolean;
  /** Only present to the seller. */
  stock?: number | null;
  delivery: ProductDelivery;
  returnsPolicy: string;
  status: ProductStatus;
  rating: { average: number; count: number };
  seller: ProductSeller;
  media: Array<{ id: Uuid; url: string; alt: string | null }>;
  /** Only present for digital products the viewer may see the file count of. */
  fileCount?: number;
  createdAt: IsoDate;
  viewer: { isSeller: boolean; hasPurchased: boolean };
}
export interface CreateProductInput {
  kind: ProductKind;
  title: string;
  description?: string;
  priceCents: number;
  currency: string;
  stock?: number | null;
  delivery?: { methods?: string[]; estimateDays?: number; shippingCents?: number };
  returnsPolicy?: string;
  taxBps?: number;
  businessId?: Uuid;
  status?: 'draft' | 'active';
}
export type UpdateProductInput = Partial<
  Pick<
    CreateProductInput,
    'title' | 'description' | 'priceCents' | 'stock' | 'delivery' | 'returnsPolicy' | 'taxBps'
  > & { status: ProductStatus }
>;
export interface ProductReview {
  id: Uuid;
  rating: number;
  body: string;
  verifiedPurchase: boolean;
  author: { id: Uuid; username: string; displayName: string };
  createdAt: IsoDate;
  mine: boolean;
}

export type OrderItemInput =
  | { productId: Uuid; quantity?: number; bookingId?: Uuid }
  | { ticketTypeId: Uuid; quantity?: number };
export interface ShippingAddressInput {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}
export interface CreateOrderInput {
  items: OrderItemInput[];
  shippingAddress?: ShippingAddressInput;
}
export type OrderStatus =
  | 'pending_review'
  | 'pending_payment'
  | 'paid'
  | 'fulfilled'
  | 'completed'
  | 'cancelled'
  | 'disputed'
  | 'partially_refunded'
  | 'refunded';
export interface OrderItem {
  id: Uuid;
  type: 'product' | 'ticket' | 'booking';
  kind: string;
  productId: Uuid | null;
  ticketTypeId: Uuid | null;
  eventId: Uuid | null;
  bookingId: Uuid | null;
  title: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  taxCents: number;
  refundedCents: number;
  entitlement: { kind: string; status: string } | null;
}
export interface Order {
  id: Uuid;
  status: OrderStatus;
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  refundedCents: number;
  /** Seller/staff view only. */
  platformFeeCents?: number;
  items: OrderItem[];
  shippingAddress?: ShippingAddressInput | null;
  tracking: {
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    note: string | null;
  } | null;
  seller: { type: 'business' | 'user'; id: Uuid | null };
  buyer?: { id: Uuid; username?: string; displayName?: string };
  payment: { id: Uuid; status: string; failureCode: string | null; provider: string } | null;
  reservedUntil: IsoDate | null;
  heldForReview: boolean;
  cancelReason: string | null;
  createdAt: IsoDate;
  paidAt: IsoDate | null;
  fulfilledAt: IsoDate | null;
  completedAt: IsoDate | null;
  cancelledAt: IsoDate | null;
}

// ------------------------------------------------------------------ payments
/** An opaque provider payment-method reference (e.g. `tok_success`, `pm_card_visa`) — never a raw card number. */
export type PaymentMethodToken = string;
export type PaymentStatus =
  | 'requires_payment_method'
  | 'processing'
  | 'requires_action'
  | 'captured'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed';
export interface PaymentNextAction {
  type: string;
  url: string | null;
}
export interface Payment {
  id: Uuid;
  orderId: Uuid | null;
  purpose: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  provider: string;
  failureCode: string | null;
  refundedCents: number;
  clientSecret: string | null;
  createdAt: IsoDate;
}
export type RefundStatus =
  'requested' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'rejected';
export interface Refund {
  id: Uuid;
  orderId: Uuid;
  itemId: Uuid | null;
  amountCents: number;
  currency: string;
  status: RefundStatus;
  reason: string;
  requestedBy: 'buyer' | 'seller' | 'staff' | 'system';
  failureCode: string | null;
  createdAt: IsoDate;
  decidedAt: IsoDate | null;
}
export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export interface PayoutAccount {
  id: Uuid;
  provider: string;
  kycStatus: KycStatus;
  status: string;
  onboardingUrl?: string | null;
}
export interface PayoutBalanceEntry {
  currency: string;
  totalCents: number;
  availableCents: number;
  pendingCents: number;
}
export interface PayoutBalance {
  holdDays: number;
  balances: PayoutBalanceEntry[];
  payoutAccount: { id: Uuid; kycStatus: KycStatus; payoutsEnabled: boolean } | null;
}
export type PayoutStatus = 'pending' | 'verifying' | 'approved' | 'paid' | 'failed' | 'held';
export interface Payout {
  id: Uuid;
  currency: string;
  amountCents: number;
  status: PayoutStatus;
  createdAt: IsoDate;
}

// ------------------------------------------------------------------ AI platform
export type AiAgentId =
  'social' | 'creator' | 'community' | 'event' | 'shopping' | 'business' | 'travel';
export interface AiStatus {
  enabled: boolean;
  defaultProvider: string | null;
  notice: string | null;
  providers: Array<{ name: string; model: string | null; isDev: boolean; circuit: string }>;
  routes: Record<string, string[]>;
  features: { translation: boolean; memory: boolean; speech: boolean };
  consents: { aiProcessing: boolean; aiMemory: boolean };
  usage: AiUsageSummary;
}
export interface AiAgent {
  id: AiAgentId;
  name: string;
  description: string;
  scope: string;
  requiresScopeId: boolean;
  groundedOnly: boolean;
  availableToYou: boolean;
  tools: Array<{
    name: string;
    effect: string;
    description: string;
    needsConsent: boolean;
    readsPrivateMessages: boolean;
    availableToYou: boolean;
  }>;
}
export interface AiSourceRef {
  type: string;
  id: string;
  [key: string]: unknown;
}
export interface AiToolOutcomeSummary {
  tool: string;
  outcome: 'allowed' | 'denied' | 'error';
  [key: string]: unknown;
}
export interface AiChatInput {
  message: string;
  conversationId?: Uuid;
  agent?: AiAgentId;
  scopeId?: Uuid;
  attachConversationIds?: Uuid[];
  focus?: { type: 'post' | 'comment' | 'event' | 'conversation'; id: Uuid };
  stream?: boolean;
}
export interface AiSafety {
  refused: boolean;
  category: string | null;
  output: 'ok' | 'redacted' | 'blocked';
  reasons: string[];
  injectionDetected: boolean;
  injectionSentencesRemoved: number;
  notes: string[];
}
export interface AiChatResult {
  conversationId: Uuid;
  agent: string;
  message: { id: Uuid; role: 'assistant'; content: string; createdAt: IsoDate };
  provider: string;
  model: string | null;
  notice: string | null;
  sources: AiSourceRef[];
  toolCalls: AiToolOutcomeSummary[];
  artifacts: Array<{ id: Uuid; kind: string; status: string }>;
  memorySuggestions: string[];
  documented: boolean | null;
  safety: AiSafety;
  support: unknown;
  usage: { inputTokens: number; outputTokens: number };
}
export interface AiConversationSummary {
  id: Uuid;
  agent: string;
  scope: string;
  scopeId: Uuid | null;
  title: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}
export interface AiToolCallSummary {
  tool: string;
  outcome: 'allowed' | 'denied' | 'error';
  reason?: string;
  artifactId?: string;
}
export interface AiMessage {
  id: Uuid;
  role: 'user' | 'assistant';
  content: string;
  provider: string | null;
  model: string | null;
  notice: string | null;
  sources: unknown;
  toolCalls: AiToolCallSummary[];
  safety: {
    refused: boolean;
    category: string | null;
    output: 'ok' | 'redacted' | 'blocked';
    injectionDetected: boolean;
  };
  memorySuggestions: string[];
  createdAt: IsoDate;
}
/**
 * A draft the AI proposed. Nothing happens to it until the person confirms or discards it.
 * `kind` names the shape of `payload`; `suggest_titles` / `draft_description` / `thumbnail_concepts` all use the
 * generic `other` kind and are told apart by `payload.type`.
 */
export interface AiArtifact {
  id: Uuid;
  kind: 'post_draft' | 'reply_draft' | 'caption' | 'plan' | 'event_draft' | 'translation' | 'other';
  status: 'draft' | 'confirmed' | 'discarded';
  tool: string | null;
  provider: string | null;
  payload: Record<string, unknown>;
  sources: unknown;
  edited: boolean;
  conversationId: Uuid | null;
  result: unknown;
  createdAt: IsoDate;
  confirmedAt: IsoDate | null;
}
/** Result of a direct (non-chat) creator drafting endpoint: titles, descriptions, captions, thumbnail concepts, translate. */
export interface AiDirectResult {
  display: string;
  artifact: AiArtifact | null;
  result: Record<string, unknown>;
}
export interface AiConfirmInput {
  visibility?: Visibility;
  communityId?: Uuid;
  circleId?: Uuid;
  audience?: Uuid[];
  topics?: string[];
  conversationId?: Uuid;
  selected?: number;
}
export interface AiConfirmResult {
  artifact: AiArtifact;
  action:
    | 'post_created'
    | 'comment_created'
    | 'message_sent'
    | 'plan_created'
    | 'event_draft_created'
    | 'accepted';
  created: { type: string; id: Uuid } | null;
  text?: string;
}
export interface AiMemory {
  id: Uuid;
  content: string;
  source: 'user_stated' | 'user_approved_suggestion';
  sourceRef: string | null;
  useCount: number;
  lastUsedAt: IsoDate | null;
  createdAt: IsoDate;
}
export interface AiUsageSummary {
  day: string;
  user: {
    tokensUsed: number;
    tokenLimit: number;
    tokensRemaining: number;
    requests: number;
    costMicros: number;
  };
  translations: { used: number; limit: number };
  resetsAt: IsoDate;
}
export interface AiToolCallRecord {
  id: Uuid;
  conversationId: Uuid | null;
  tool: string;
  agent: string | null;
  input: unknown;
  outcome: 'allowed' | 'denied' | 'error';
  denialReason: string | null;
  durationMs: number | null;
  sources: unknown;
  at: IsoDate;
}
export interface AiTranslateResult {
  translation: {
    text: string;
    language: string;
    provider: string;
    cached: boolean;
    unchanged: boolean;
  };
  original: { text: string; language: string | null };
  notice: string | null;
}
export interface AiLanguageDetection {
  language: string;
  confidence: number;
  languageName: string | null;
}

// ------------------------------------------------------------------ privacy center
export interface PrivacyOverviewCategory {
  key: string;
  label: string;
  items: number | undefined;
  detail?: Record<string, number | null | undefined>;
  purpose: string;
  retention: string;
}
export interface PrivacyOverview {
  categories: PrivacyOverviewCategory[];
  connectedApps: number;
  consents: Array<{ purpose: ConsentPurpose; granted: boolean }>;
  exportSections: Array<{ key: string; description: string }>;
  retainedAfterDeletion: string[];
  rights: { export: string; delete: string; consents: string };
}
export type ConsentPurpose =
  'personalization' | 'ai_processing' | 'ai_memory' | 'advertising' | 'analytics';
export interface ConsentStatus {
  purpose: ConsentPurpose;
  label: string;
  description: string;
  granted: boolean;
  decidedAt: IsoDate | null;
  isDefault: boolean;
  /** False when a teen account cannot grant this purpose (the toggle should be disabled). */
  canGrant: boolean;
}
export interface ConsentHistoryEntry {
  id: number | string;
  purpose: string;
  granted: boolean;
  source: string;
  at: IsoDate;
}
export interface AdvertisingPrefs {
  personalizedAds: boolean;
  hiddenTopics: string[];
  limitSensitive: boolean;
  availableToYou?: boolean;
}
export interface VisibilityOverview {
  profile: { private: boolean; discoverable: boolean; whoCanMessage: string };
  defaults: { postVisibility: string; sensitiveContent: string; personalization: boolean };
  postsByVisibility: Record<string, number>;
  momentsByVisibility: Record<string, number>;
  controls: {
    blocked: number;
    muted: number;
    restricted: number;
    circles: number;
    connected_apps: number;
    guardians: number;
  };
}
export interface PrivacyRequest {
  id: Uuid;
  kind: 'export' | 'deletion' | string;
  status: string;
  createdAt: IsoDate;
  completedAt: IsoDate | null;
  export?: { downloadable: boolean; expiresAt: IsoDate | null; sizeBytes: number | null };
}
export interface ConnectedApp {
  id: Uuid;
  app: {
    id: Uuid;
    name: string;
    description: string | null;
    homepageUrl: string | null;
    privacyUrl: string | null;
    developer: string | null;
  };
  scopes: Array<{ scope: string; description: string }>;
  authorizedAt: IsoDate;
  lastUsedAt: IsoDate | null;
}

// ------------------------------------------------------------------ creator economy
export type CreatorStatus = 'active' | 'suspended' | 'closed';
export type CreatorKycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export interface CreatorProfile {
  userId: Uuid;
  status: CreatorStatus;
  kycStatus: CreatorKycStatus;
  category: string | null;
  termsVersion: string | null;
  currentTermsVersion: string;
  termsAccepted: boolean;
  kycSubmittedAt: IsoDate | null;
  kycDecidedAt: IsoDate | null;
  kycNote: string | null;
  mode: string | null;
  createdAt: IsoDate;
}
export interface CreatorKycEvent {
  from: string;
  to: string;
  by: string;
  note: string | null;
  at: IsoDate;
}
export interface CreatorPayoutAccountSummary {
  id: Uuid;
  kycStatus: CreatorKycStatus;
  payoutsEnabled: boolean;
}
export interface CreatorMe {
  creator: CreatorProfile | null;
  currentTermsVersion: string;
  verification: CreatorKycEvent[];
  payoutAccount: CreatorPayoutAccountSummary | null;
}

export type SubscriptionInterval = 'month' | 'year';
export interface CreatorPlan {
  id: Uuid;
  creatorId: Uuid;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: SubscriptionInterval;
  tier: number;
  benefits: string[];
  active: boolean;
}
export type CreatorSubscriptionStatus =
  'incomplete' | 'active' | 'past_due' | 'cancelled' | 'expired';
export interface CreatorSubscription {
  id: Uuid;
  creatorId: Uuid;
  planId: Uuid;
  planName: string;
  tier: number;
  priceCents: number;
  currency: string;
  interval: SubscriptionInterval;
  status: CreatorSubscriptionStatus;
  currentPeriodEnd: IsoDate;
  cancelAtPeriodEnd: boolean;
  renewalAttempts: number;
  nextRetryAt: IsoDate | null;
  lastFailureCode: string | null;
  startedAt: IsoDate | null;
  endedAt: IsoDate | null;
  endReason: string | null;
}
export interface CreatorSubscriber {
  id: Uuid;
  subscriberId: Uuid;
  username: string;
  tier: number;
  plan: string;
  status: string;
  currentPeriodEnd: IsoDate;
  cancelAtPeriodEnd: boolean;
  startedAt: IsoDate | null;
}

export interface CreatorDashboard {
  window: { days: number; since: IsoDate };
  followers: { total: number; gained: number; daily: Array<{ day: string; gained: number }> };
  content: {
    posts: number;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    engagementRate: number | null;
    topPosts: Array<{
      id: Uuid;
      kind: string;
      visibility: string;
      createdAt: IsoDate;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      views: number;
    }>;
  };
  subscribers: {
    active: number;
    pastDue: number;
    byTier: Array<{ tier: number; plan: string; active: number }>;
  };
  audience: {
    countries: Array<{ country: string; followers: number }>;
    other: number;
    minGroupSize: number;
  };
}
export interface CreatorRevenue {
  window: { days: number; since: IsoDate };
  earnings: Array<{
    source: string;
    currency: string;
    payments: number;
    grossCents: number;
    platformFeeCents: number;
    netCents: number;
  }>;
  affiliate: Array<{ currency: string; conversions: number; netCents: number }>;
  deductions: Array<{ kind: string; currency: string; amountCents: number }>;
  thisMonth: Array<{ currency: string; netCents: number }>;
  note: string;
}

export interface CreatorPayoutBalance {
  holdDays: number;
  balances: Array<{
    currency: string;
    totalCents: number;
    availableCents: number;
    pendingCents: number;
  }>;
  payoutAccount: CreatorPayoutAccountSummary | null;
}
export type CreatorPayoutStatus = 'pending' | 'verifying' | 'approved' | 'paid' | 'failed' | 'held';
export interface CreatorPayout {
  id: Uuid;
  payee: { type: 'user' | 'business'; id: Uuid | null };
  amountCents: number;
  currency: string;
  status: CreatorPayoutStatus;
  failureCode: string | null;
  verification: Record<string, unknown>;
  createdAt: IsoDate;
}

export interface CreatorSupporterTip {
  id: Uuid;
  from: { userId: Uuid; username: string };
  amountCents: number;
  currency: string;
  message: string;
  createdAt: IsoDate;
}
export interface CreatorSupporterGift {
  id: Uuid;
  from: { userId: Uuid; username: string };
  code: string;
  name: string;
  amountCents: number;
  currency: string;
  message: string;
  liveSessionId: Uuid | null;
  createdAt: IsoDate;
}
export interface GiftCatalogItem {
  id: Uuid;
  code: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  active: boolean;
  sortOrder: number;
}

export interface AffiliateLink {
  id: Uuid;
  productId: Uuid;
  code: string;
  commissionBps: number;
  active: boolean;
  createdAt: IsoDate;
}
export interface AffiliateLinkStats extends AffiliateLink {
  clicks: { counted: number; rawHits: number; rejected: number };
  conversions: number;
  commissionCents: { pending: number; settled: number };
}
export interface AffiliateConversion {
  id: Uuid;
  linkId: Uuid;
  lineCents: number;
  commissionBps: number;
  commissionCents: number;
  currency: string;
  status: string;
  createdAt: IsoDate;
  settledAt: IsoDate | null;
}

export type PartnershipStatus =
  | 'proposed'
  | 'negotiating'
  | 'accepted'
  | 'in_progress'
  | 'delivered'
  | 'paid'
  | 'declined'
  | 'cancelled';
export interface PartnershipDeliverable {
  id: Uuid;
  title: string;
  kind: string;
  dueAt: IsoDate | null;
  status: string;
  postId: Uuid | null;
  reviewNote: string | null;
  submittedAt: IsoDate | null;
}
export interface PartnershipEvent {
  side: string;
  event: string;
  from: string | null;
  to: string | null;
  at: IsoDate;
}
export interface Partnership {
  id: Uuid;
  creatorId: Uuid;
  businessId: Uuid;
  yourSide: 'creator' | 'business';
  status: PartnershipStatus;
  title: string;
  brief: string;
  amountCents: number | null;
  currency: string | null;
  termsVersion: number;
  termsBy: 'creator' | 'business';
  acceptedBy: { creator: boolean; business: boolean };
  disclosureRequired: boolean;
  disclosureLabel: string;
  paymentStatus: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  deliverables: PartnershipDeliverable[];
  events: PartnershipEvent[];
}

// ------------------------------------------------------------------ creator studio
export interface StudioCapabilities {
  render: { available: boolean; burnInCaptions: boolean };
  analysis: { available: boolean };
  speech: { available: boolean };
  aiSuggestions: { available: boolean };
}

export type StudioAspect = '1:1' | '4:5' | '9:16' | '16:9';
export interface StudioSegment {
  startMs: number;
  endMs: number;
}
export interface StudioEdl {
  version: 1;
  segments: StudioSegment[];
  aspect: StudioAspect | null;
  cropX?: number;
  thumbnail: { atMs: number } | null;
  captions: { lang: string; burnIn: boolean } | null;
}
export interface StudioEdlIssue {
  path: string;
  message: string;
}

export interface StudioCue {
  startMs: number;
  endMs: number;
  text: string;
}
export interface StudioCaptionTrack {
  lang: string;
  label: string | null;
  kind: 'captions' | 'subtitles';
  source: 'manual' | 'imported' | 'machine';
  cues: number;
  updatedAt: IsoDate;
}
export interface StudioCaptionTrackDetail extends StudioCaptionTrack {
  cuesList: StudioCue[];
}

export type StudioProjectStatus = 'draft' | 'published' | string;
export interface StudioProject {
  id: Uuid;
  title: string;
  description: string;
  mediaId: Uuid;
  status: StudioProjectStatus;
  edl: StudioEdl;
  edlVersion: number;
  edlHash: string;
  outputMediaId: Uuid | null;
  rendered: boolean;
  renderError: string | null;
  aiAssisted: string[];
  publishedPostId: Uuid | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  captionTracks?: StudioCaptionTrack[];
  suggestions?: StudioSuggestion[];
  publication?: StudioPublication | null;
}

export type StudioRenderStatus = 'queued' | 'running' | 'done' | 'failed' | string;
export interface StudioRenderJob {
  id: Uuid;
  status: StudioRenderStatus;
  edlHash: string;
  errorCode: string | null;
  outputMediaId: Uuid | null;
  startedAt: IsoDate;
  finishedAt: IsoDate | null;
}

export type StudioSuggestionKind =
  'title' | 'description' | 'thumbnail' | 'silence_cuts' | 'highlights' | 'captions_review';
export interface StudioSuggestion {
  id: Uuid;
  kind: StudioSuggestionKind;
  source: 'heuristic' | 'ffmpeg' | 'ai_module';
  provider: string | null;
  status: 'suggested' | 'accepted' | 'dismissed';
  payload: Record<string, unknown>;
  createdAt: IsoDate;
  decidedAt: IsoDate | null;
  appliedAutomatically: false;
}

export type StudioPublicationStatus =
  'confirmed' | 'published' | 'cancelled' | 'stale' | 'failed' | string;
export interface StudioPublication {
  id: Uuid;
  mode: 'now' | 'scheduled';
  publishAt: IsoDate | null;
  status: StudioPublicationStatus;
  postId: Uuid | null;
  error: string | null;
  confirmedAt: IsoDate;
  publishedAt: IsoDate | null;
  mediaId: Uuid;
  contentHash: string;
}

// ------------------------------------------------------------------ live
export type LiveStatus = 'live' | 'scheduled' | 'ended' | 'cancelled';
export type LiveVisibility = 'public' | 'followers' | 'subscribers' | 'private';
export type LiveMediaMode = 'video' | 'interactive';
export type LiveRole = 'host' | 'cohost' | 'moderator' | 'audience';
export const LIVE_REACTIONS = ['like', 'love', 'laugh', 'wow', 'clap', 'fire'] as const;
export type LiveReactionKind = (typeof LIVE_REACTIONS)[number];

export interface LiveSession {
  id: Uuid;
  hostId: Uuid;
  host?: { id: Uuid; username: string; displayName: string } | undefined;
  title: string;
  description: string;
  status: LiveStatus;
  visibility: LiveVisibility;
  mediaMode: LiveMediaMode;
  scheduledFor: IsoDate | null;
  startedAt: IsoDate | null;
  endedAt: IsoDate | null;
  language: string | null;
  viewerCount: number;
  peakViewers: number;
  chatEnabled: boolean;
  slowModeSec: number;
  ticket:
    { required: false } | { required: true; ticketTypeId: Uuid; eventId: Uuid; held: boolean };
  video: { ingestState: string } | null;
  hasRecording: boolean;
  viewerRole?: LiveRole;
  blockedTerms?: string[];
  endReason?: string | null;
  createdAt: IsoDate;
}

export interface LiveTeamMember {
  userId: Uuid;
  role: string;
  username: string;
  displayName: string;
}

export interface LiveMessage {
  id: Uuid;
  userId: Uuid | null;
  author: { username: string; displayName: string } | null;
  kind: string;
  body: string | null;
  hidden?: boolean;
  createdAt: IsoDate;
}

export interface LivePollOption {
  id: Uuid;
  label: string;
  votes: number;
}
export interface LivePoll {
  id: Uuid;
  question: string;
  multiple: boolean;
  status: 'open' | 'closed';
  options: LivePollOption[];
  voters: number;
  myVotes: Uuid[];
  createdAt: IsoDate;
  closedAt: IsoDate | null;
}

export interface LiveQuestion {
  id: Uuid;
  body: string;
  status: 'open' | 'answered';
  upvotes: number;
  answer: string | null;
  answeredAt: IsoDate | null;
  viewerUpvoted: boolean;
  asker: { id: Uuid; username?: string; displayName?: string };
  createdAt: IsoDate;
}

export interface LiveModeratedEntry {
  userId: Uuid;
  username: string;
  mutedUntil: IsoDate | null;
  banned: boolean;
  banReason: string | null;
}

export interface LiveProduct {
  productId: Uuid;
  title: string;
  priceCents: number;
  currency: string;
  kind: string;
  pinned: boolean;
  available: boolean;
  buyUrl: string;
}

export interface LiveJoinResult {
  session: LiveSession;
  messages: LiveMessage[];
  openPolls: LivePoll[];
  pinnedProduct: LiveProduct | null;
  realtime: { ticketEndpoint: string; url: string; ticketTtlSec: number };
}

// ------------------------------------------------------------------ memory
export type MemoryKind = 'highlight' | 'recap' | 'timeline' | 'collection' | 'trip' | 'on_this_day';
export type MemoryPrivacy = 'private' | 'friends' | 'public';
export type MemoryItemType =
  'post' | 'moment' | 'media' | 'event' | 'real_capture' | 'experience' | 'message';
export const MEMORY_ITEM_TYPES: MemoryItemType[] = [
  'post',
  'moment',
  'media',
  'event',
  'real_capture',
  'experience',
  'message',
];
export type MemoryLinkType = 'person' | 'place' | 'event' | 'trip' | 'community' | 'experience';
export const MEMORY_LINK_TYPES: MemoryLinkType[] = [
  'person',
  'place',
  'event',
  'trip',
  'community',
  'experience',
];
export type MemoryAiDraftKind = 'title' | 'summary' | 'highlights';

export interface MemoryItemRef {
  type: MemoryItemType;
  id: Uuid;
}
export interface MemoryLinkRef {
  type: MemoryLinkType;
  id: Uuid;
}
export interface MemoryItemPreview {
  type: MemoryItemType;
  id: Uuid;
  position: number;
  at: IsoDate | null;
  text: string;
  kind: string | null;
  placeId: Uuid | null;
  mediaUrl: string | null;
}
export interface MemoryLink {
  type: MemoryLinkType;
  id: Uuid;
  label: string;
}
export interface MemoryHead {
  id: Uuid;
  owner: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  kind: MemoryKind;
  title: string;
  summary: string;
  dateStart: string | null;
  dateEnd: string | null;
  privacy: MemoryPrivacy;
  aiGenerated: boolean;
  aiProvenance: Record<string, unknown> | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  viewer: { isOwner: boolean };
  source?: string | null;
  sharedAt?: IsoDate | null;
}
export interface MemorySummary extends MemoryHead {
  itemCount: number;
}
export interface MemoryView extends MemoryHead {
  items: MemoryItemPreview[];
  itemCount: number;
  links: MemoryLink[];
  unavailableItemCount?: number;
}
export interface MemoryRecap {
  total: number;
  counts: Record<string, number>;
  dateStart: string | null;
  dateEnd: string | null;
  spanDays: number;
  places: number;
  people: number;
}
export type MemoryTimelineEntry = MemoryItemPreview;
export interface OnThisDaySuggestion {
  key: string;
  year: number;
  date: string;
  itemCount: number;
  items: MemoryItemPreview[];
}
export interface MemoryTripSuggestion {
  key: string;
  startAt: IsoDate;
  endAt: IsoDate;
  itemCount: number;
  distinctDays: number;
  centroid: { latitude: number; longitude: number };
  maxDistanceFromHomeKm: number;
}
export interface MemoryAiDraft {
  id: Uuid;
  memoryId: Uuid;
  kind: MemoryAiDraftKind;
  payload: Record<string, unknown>;
  provider: string;
  model: string;
  status: 'pending' | 'confirmed' | 'discarded';
  createdAt: IsoDate;
}
export interface MemorySlideshowExport {
  exportId: Uuid;
  kind: 'slideshow';
  images: number;
  media: MediaObject;
}

// ------------------------------------------------------------------ real
export type RealVisibility = 'public' | 'followers' | 'friends' | 'circle' | 'selected' | 'private';
export type RealReactionKind = 'like' | 'love' | 'laugh' | 'wow' | 'sad' | 'insightful';
export interface RealMediaLite {
  id: Uuid;
  kind: string;
  url: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  altText: string | null;
  blurhash: string | null;
  status: string;
}
export interface RealIndicator {
  key: string;
  ok: boolean;
  label: string;
}
export interface RealCaptureSession {
  token: string;
  expiresAt: IsoDate;
  ttlSec: number;
  method: 'in_app_token';
  attestation: { available: boolean; provider: string };
  clockSkewMs: number | null;
}
export interface RealCapture {
  id: Uuid;
  author: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  front: RealMediaLite | null;
  rear: RealMediaLite | null;
  caption: string;
  location: { latitude: number; longitude: number } | null;
  capturedAt: IsoDate;
  receivedAt: IsoDate;
  authenticity: Record<string, unknown>;
  indicators: RealIndicator[];
  visibility: RealVisibility;
  reactionCount: number;
  viewer: { reaction: RealReactionKind | null; isAuthor: boolean };
  createdAt: IsoDate;
  circleId?: Uuid | null;
  sharedPostId?: Uuid | null;
  moderationStatus?: string;
}
export interface RealTrayGroup {
  author: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  latestAt: IsoDate;
  count: number;
  items: RealCapture[];
}
export interface RealReminderSettings {
  enabled: boolean;
  days: number[];
  localMinute: number;
  timezone: string;
}
export interface RealPostReceipt {
  postId: Uuid;
  real: {
    captureId: Uuid;
    capturedAt: IsoDate;
    authenticity: Record<string, unknown>;
    indicators: RealIndicator[];
  } | null;
}

// ------------------------------------------------------------------ together (shared experiences)
export type ExperienceVisibility = 'private' | 'friends' | 'public';
export type ExperienceStatus = 'open' | 'closed' | 'archived';
export type ExperienceMemberRole = 'owner' | 'contributor' | 'viewer';
export type ExperienceMemberStatus = 'invited' | 'joined' | 'declined';

export interface TogetherExperience {
  id: Uuid;
  title: string;
  description: string;
  owner: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  eventId: Uuid | null;
  placeId: Uuid | null;
  startsAt: IsoDate | null;
  endsAt: IsoDate | null;
  status: ExperienceStatus;
  visibility: ExperienceVisibility;
  counts: { members: number; contributions: number };
  viewer: {
    membership: ExperienceMemberStatus | null;
    role: ExperienceMemberRole | null;
    isOwner: boolean;
    canContribute: boolean;
    showOnProfile: boolean;
  };
  createdAt: IsoDate;
  updatedAt: IsoDate;
}
export interface TogetherCover {
  contributionId: Uuid;
  media: RealMediaLite | null;
  contributor: { id: Uuid; username: string; displayName: string };
  pinned: boolean;
  votes: number;
}
export interface TogetherExperienceView extends TogetherExperience {
  cover: TogetherCover | null;
}
export interface TogetherMember {
  user: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  role: ExperienceMemberRole;
  status: ExperienceMemberStatus;
  joinedAt: IsoDate | null;
}
export interface TogetherContribution {
  id: Uuid;
  contributor: { id: Uuid; username: string; displayName: string; avatarUrl: string | null };
  text: string;
  media: RealMediaLite | null;
  real: {
    id: Uuid;
    front: RealMediaLite | null;
    rear: RealMediaLite | null;
    caption: string;
    capturedAt: IsoDate | null;
    authenticity: Record<string, unknown>;
    indicators: RealIndicator[];
  } | null;
  takenAt: IsoDate;
  addedAt: IsoDate;
  mine?: boolean;
  moderationStatus?: string;
}
export interface TogetherSuggestedInvite {
  userId: Uuid;
  username: string;
  displayName: string;
}

// ------------------------------------------------------------------ developer platform
export type ApiKeyScope = 'public:read';
export type DeveloperAppStatus = 'active' | 'suspended';
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

export interface DeveloperApp {
  id: Uuid;
  name: string;
  description: string | null;
  clientId: string;
  confidential: boolean;
  redirectUris: string[];
  homepageUrl: string | null;
  privacyUrl: string | null;
  status: DeveloperAppStatus;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}
export interface DeveloperAppCreated extends DeveloperApp {
  clientSecret: string | null;
  note?: string;
}
export interface DeveloperAppDetail extends DeveloperApp {
  stats: { authorizedUsers: number; activeKeys: number; webhooks: number };
}
export interface RotatedClientSecret {
  clientId: string;
  clientSecret: string;
  note: string;
}
export interface DeveloperApiKey {
  id: Uuid;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
  lastUsedAt: IsoDate | null;
  expiresAt: IsoDate | null;
  revokedAt: IsoDate | null;
  createdAt: IsoDate;
}
export interface DeveloperApiKeyCreated extends DeveloperApiKey {
  key: string;
  note: string;
}
export interface WebhookEventTypeInfo {
  type: string;
  description: string;
}
export interface DeveloperWebhook {
  id: Uuid;
  appId: Uuid;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  createdAt: IsoDate;
}
export interface DeveloperWebhookCreated extends DeveloperWebhook {
  secret: string;
  note: string;
}
export interface RotatedWebhookSecret {
  secret: string;
  note: string;
}
export interface WebhookTestQueued {
  deliveryId: Uuid;
  status: string;
}
export interface WebhookDelivery {
  id: Uuid;
  eventType: string;
  eventId: Uuid;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: IsoDate | null;
  deliveredAt: IsoDate | null;
  createdAt: IsoDate;
}
