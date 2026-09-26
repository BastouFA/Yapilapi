import type { CommunityRole, PostKind, ProfileMode, Visibility } from './constants.ts';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  mode: ProfileMode;
  /** A YAPILAPI Plus member right now. Present (true) only for members. */
  plus?: boolean;
}

export interface Me extends PublicUser {
  email: string;
  emailVerified: boolean;
  role: 'user' | 'moderator' | 'admin';
  onboarded: boolean;
  locale: string;
  /** ISO 3166-1 alpha-2, set by the person or from a trusted CDN header. */
  country: string | null;
  /** When YAPILAPI Plus ends (it never renews on its own), or null without Plus. */
  plusUntil: string | null;
}

export interface Profile extends PublicUser {
  bio: string;
  coverUrl: string | null;
  links: { label: string; url: string }[];
  isPrivate: boolean;
  interests: string[];
  counts: { followers: number; following: number; friends: number; posts: number };
  relationship: {
    isSelf: boolean;
    following: boolean;
    followedBy: boolean;
    friends: boolean;
    friendRequest: 'none' | 'sent' | 'received';
    blocked: boolean;
    muted: boolean;
  };
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  /** Processed sizes (thumb/medium/large webp for images; mp4 for video). Empty until processing finishes. */
  variants?: Record<string, string>;
  posterUrl?: string | null;
  /** Adaptive HLS stream for videos. */
  hlsUrl?: string | null;
  /** Tiny blurred preview (data URI) shown while loading. */
  placeholder?: string | null;
  /** WebVTT subtitle tracks for videos. */
  captions?: CaptionTrackRef[];
}

export interface CaptionTrackRef {
  /** BCP 47 language code, e.g. "en" or "pt-BR". */
  lang: string;
  label: string;
  url: string;
}

export interface Post {
  id: string;
  kind: PostKind;
  /** 'reel' posts are short vertical videos shown in the Reels feed. */
  format: 'post' | 'reel';
  body: string;
  visibility: Visibility;
  author: PublicUser;
  media: MediaItem[];
  linkUrl: string | null;
  poll: { options: { id: string; label: string; votes: number }[]; myVote: string | null } | null;
  topics: string[];
  community: { id: string; slug: string; name: string } | null;
  event: { id: string; title: string; startsAt: string } | null;
  product: { id: string; title: string; priceCents: number; currency: string } | null;
  /** Views count each person once and never the author; recorded for reels. Remixes counts duets and remixes of a reel. */
  counts: { likes: number; comments: number; reposts: number; views: number; remixes?: number };
  /** Reels: whether other people may duet or remix it. */
  allowRemix?: boolean;
  /** Reels posted as a duet or remix of another reel. */
  remixOf?: RemixRef | null;
  /** Reels: the sound it uses (its own, or one it borrowed). */
  sound?: SoundRef | null;
  /** Pinned to the top of its author's profile (only set in profile listings). */
  pinned?: boolean;
  viewer: { liked: boolean; saved: boolean; reposted: boolean };
  aiAssisted: boolean;
  /** Set on Real posts: captured in-app moments before posting, unedited. */
  real?: { capturedAt: string; dual: boolean; locationText: string | null } | null;
  createdAt: string;
  /** Why this post is in the viewer's feed (recommendation explanation). */
  reason?: string;
  /** Only on the author's own posts: countries where regional rules withhold it. */
  withheldIn?: string[];
  /** Reels only: whether the viewer can save it as a video to share (the creator allows downloads). */
  downloadable?: boolean;
}

export interface SoundRef {
  id: string;
  title: string;
  durationMs: number | null;
  /** Plays the sound: the source reel's video, whose audio track is the sound. */
  audioUrl: string | null;
  /** True when this reel is where the sound comes from (so its own audio plays). */
  original: boolean;
}

export interface RemixRef {
  mode: 'duet' | 'remix';
  /** The original reel, while the viewer can still see it. */
  post: { id: string; body: string; author: PublicUser; media: MediaItem | null } | null;
}

export interface Sound {
  id: string;
  title: string;
  owner: PublicUser;
  /** The reel the sound comes from, while the viewer can see it. */
  sourcePostId: string | null;
  durationMs: number | null;
  audioUrl: string | null;
  /** Posterframe of the source reel, for the sound's cover. */
  coverUrl: string | null;
  /** Reels you can see that use it. */
  reels: number;
  /** Whether you can make a reel with it (its source reel is public and allows remixes). */
  canUse: boolean;
  createdAt: string;
}

export interface Comment {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  author: PublicUser;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group' | 'community';
  title: string | null;
  members: PublicUser[];
  lastMessage: Message | null;
  unreadCount: number;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: PublicUser;
  body: string;
  replyToId: string | null;
  attachments: {
    url: string;
    kind: string;
    name?: string;
    mediaId?: string;
    /** Videos and voice messages. */
    durationMs?: number | null;
    posterUrl?: string | null;
  }[];
  createdAt: string;
  clientId?: string | null;
}

export interface Community {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  memberCount: number;
  topics: string[];
  rules: string[];
  myRole: CommunityRole | null;
  createdAt: string;
}

export interface EventItem {
  id: string;
  title: string;
  description: string;
  host: PublicUser;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  locationText: string | null;
  place: { id: string; name: string } | null;
  community: { id: string; slug: string; name: string } | null;
  capacity: number | null;
  visibility: string;
  online: boolean;
  counts: { going: number; interested: number };
  myRsvp: 'going' | 'interested' | 'not_going' | null;
}

export interface NotificationItem {
  id: string;
  category: string;
  type: string;
  actor: PublicUser | null;
  /** Whether you follow the actor (for "Follow back"). */
  followsActor?: boolean;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

// ─── Public previews ────────────────────────────────────────────────────
// What anyone can see without an account: link previews (Open Graph cards)
// and the signed-out view of a shared link. Only public content from active,
// public adult accounts; never anything that needs a relationship to see.

export interface PublicAuthor {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicPreviewImage {
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
}

export interface PublicPostPreview {
  id: string;
  format: 'post' | 'reel';
  kind: PostKind;
  /** The post text, trimmed to about 200 characters. */
  excerpt: string;
  author: PublicAuthor;
  /** The first image, or the poster frame of the first video. */
  image: PublicPreviewImage | null;
  /** A direct MP4 file for the first video, when one exists. */
  video: { url: string; width: number | null; height: number | null; durationMs: number | null } | null;
  counts: { likes: number; comments: number; reposts: number };
  community: { slug: string; name: string } | null;
  createdAt: string;
}

export interface PublicProfilePreview {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  mode: ProfileMode;
  /** The bio, trimmed to about 200 characters. */
  bio: string;
  counts: { followers: number; following: number; posts: number };
}

export interface PublicEventPreview {
  id: string;
  title: string;
  /** The description, trimmed to about 200 characters. */
  excerpt: string;
  host: PublicAuthor;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  online: boolean;
  locationText: string | null;
  place: { name: string } | null;
  community: { slug: string; name: string } | null;
  counts: { going: number; interested: number };
}

export interface PublicCommunityPreview {
  slug: string;
  name: string;
  /** The description, trimmed to about 200 characters. */
  excerpt: string;
  memberCount: number;
  topics: string[];
}
