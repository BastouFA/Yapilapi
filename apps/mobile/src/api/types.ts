/** Shapes of endpoints that packages/api-client does not type yet (discover, search, notifications, media, push). */
import type { Community, Post, Uuid, IsoDate } from '@yapilapi/api-client';

export interface SuggestedPerson {
  user: {
    id: Uuid;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string;
    mode: string;
    isPrivate: boolean;
    followerCount: number;
    viewer: { following: string; friend: boolean };
  };
  reasons: string[];
  explanation: string;
  score: number;
}
export interface TrendingTopic {
  slug: string;
  name: string;
  postCount: number;
  authorCount: number;
  score: number;
}
export interface TrendingResponse {
  window: string;
  topics: TrendingTopic[];
  items: Array<Post & { reasons?: string[] }>;
  nextCursor: string | null;
}
export interface DiscoverTopic {
  slug: string;
  name: string;
  postsThisWeek: number;
  communities: number;
  interested: boolean;
  reason: string;
}
export type DiscoverCommunity = Community & { reasons: string[]; explanation: string };

export interface SearchPersonItem {
  type: 'people';
  id: Uuid;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  isPrivate: boolean;
  followerCount: number;
}
export interface SearchResponse {
  query: string;
  total: number;
  results: {
    posts?: { items: Array<Post & { type: 'posts' }>; nextCursor?: string | null };
    people?: { items: SearchPersonItem[]; nextCursor?: string | null };
    communities?: { items: Array<Community & { type: 'communities' }>; nextCursor?: string | null };
  };
}
export interface SuggestResponse {
  query: string;
  items: Array<{
    type: string;
    id: Uuid;
    label: string;
    sublabel?: string;
    ref?: Record<string, unknown>;
  }>;
  recent: string[];
}

export interface NotificationActor {
  id: Uuid;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}
export interface AppNotification {
  id: Uuid;
  kind: string;
  category: string;
  actor: NotificationActor | null;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: IsoDate;
}
export interface NotificationCounts {
  total: number;
  byCategory: Record<string, number>;
}
export interface PushTokenRow {
  id: Uuid;
  platform: string;
  provider: string;
  tokenTail: string;
  createdAt: IsoDate;
  lastUsedAt: IsoDate | null;
  active: boolean;
}

export interface MediaView {
  id: Uuid;
  kind: 'image' | 'video' | 'audio' | 'file';
  status: string;
  mimeType: string;
  sizeBytes: number;
  url: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  blurhash: string | null;
  altText: string | null;
  needsAltText: boolean;
  variants: Array<{
    name: string;
    url: string;
    mimeType: string;
    width: number | null;
    height: number | null;
  }>;
}
export interface UploadInit {
  id: Uuid;
  mode: 'chunked' | 'direct';
  status: 'pending';
  size: number;
  expiresAt: IsoDate;
  chunkSize?: number;
  chunkCount?: number;
}
export interface UploadStatus {
  id: Uuid;
  status: string;
  mode: string;
  size: number;
  chunkSize: number | null;
  chunkCount: number | null;
  received: number[];
  missing: number[];
  expiresAt: IsoDate | null;
  expired: boolean;
}
export interface ChunkResult {
  index: number;
  duplicate: boolean;
  receivedCount: number;
  chunkCount: number;
  complete: boolean;
}

export interface ExportResult {
  requestId: Uuid;
  status: string;
  expiresAt: IsoDate;
  sizeBytes: number;
  next: string;
}
export interface PrivacyRequest {
  id: Uuid;
  kind: 'export' | 'delete' | string;
  status: string;
  createdAt: IsoDate;
  completedAt: IsoDate | null;
  export?: { downloadable: boolean; expiresAt: IsoDate | null; sizeBytes: number | null };
  scheduledFor?: IsoDate | null;
}
