import type { MusicSource } from './music.ts';
import type { PublicUser } from './types.ts';

/**
 * Mixes: song lists people make and share. A mix holds up to MIX_SONGS_MAX songs from anywhere the
 * music picker offers (in-app sounds and catalogue songs), in an order that can be changed. Shared
 * into a chat, everyone there can add and reorder songs. Listening plays each song's allowed part
 * one after another, skipping songs that can't play for the listener, and never starts by itself.
 *
 * No zod here: the mobile app imports this file directly. The request schemas are in mix-schemas.ts.
 */

export const MIX_TITLE_MAX = 80;
export const MIX_DESCRIPTION_MAX = 300;
export const MIX_SONGS_MAX = 100;
/** Songs added in one go. */
export const MIX_ADD_MAX = 20;
/** Mixes one person can make. */
export const MIXES_MAX = 200;
/** Adds by the same person to a mix within this long share one line in a chat ("Ada added 3 songs"). */
export const MIX_LINE_WINDOW_MINUTES = 10;
/** Covers in the mosaic. */
export const MIX_COVER_TILES = 4;

/** Who sees a mix: only you, friends, followers, or everyone (a private account's followers; an under-18's followers). */
export const MIX_VISIBILITIES = ['private', 'friends', 'followers', 'public'] as const;
export type MixVisibility = (typeof MIX_VISIBILITIES)[number];

/** Your mixes page: the ones you made, the ones shared with you in chats, and the ones you saved. */
export const MIX_FILTERS = ['own', 'shared', 'saved'] as const;
export type MixFilter = (typeof MIX_FILTERS)[number];

/**
 * Why a song in a mix doesn't play for you: not in your country, no longer offered, off here for
 * now, not cleared for business accounts (the mix's owner has one), or a sound you can't see.
 */
export const MIX_SONG_UNAVAILABLE = ['region', 'withdrawn', 'unavailable', 'commercial', 'hidden'] as const;
export type MixSongUnavailable = (typeof MIX_SONG_UNAVAILABLE)[number];

/** The part of a song that plays: from the start, as long as its licence allows (the product plays 30 seconds at most). */
export interface MixPlayPart {
  audioUrl: string;
  startMs: number;
  durationMs: number;
}

/** One song in a mix, as a listener gets it. */
export interface MixSong {
  /** The song's place in this mix (for reordering and removing). */
  id: string;
  source: MusicSource;
  /** The sound's ('library') or catalogue song's id: opens its page. */
  musicId: string;
  /** Empty when the song is a sound you can't see ('hidden'). */
  title: string;
  artist: string;
  coverUrl: string | null;
  durationMs: number | null;
  /** Catalogue songs: the licence's name and the credit it asks for. */
  licenceName: string | null;
  attribution: string | null;
  /** What plays for you. Null when it can't (see `unavailable`); nothing loads before you press play. */
  play: MixPlayPart | null;
  unavailable?: MixSongUnavailable;
  /** Who added it. Null when their account is gone (`addedByFormer`) or you can't see them. */
  addedBy: PublicUser | null;
  /** Added by someone whose account was deleted: "Added by a former member". */
  addedByFormer?: boolean;
  addedAt: string;
  /** You may take it off: the owner any song, others the songs they added. */
  canRemove: boolean;
}

/** A chat a mix is shared into, as someone in it (or the owner) sees it. */
export interface MixChat {
  conversationId: string;
  kind: 'direct' | 'group';
  /** A group's name; for a one-to-one chat, the other person's name. */
  title: string | null;
  messageId: string;
}

/** A mix, as its card and page show it. */
export interface Mix {
  id: string;
  title: string;
  description: string;
  visibility: MixVisibility;
  owner: PublicUser;
  songCount: number;
  /** Covers of the first songs that have one (up to MIX_COVER_TILES), for the mosaic. Empty on Data saver. */
  covers: string[];
  likeCount: number;
  liked: boolean;
  saved: boolean;
  /** Your part: the owner, someone in a chat it's shared into, or null (you just see it). */
  role: 'owner' | 'collaborator' | null;
  /** You may add and reorder songs. */
  canAdd: boolean;
  /** Chats it's shared into that you're in (the owner sees all of them). */
  chats: MixChat[];
  createdAt: string;
  updatedAt: string;
}

/** A mix with its songs, in order. */
export interface MixDetail extends Mix {
  songs: MixSong[];
}

/** A mix on a post or in a chat: the card, or a note that it isn't there for you any more. */
export type MixCard = ({ available: true } & Mix) | { id: string; available: false };

/** The index of the next song that can play from `from` (itself included), or -1 when none is left. */
export function nextPlayable(songs: Pick<MixSong, 'play'>[], from: number): number {
  for (let i = Math.max(0, from); i < songs.length; i++) if (songs[i]!.play) return i;
  return -1;
}

/** The index of the song that played before `from` and can play, or -1. */
export function previousPlayable(songs: Pick<MixSong, 'play'>[], from: number): number {
  for (let i = Math.min(from, songs.length) - 1; i >= 0; i--) if (songs[i]!.play) return i;
  return -1;
}

/** The list with one item moved from `from` to `to` (both clamped). Used to reorder songs with buttons or by dragging. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item!);
  return out;
}

/** How long a mix plays, in milliseconds: the parts that can play for you. */
export const mixPlayMs = (songs: Pick<MixSong, 'play'>[]) => songs.reduce((n, s) => n + (s.play?.durationMs ?? 0), 0);
