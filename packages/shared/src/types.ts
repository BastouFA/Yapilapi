import type { StoryCard } from './stories.ts';
import type { BoardVisibility, CircleKind, CommunityRole, NowStatusAudience, NowStatusIcon, PostKind, ProfileMode, Visibility } from './constants.ts';

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
  /** E.164, once added in Settings. */
  phone: string | null;
  phoneVerified: boolean;
  /** Posting publicly, messaging people who aren't friends and going live need a confirmed email or phone first. */
  needsVerification: boolean;
  /** Set while the account is limited pending a moderator's review. */
  limited?: boolean;
  role: 'user' | 'moderator' | 'admin';
  onboarded: boolean;
  locale: string;
  /** ISO 3166-1 alpha-2, set by the person or from a trusted CDN header. */
  country: string | null;
  /** When YAPILAPI Plus ends (it never renews on its own), or null without Plus. */
  plusUntil: string | null;
}

/** A short "Now" line, for 24 hours. `audience` is only included for its owner. */
export interface NowStatus {
  text: string;
  icon: NowStatusIcon | null;
  expiresAt: string;
  audience?: NowStatusAudience;
}

/** One of your circles. Only you see your circles; people are never told which circles they're in. */
export interface Circle {
  id: string;
  name: string;
  kind: CircleKind;
  memberCount: number;
  createdAt: string;
}

export interface Profile extends PublicUser {
  bio: string;
  coverUrl: string | null;
  /** Describes the cover photo for screen readers. */
  coverAlt: string | null;
  /** Their current "Now" status, when there is one and you're in its audience. */
  nowStatus: NowStatus | null;
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
  /** Flagged by automated checks: show it blurred with a "View" button. Never sent to people under 18. */
  sensitive?: boolean;
  /** Photos in a post: people tagged in it. Absent when nobody is. */
  tags?: PhotoTag[];
}

/** A person tagged in a photo, at a spot given as fractions of the photo's width and height (0 to 1, from the top left). */
export interface PhotoTag {
  id: string;
  user: PublicUser;
  x: number;
  y: number;
}

/** Who may tag you in photos: anyone, only people you follow, or no one. */
export type TagPermission = 'everyone' | 'following' | 'nobody';

/** Your invite to co-author someone's post or reel. */
export type CollabStatus = 'pending' | 'accepted';

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
  viewer: {
    liked: boolean;
    saved: boolean;
    reposted: boolean;
    /** Set when the viewer was invited to co-author this post: waiting for their answer, or accepted. */
    collab?: CollabStatus;
    /** Only in your Saved list and boards: your private note on your save of this post. */
    note?: string;
  };
  /**
   * Co-authors who accepted, in the order they were invited. The post shows as by
   * "{author} and {collaborator}", sits on each of their profiles and reaches their
   * followers, but only the original author can change or delete it. Absent when there are none.
   */
  collaborators?: PublicUser[];
  /** Only on the original author's own posts: people invited to co-author who haven't answered yet. */
  pendingCollaborators?: PublicUser[];
  /** Only on the author's own posts shared with a circle: which one. Members of the circle never see its name. */
  circle?: { id: string; name: string } | null;
  aiAssisted: boolean;
  /** Set on Real posts: captured in-app moments before posting, unedited. */
  real?: { capturedAt: string; dual: boolean; locationText: string | null } | null;
  createdAt: string;
  /** Set once the text was changed after publishing: shown as "Edited", which opens the history (GET /v1/posts/:id/history). */
  editedAt?: string;
  /** Only on your own drafts and scheduled posts, which nobody else sees. Published posts leave it out. */
  status?: 'draft' | 'scheduled';
  /** Scheduled posts: when it will be published. */
  scheduledAt?: string | null;
  /** Why this post is in the viewer's feed (recommendation explanation). */
  reason?: string;
  /** Only on the author's own posts: countries where regional rules withhold it. */
  withheldIn?: string[];
  /** Reels only: whether the viewer can save it as a video to share (the creator allows downloads). */
  downloadable?: boolean;
  /**
   * Set when the post is for subscribers and the viewer isn't one. The text,
   * media, poll, link, topics and attachments are withheld (empty); only a
   * blurred preview and how many photos or videos it has are sent.
   */
  locked?: { placeholder: string | null; mediaCount: number };
  /** Only on the author's own posts: the latest boost and its results so far. */
  boost?: {
    campaignId: string;
    status: 'draft' | 'pending_review' | 'active' | 'paused' | 'ended' | 'rejected';
    impressions: number;
    clicks: number;
    spentCents: number;
    budgetCents: number;
    currency: string;
    endsAt: string | null;
  };
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

/** One version of a post's text, newest first in a history: `at` is when it was written (the post's time for the first one). */
export interface PostVersion {
  body: string;
  at: string;
  current: boolean;
}

/** A draft or scheduled post opened to continue: the post, plus who it's for when that's a circle or chosen people. */
export interface DraftDetail {
  post: Post;
  circleId: string | null;
  audience: string[];
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
  /** Yaps in this chat, for you. */
  yaps?: ConversationYaps;
  /** One-to-one chats: the other person's "Now" status, when you're in its audience. */
  nowStatus?: NowStatus | null;
  /** Disappearing messages: seconds until new messages are deleted (86400, 604800 or 7776000), or null when off. */
  disappearingSeconds?: number | null;
  /** Your role here. In groups, admins pin messages and change disappearing messages. */
  myRole?: 'admin' | 'member';
}

/** The message a reply quotes, or a pinned message, as a short preview. */
export interface MessagePreview {
  id: string;
  /** False when you can't see it (it was removed, disappeared, or you blocked the sender). */
  available: boolean;
  /** The sender unsent it. */
  unsent?: boolean;
  sender: PublicUser | null;
  /** Up to 200 characters. */
  body: string;
  /** The first attachment's kind ('image', 'video', 'audio'), for "Photo" or "Voice message". */
  attachmentKind: string | null;
  createdAt: string | null;
}

export interface PinnedMessage {
  message: MessagePreview;
  pinnedBy: PublicUser | null;
  pinnedAt: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  /** You reacted with this. */
  mine: boolean;
}

/** What a system line in a chat says. */
export interface MessageSystemInfo {
  type: 'disappearing';
  /** The new setting: seconds, or null when turned off. */
  seconds: number | null;
}

export interface ConversationYaps {
  /** Yaps work in one-to-one chats and groups of up to 12 people. */
  available: boolean;
  /** Your "Let Yaps play out loud" setting here: null is the default (on for yaps from friends). */
  playOutLoud: boolean | null;
  /** What the default means here: in a one-to-one chat, whether you are friends. In a group, true (yaps from friends play). */
  defaultOutLoud: boolean;
  /** Your "Pause Yaps" switch, for every chat. */
  paused: boolean;
}

/** A view-once photo or video, as the person reading it sees it. */
export interface ViewOnceInfo {
  /**
   * ready: can be opened (for the sender: waiting to be opened).
   * viewed: you opened it (for the sender: everyone has, and the file is deleted).
   * expired: 14 days passed; the file is deleted.
   */
  state: 'ready' | 'viewed' | 'expired';
  /** 'image' or 'video'. */
  kind: string;
  expiresAt: string;
  /** Only on your own messages: who opened it and when, and whether they took a screenshot we could detect. */
  openedBy?: { user: PublicUser; openedAt: string; viewedAt: string | null; screenshot: boolean }[];
}

/** The `yap` realtime event: autoplay is true only when this person allows it right now. */
export interface YapEvent {
  message: Message;
  conversationId: string;
  autoplay: boolean;
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
    /** Show blurred until the person chooses to view it. */
    sensitive?: boolean;
    /** Taken down by moderation: there is nothing to show (url is empty). */
    removed?: boolean;
  }[];
  /** Only on your own messages: 'review' while held for a quick check before delivery. */
  moderation?: 'review';
  /** A shared story. It opens only if you can see the story yourself. */
  story?: StoryCard | null;
  createdAt: string;
  clientId?: string | null;
  /** 'yap' for a hold-to-talk voice clip, 'system' for a line about a change in the chat (see `system`); absent for other messages. */
  kind?: 'yap' | 'system';
  /** Present on view-once messages. Their attachment has no url: open it with POST /v1/messages/:id/view-once/open. */
  viewOnce?: ViewOnceInfo;
  /** The message this one replies to. */
  replyTo?: MessagePreview | null;
  /** When the text was last edited. */
  editedAt?: string | null;
  /** The sender unsent it: body and attachments are empty, show "Message unsent". */
  unsent?: boolean;
  /** Disappearing messages: when it will be deleted. */
  expiresAt?: string | null;
  reactions?: MessageReaction[];
  /** Pinned in this conversation. */
  pinned?: boolean;
  /** On system lines: what changed (the sender is who changed it). */
  system?: MessageSystemInfo;
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
  /** For subscribers only: the preview has no text, image or video. */
  locked?: boolean;
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

/** A board: a named collection of saved posts. Counts and covers only include posts the viewer can see. */
export interface Board {
  id: string;
  name: string;
  description: string;
  visibility: BoardVisibility;
  owner: PublicUser;
  /** The viewer's part: owner, collaborator (accepted), invited (not answered yet), or null (someone else's public board). */
  role: 'owner' | 'collaborator' | 'invited' | null;
  itemCount: number;
  /** The chosen cover, or else the first item the viewer can see. Null for an empty board. */
  cover: { postId: string; imageUrl: string | null; placeholder: string | null; text: string | null } | null;
  /** Only for the owner: the cover they picked (null means the first item). */
  coverPostId?: string | null;
  collaboratorCount: number;
  /** The viewer may add posts: the owner, or a collaborator while the board is shared or public. */
  canAdd: boolean;
  /** Set when the list was asked about one post: whether that post is on this board. */
  contains?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardCollaborator {
  user: PublicUser;
  status: 'invited' | 'accepted';
}

export interface BoardDetail {
  board: Board;
  /** Accepted collaborators for everyone who can see the board; open invites too for the owner. */
  collaborators: BoardCollaborator[];
}

export type RecapStatus = 'queued' | 'rendering' | 'ready' | 'failed';

/** A photo or video that can go in a recap: one the maker can see in the source right now. */
export interface RecapCandidate {
  mediaId: string;
  kind: 'image' | 'video';
  /** A small image for the picker (the poster frame for videos). */
  thumbUrl: string | null;
  durationMs: number | null;
  /** Likes on the post it comes from (stories count 0). */
  likes: number;
  /** When it was shared (ISO). */
  takenAt: string;
  from: 'post' | 'story';
  fromId: string;
  /** Yours, rather than someone else's. */
  mine: boolean;
}

export interface RecapCandidates {
  /** A suggested title: the memory's or chapter's, or "On this day". */
  title: string;
  items: RecapCandidate[];
  /** The suggested pick, in playing order: the best-liked and most varied, up to 30. */
  preselected: string[];
  /** Recaps you can still start today. */
  remainingToday: number;
}

export interface Recap {
  id: string;
  title: string;
  source: 'memory' | 'on_this_day' | 'chapter';
  sourceId: string | null;
  style: 'calm' | 'quick' | 'film';
  aspect: '9:16' | '1:1';
  sound: { id: string; title: string } | null;
  lengthSeconds: number | null;
  status: RecapStatus;
  /** Why it failed, in plain words. */
  error: string | null;
  /** Photos and videos chosen. */
  itemCount: number;
  /** How many made it in (once ready): ones you can no longer see are left out. */
  usedCount: number | null;
  durationMs: number | null;
  /** The finished video. Only its maker sees a recap. */
  video: { mediaId: string; url: string; posterUrl: string | null; hlsUrl: string | null; width: number | null; height: number | null } | null;
  /** A file name for saving it. */
  fileName: string;
  /** Everything in it is yours, so it can be posted as a reel. */
  canPost: boolean;
  /** It can be sent in a chat: everything in it is yours or already public. */
  canSend: boolean;
  createdAt: string;
  finishedAt: string | null;
}
