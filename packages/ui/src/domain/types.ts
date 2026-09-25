/** Structural data shapes the domain components render. `@yapilapi/api-client` types satisfy them. */

export type VisibilityKind =
  'public' | 'followers' | 'friends' | 'circle' | 'selected' | 'private' | 'community';
export type ReactionType = 'like' | 'love' | 'laugh' | 'wow' | 'sad' | 'insightful';

export interface AuthorData {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PollData {
  question: string;
  multiple: boolean;
  closesAt: string | null;
  options: Array<{ id: string; label: string; votes: number }>;
  myVotes: string[];
  totalVotes: number;
}

export interface MediaData {
  id: string;
  kind: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  status: string;
}

export interface PostData {
  id: string;
  author: AuthorData;
  body: string;
  visibility: VisibilityKind;
  createdAt: string;
  editedAt: string | null;
  topics: string[];
  counts: { likes: number; comments: number; shares: number; saves: number };
  viewer: { reaction: ReactionType | null; saved: boolean; isAuthor: boolean };
  poll: PollData | null;
  link: { url: string } | null;
  media: MediaData[];
}

export interface CommentData {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  author: AuthorData;
  counts: { likes: number; replies: number };
  viewer: { reaction: ReactionType | null; isAuthor: boolean };
  pendingApproval: boolean;
  editedAt: string | null;
  createdAt: string;
}

export interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  mode: string;
  links: Array<{ label: string; url: string }>;
  locationText: string | null;
  isPrivate: boolean;
  counts: { followers: number; following: number; friends: number };
  joinedAt: string;
  contentHidden: boolean;
}

export type FeedbackAction =
  | { type: 'more_like_this' }
  | { type: 'less_like_this' }
  | { type: 'not_interested' }
  | { type: 'mute_creator' }
  | { type: 'mute_topic'; topic: string };

export interface UserChip {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}
export interface CircleOption {
  id: string;
  name: string;
  memberCount: number;
}
export interface TopicOption {
  slug: string;
  name: string;
}
