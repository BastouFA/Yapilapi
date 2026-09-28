import type { StoryCard } from './stories.ts';
import type { PostMusic } from './music.ts';
import type { DataSaverMode } from './data-saver.ts';
import type { TranslationSettings } from './translation.ts';
import type { ReelHighlight } from './reels.ts';
import type { ProfileStyle, ProfileTab } from './profile-style.ts';
import type { ChatTheme } from './chat-theme.ts';
import type { ProfileAskBox, QuotedQuestion } from './ask.ts';
import type { DrawReason, GameKind, GameState } from './games/types.ts';
import type { MixCard } from './mixes.ts';
import type { CoverRecipe } from './cover.ts';
import type { EchoPermission, EchoRef } from './echoes.ts';
import type {
  BoardVisibility,
  CircleKind,
  CommentPolicy,
  CommunityRole,
  NowStatusAudience,
  NowStatusIcon,
  PostKind,
  ProfileMode,
  RoomReaction,
  RoomStatus,
  Visibility,
} from './constants.ts';

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
  /** Set when the account has no birth date yet (made before it was required): the apps ask for it once. */
  needsBirthDate?: boolean;
  role: 'user' | 'moderator' | 'admin';
  onboarded: boolean;
  locale: string;
  /** ISO 3166-1 alpha-2, set by the person or from a trusted CDN header. */
  country: string | null;
  /** When YAPILAPI Plus ends (it never renews on its own), or null without Plus. */
  plusUntil: string | null;
  /** Data saver, as saved on the account (PUT /v1/me/data-saver). A device may override it locally. */
  dataSaver: DataSaverMode;
  /** "Languages I understand" and "Translate automatically" (PUT /v1/me/translation). */
  translation: TranslationSettings;
}

/** Account details for Settings > Account (GET /v1/me/account). Only ever sent to the account itself. */
export interface AccountInfo {
  email: string;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  /** YYYY-MM-DD, or null for an account made before a birth date was required. */
  birthDate: string | null;
  createdAt: string;
}

/** Who can reach you, notification quiet hours and sensitive media (GET/PUT /v1/me/interactions). */
export interface InteractionSettings {
  messagesFrom: 'everyone' | 'following' | 'friends';
  commentsFrom: 'everyone' | 'following' | 'followers';
  mentionsFrom: 'everyone' | 'following' | 'nobody';
  /** "HH:MM" in `timezone`; null when quiet hours are off. */
  quietHours: { start: string; end: string; timezone: string } | null;
  sensitiveMedia: 'standard' | 'less';
  /** Under 18: sensitive media is never shown, whatever the setting. */
  sensitiveLocked: boolean;
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

export interface ProfileLink {
  label: string;
  url: string;
  iconUrl: string | null;
}

export interface Profile extends PublicUser {
  bio: string;
  coverUrl: string | null;
  /** Describes the cover photo for screen readers. */
  coverAlt: string | null;
  /**
   * Only on your own profile: the original photo behind your cover and how it was edited, so
   * "Edit cover" can open it again as you left it. `recipe` is null for a cover set without editing.
   */
  coverEdit?: CoverEditState | null;
  /** Their current "Now" status, when there is one and you're in its audience. */
  nowStatus: NowStatus | null;
  /** Up to 5 web links. `iconUrl` is the site's icon, fetched and checked on the server (null: show a generic icon). */
  links: ProfileLink[];
  isPrivate: boolean;
  interests: string[];
  counts: { followers: number; following: number; friends: number; posts: number };
  /** Accent and header style; the apps turn the accent into contrast-checked colours (profileAccentColors). */
  style: ProfileStyle;
  /** Shown next to the name, when set. */
  pronouns: string | null;
  /** City, as text. Never shown to others on accounts of people under 18. */
  city: string | null;
  /** When the account was made. */
  joinedAt: string;
  /** Which tabs show, in order. */
  tabs: ProfileTab[];
  /** Up to 3 of their posts or reels shown first, only those this viewer can see. */
  featured: Post[];
  /** A song on the profile: plays only when tapped. `audioUrl` is null where it can't play (see `unavailable`). */
  song: PostMusic | null;
  /** Their question box ("Ask me"), for this viewer. Null when it's off and there are no answers to show. */
  ask: ProfileAskBox | null;
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

/** Your cover's original photo (a processed size to edit on) and the recipe it was made with. */
export interface CoverEditState {
  mediaId: string;
  url: string;
  /** The original's upright size, in pixels. */
  width: number | null;
  height: number | null;
  altText: string | null;
  recipe: CoverRecipe | null;
}

/** One of your recent photos that can be a cover (GET /v1/me/cover/photos). */
export interface CoverPhoto {
  id: string;
  /** A small size, for the picker. */
  thumbUrl: string;
  /** A size big enough to frame the cover on. */
  url: string;
  width: number | null;
  height: number | null;
  altText: string | null;
  createdAt: string;
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  /**
   * Processed sizes. Photos: thumb/medium/large webp. Videos: mp4 (web MP4), mp4_360 (the
   * lowest MP4), hls_360 (the 360p HLS rung) and thumb (a small poster). Empty until
   * processing finishes. On lite responses (?lite=1 or Save-Data: on) `large` is left out.
   */
  variants?: Record<string, string>;
  /** Bytes of the original ("original") and of each processed size, keyed like `variants` (plus "poster", "hls_720"). */
  sizes?: Record<string, number>;
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
  /**
   * Views count each person once and never the author; recorded for reels. Remixes counts duets and remixes of a reel;
   * echoes counts the echoes of a reel that are up (the list shows the ones you can see).
   */
  counts: { likes: number; comments: number; reposts: number; views: number; remixes?: number; echoes?: number };
  /** Reels: whether other people may duet or remix it. */
  allowRemix?: boolean;
  /** Reels posted as a duet or remix of another reel. */
  remixOf?: RemixRef | null;
  /** Reels posted as an echo of another reel: the reel it answers (see echoes.ts). */
  echoOf?: EchoRef | null;
  /** Only on your own reels: who may echo it (your choice, or the default for your account). */
  allowEchoes?: EchoPermission;
  /** Reels: the sound it uses (its own, or one it borrowed). */
  sound?: SoundRef | null;
  /** Reels: named points the creator marked in the video (up to five, in time order), shown on the scrubber. */
  highlights?: ReelHighlight[];
  /**
   * Music playing with it: part of a sound or a catalogue song on a photo, carousel or text post, or a
   * catalogue song a reel plays instead of its own audio. Muted until the viewer taps it.
   */
  music?: PostMusic | null;
  /** Pinned to the top of its author's profile (only set in profile listings). */
  pinned?: boolean;
  /** Who can comment, as the author chose. */
  commentPolicy?: CommentPolicy;
  viewer: {
    liked: boolean;
    saved: boolean;
    reposted: boolean;
    /** Whether the viewer may comment (their account, the author's comment controls, blocks). */
    canComment?: boolean;
    /** Set when the viewer was invited to co-author this post: waiting for their answer, or accepted. */
    collab?: CollabStatus;
    /** Only in your Saved list and boards: your private note on your save of this post. */
    note?: string;
    /** Reels: where you stopped watching it last time (continue where you left off). Absent when there's nothing to resume. */
    resumeMs?: number;
    /** Reels: whether you may echo it (the creator's setting, your account and theirs, and the reel itself). */
    canEcho?: boolean;
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
  /** Detected language of the text (ISO 639-1), or null when it couldn't be told. Drives "See translation". */
  lang?: string | null;
  /** Set once the text was changed after publishing: shown as "Edited", which opens the history (GET /v1/posts/:id/history). */
  editedAt?: string;
  /** Only on your own drafts and scheduled posts, which nobody else sees. Published posts leave it out. */
  status?: 'draft' | 'scheduled';
  /** Scheduled posts: when it will be published. */
  scheduledAt?: string | null;
  /** An answer shared from the author's question box: the question it answers (the post's text is the answer). */
  question?: QuotedQuestion | null;
  /** A mix shared as a post: its card, or a note that it isn't there for this viewer. */
  mix?: MixCard | null;
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
  /** Stories you can see that use it. */
  stories: number;
  /** Photo and text posts you can see that play it. */
  posts: number;
  /** Whether you saved it in the music picker. */
  saved?: boolean;
  /** Whether you can make a reel with it (its source reel is public and allows remixes). */
  canUse: boolean;
  createdAt: string;
}

export interface Comment {
  id: string;
  postId: string;
  /** The top-level comment of the thread; null for a top-level comment. */
  parentId: string | null;
  /** The comment this one answers: its top-level comment, or a reply in the same thread. */
  replyToId: string | null;
  body: string;
  /** Detected language of the text (ISO 639-1), or null when it couldn't be told. Drives "See translation". */
  lang?: string | null;
  author: PublicUser;
  createdAt: string;
  /** Set once the text was changed (shown as "Edited"). */
  editedAt: string | null;
  likes: number;
  /** Top-level comments: how many replies are in the thread. */
  replies: number;
  /** Pinned by the post's author to the top. */
  pinned: boolean;
  /** The post's author liked it. */
  likedByAuthor: boolean;
  /** Only in the post author's hidden comments: hidden because it contains one of their hidden words. */
  hidden?: boolean;
  /** Reels: a moment comment, anchored to this time in the video. */
  atMs?: number | null;
  viewer: {
    liked: boolean;
    /** The writer, until COMMENT_EDIT_MINUTES after posting. */
    canEdit: boolean;
    /** The writer, or the post's author. */
    canDelete: boolean;
  };
}

/** A page of top-level comments (or replies), with what the viewer can do on the post. */
export interface CommentPage extends Page<Comment> {
  commentPolicy: CommentPolicy;
  /** Whether the viewer may comment now (signed in, and allowed by the post's comment controls). */
  canComment: boolean;
  /** The viewer is the post's author: they can pin, change who can comment, and review hidden comments. */
  isPostAuthor: boolean;
  /** Post author only: comments hidden by their hidden words, waiting for review. */
  hiddenCount?: number;
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
  /** Suggested replies in this chat, for you. */
  smartReplies?: ConversationSmartReplies;
  /** The chat's wallpaper and bubble colour, the same for everyone in it. Any member can change them. */
  theme?: ChatTheme;
}

/**
 * Suggested replies in one chat. `setting` is your choice for this chat (null: the default, on in
 * one-to-one chats and off in groups); `on` also takes the switch in Settings and the feature flag into account.
 */
export interface ConversationSmartReplies {
  on: boolean;
  setting: boolean | null;
  defaultOn: boolean;
  /** The switch in Settings (all chats). */
  everywhere: boolean;
}

/**
 * A message waiting to be sent later ("Send later"). Only its sender sees it. At `sendAt` it goes
 * out as a normal message, with the chat's rules at that moment (blocks, membership, disappearing
 * messages). A failed one keeps `failure`, the reason it couldn't go out.
 */
export interface ScheduledMessage {
  id: string;
  conversationId: string;
  body: string;
  replyToId: string | null;
  sendAt: string;
  status: 'scheduled' | 'sent' | 'failed' | 'cancelled';
  failure?: string | null;
  /** Once sent: the message it became. */
  messageId?: string | null;
  createdAt: string;
}

/** Settings > Account: your username and when it can change next. */
export interface UsernameStatus {
  username: string;
  /** When you last changed it (null: never). */
  changedAt: string | null;
  /** The earliest moment you can change it again, or null when you can now. */
  nextChangeAt: string | null;
}

/** Answer to "is this username free?" `reason` says why not. */
export interface UsernameCheck {
  available: boolean;
  reason?: 'taken' | 'reserved' | 'invalid' | 'held' | 'current';
  /** A plain sentence about why, for the field. */
  message?: string;
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
  /** A poll (body is its question), a shared list (body is its title), a game (see `gameKind`) or a mix (body is its title). */
  kind?: 'poll' | 'list' | 'game' | 'mix';
  /** Which game, when `kind` is 'game'. */
  gameKind?: GameKind;
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
export type MessageSystemInfo =
  | {
      type: 'disappearing';
      /** The new setting: seconds, or null when turned off. */
      seconds: number | null;
    }
  | {
      /** The sender changed the chat's wallpaper or bubble colour. */
      type: 'theme';
      wallpaper: ChatTheme['wallpaper'];
      accent: ChatTheme['accent'];
    }
  | {
      /** "Remind the group": a group admin asked for this line at this time. The sender is that admin. */
      type: 'reminder';
      messageId: string;
      /** The message it's about, as you see it (null when it's gone). */
      message?: MessagePreview | null;
    }
  | {
      /** "Watch together" started here. The sender started it; the session may have ended since. */
      type: 'watch';
      sessionId: string;
    }
  | {
      /** The sender started a Together album for the people in this chat. Opens it for those in it. */
      type: 'together';
      togetherId: string;
      title: string;
    }
  | {
      /**
       * A game in the chat ended. 'won': the sender won ("Ada won Four up"), by playing (in chess,
       * checkmate) or because the others forfeited (in chess, resigned). 'draw' and 'unfinished' (a day
       * without a move): the sender made the last move. A chess draw says why.
       */
      type: 'game';
      gameId: string;
      kind: GameKind;
      outcome: 'won' | 'draw' | 'unfinished';
      by?: 'play' | 'forfeit';
      reason?: DrawReason;
    }
  | {
      /**
       * The sender added songs to a mix shared in this chat ("Ada added 3 songs to Road trip"). Adds
       * by the same person within MIX_LINE_WINDOW_MINUTES share one line, whose count goes up.
       */
      type: 'mix';
      mixId: string;
      /** The mix's name when the line was written. */
      title: string;
      count: number;
    };

/** One option of a poll in a chat. */
export interface ChatPollOption {
  id: string;
  text: string;
  votes: number;
  /** You voted for it. */
  mine: boolean;
  /** Who voted for it. Absent when the poll is anonymous. */
  voters?: PublicUser[];
  /** Who added it (the poll's creator, or anyone when the poll lets people add options). */
  addedBy: string;
}

/** A poll in a chat, as one member sees it. It shows as a message whose body is the question. */
export interface ChatPoll {
  question: string;
  options: ChatPollOption[];
  /** Several choices allowed. */
  multiple: boolean;
  /** Nobody sees who voted for what (you still see your own choice). */
  anonymous: boolean;
  /** Anyone in the chat can add options. */
  allowAddOptions: boolean;
  /** When it ends by itself, if set. */
  endsAt: string | null;
  /** It ended (at its time, or early by the person who made it): no more votes. */
  ended: boolean;
  endedAt: string | null;
  createdBy: string;
  /** How many people voted. */
  voterCount: number;
}

/** One item of a shared list in a chat. */
export interface ChatListItem {
  id: string;
  text: string;
  addedBy: PublicUser | null;
  done: boolean;
  /** Who ticked it off (null when not done, or when you can't see them). */
  doneBy: PublicUser | null;
  doneAt: string | null;
}

/** A shared list (checklist) in a chat. It shows as a message whose body is the title. */
export interface ChatList {
  title: string;
  items: ChatListItem[];
  createdBy: string;
  /** Items allowed (100). */
  max: number;
}

/**
 * A game in a chat (Four up, Noughts, Word ladder or Chess), as everyone in the chat sees it. It shows as a
 * message whose card opens the board. `state` is the board as the shared rules in
 * packages/shared/src/games describe it; players sit in `players` order (seat 0 started it).
 */
export interface ChatGame {
  id: string;
  /** The game's card in the chat. */
  messageId: string;
  conversationId: string;
  kind: GameKind;
  players: PublicUser[];
  state: GameState;
  /** Moves so far (forfeits count). Send it with your next move. */
  moveNumber: number;
  status: 'active' | 'won' | 'draw' | 'unfinished';
  winnerId: string | null;
  /** Whose turn it is, while it's going. */
  turnId: string | null;
  createdBy: string;
  createdAt: string;
  lastMoveAt: string;
  /** It ends unfinished at this time if nobody moves (null once over). */
  idleEndsAt: string | null;
  endedAt: string | null;
  /** The rematch started from this game, if any. */
  rematchId: string | null;
  /** Wins at this game in this chat so far, for each of the players (a quiet count, no scores anywhere else). */
  tally: { userId: string; wins: number }[];
}

/** A reminder about a chat message: just for you, or (admins in groups) a line for the whole group. */
export interface ChatReminder {
  id: string;
  messageId: string;
  conversationId: string;
  scope: 'me' | 'group';
  remindAt: string;
  createdAt: string;
  /** The message, as you see it. */
  message?: MessagePreview | null;
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
  /** 'image', 'video' or 'audio' (a voice note that plays once). */
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
  /** Detected language of the text (ISO 639-1), or null when it couldn't be told. Drives "See translation". */
  lang?: string | null;
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
  /** A poll: body is its question. */
  poll?: ChatPoll;
  /** A shared list: body is its title. */
  list?: ChatList;
  /** A game: the message is its card in the chat. */
  game?: ChatGame;
  /** A mix shared into the chat: everyone here can add and reorder songs. Body is its name. */
  mix?: MixCard;
  /** Your earliest waiting "Remind me" on this message. */
  reminder?: { id: string; remindAt: string };
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

/** Links the web sitemap lists (GET /v1/public/sitemap): only public content from public adult accounts. */
export interface PublicSitemap {
  profiles: { username: string; modified: string }[];
  posts: { id: string; modified: string }[];
  tags: { tag: string; modified: string }[];
  communities: { slug: string; modified: string }[];
  events: { id: string; modified: string }[];
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
  /** Likes on the post it comes from (stories count 0; in a Together album, its stars and reactions). */
  likes: number;
  /** When it was shared (ISO); in a Together album, when it was taken. */
  takenAt: string;
  from: 'post' | 'story' | 'together';
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
  source: 'memory' | 'on_this_day' | 'chapter' | 'together';
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

/** Someone in a live audio room. */
export interface RoomParticipant {
  user: PublicUser;
  role: 'speaker' | 'listener';
  /** The person who started the room, or a moderator, admin or owner of the community. */
  host: boolean;
  muted: boolean;
  handRaised: boolean;
  /** A host asked them to speak and they haven't answered yet. */
  invited: boolean;
}

/** A room as shown on its community page. */
export interface RoomSummary {
  id: string;
  title: string;
  status: RoomStatus;
  community: { id: string; slug: string; name: string };
  createdBy: PublicUser;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Whole seconds between start and end, once ended. */
  durationSeconds: number | null;
  /** The most people in the room at once. */
  peakListeners: number;
  /** People in the room now (speakers and listeners). */
  listenerCount: number;
  speakerCount: number;
  /** Up to three people on stage, for the card. */
  speakerPreview: PublicUser[];
  /** The viewer asked to be told when this scheduled room starts. */
  remindMe: boolean;
  limits: { speakers: number; listeners: number };
}

/** A room with everyone in it. Sent on join and as `room.state` realtime events. */
export interface RoomDetail extends RoomSummary {
  speakers: RoomParticipant[];
  listeners: RoomParticipant[];
}

/**
 * How a client connects its audio. `mesh`: WebRTC peer connections to the other
 * people in the room, signaling relayed by the API. An SFU adapter would return
 * its own mode here without changing the room API.
 */
export interface RoomMediaSession {
  mode: 'mesh';
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  /** `relay` keeps the network address private by sending audio through TURN (used for people under 18 when TURN is set up). */
  iceTransportPolicy: 'all' | 'relay';
}

export interface RoomReactionEvent {
  roomId: string;
  userId: string;
  kind: RoomReaction;
}

// ─── AI helpers ─────────────────────────────────────────────────────────
// Everything here is produced by a model (or, in development, by marked rule-based
// stand-ins), is labelled "AI-generated" in the apps, and is never posted or sent
// without the person confirming it.

/** Whether Pulse offers "Catch me up": after being away 12 hours or more, while the posts shared since can be summarized. */
export interface CatchUpOffer {
  offer: boolean;
  /** The visit window: from when you were last on Pulse to when you came back. */
  since?: string;
  until?: string;
  /** How many posts from your people you can see in it. */
  postCount?: number;
}

export interface CatchUpPostLink {
  id: string;
  authorName: string;
  authorUsername: string;
}

export interface CatchUpLine {
  text: string;
  /** The posts this line is about. Every one is a post you can see. */
  posts: CatchUpPostLink[];
}

export interface CatchUpSection {
  kind: 'moments' | 'plans' | 'popular';
  lines: CatchUpLine[];
}

export interface CatchUp {
  since: string;
  until: string;
  sections: CatchUpSection[];
  postCount: number;
  peopleCount: number;
  provider: string;
  cached: boolean;
  /** Set when a development stand-in made it, or something was held back. */
  notice?: string;
}

export interface SmartReplies {
  /** The message the replies answer, or null when there is none to answer. */
  messageId: string | null;
  suggestions: string[];
  /** The language they're written in. */
  language: string | null;
  /** Why there are none: turned off, nothing to answer, or a message that shouldn't get quick replies. */
  reason?: 'off' | 'none' | 'view_once' | 'voice' | 'no_text' | 'sensitive';
  provider?: string;
  notice?: string;
}

export interface AltTextSuggestion {
  mediaId: string;
  text: string;
  provider: string;
  notice?: string;
}

export interface CaptionIdeas {
  captions: string[];
  /** Hashtags people already use on YAPILAPI (without "#"), the most relevant first. */
  hashtags: string[];
  provider: string;
  notice?: string;
}

/** AI helpers you can turn off in Settings. */
export interface AiSettings {
  /** Suggested replies in chats. Off by default under 18. */
  smartReplies: boolean;
  /** The Catch me up card on Pulse. */
  catchUp: boolean;
}
