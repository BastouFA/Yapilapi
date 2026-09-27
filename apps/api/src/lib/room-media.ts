import { ROOM_MAX_LISTENERS, ROOM_MAX_SPEAKERS, type RoomMediaSession } from '@yapilapi/shared';
import type { Config } from '../config.ts';
import { iceServers, turnConfigured } from './ice.ts';
import type { RealtimeHub } from './realtime.ts';

export type RoomRole = 'speaker' | 'listener';
export type RoomSignalType = 'offer' | 'answer' | 'candidate';

/**
 * The boundary between audio rooms and the thing that moves their audio.
 *
 * The rooms module owns who is in a room, their roles and every permission
 * check. It asks the media adapter only media questions: how big a room can
 * get, what a client needs to connect, whether two people exchange audio
 * directly, and to deliver a signaling message once the module has checked
 * both people are in the room. It tells the adapter when people come, go or
 * change role, and when a room ends.
 *
 * Today's adapter is a WebRTC mesh: every speaker sends audio straight to
 * everyone else in the room, so speakers and listeners are capped. A selective
 * forwarding unit (SFU) replaces it by implementing this interface: bigger
 * limits, `session` returning the SFU's endpoint and token, `connects`
 * answering "does this person talk to the server" instead of "to that
 * person", `relay` forwarding to the SFU, and the lifecycle hooks
 * opening, updating and closing the SFU's routing. Nothing else changes.
 */
export interface RoomMedia {
  readonly mode: RoomMediaSession['mode'];
  readonly limits: { speakers: number; listeners: number };
  /** What one person's client needs to connect its audio. */
  session(user: { id: string; minor: boolean }): RoomMediaSession;
  /** Whether two people in the same room exchange audio directly (and so may signal each other). */
  connects(a: RoomRole, b: RoomRole): boolean;
  /** Deliver one signaling message. Callers have already checked that both people are in the room and `connects` allows it. */
  relay(roomId: string, from: string, to: string, type: RoomSignalType, data: unknown): Promise<void>;
  /** Someone joined, left or changed role. Mesh clients rebuild their own connections from `room.state`, so this is a no-op there. */
  participantChanged(roomId: string, userId: string, role: RoomRole | null): Promise<void>;
  roomEnded(roomId: string): Promise<void>;
}

/** Audio peer to peer over WebRTC; the API relays offers, answers and ICE candidates over the realtime socket. */
export function meshRoomMedia(config: Pick<Config, 'TURN_URLS' | 'TURN_SECRET'>, realtime: RealtimeHub): RoomMedia {
  return {
    mode: 'mesh',
    limits: { speakers: ROOM_MAX_SPEAKERS, listeners: ROOM_MAX_LISTENERS },
    session: (user) => ({
      mode: 'mesh',
      iceServers: iceServers(config, user.id),
      // People under 18 send and receive through TURN when it's set up, so strangers in the room never see their network address.
      iceTransportPolicy: user.minor && turnConfigured(config) ? 'relay' : 'all',
    }),
    // Speakers send to everyone; listeners only receive, so two listeners never connect.
    connects: (a, b) => a === 'speaker' || b === 'speaker',
    relay: (roomId, from, to, type, data) => realtime.publish([to], { type: 'room.signal', data: { roomId, from, type, data } }),
    participantChanged: async () => {},
    roomEnded: async () => {},
  };
}
