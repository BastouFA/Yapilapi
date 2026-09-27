/**
 * The client side of the audio-room mesh, shared by the web and mobile apps so
 * they speak the same protocol.
 *
 * Every speaker sends audio to everyone else in the room; listeners only
 * receive. So a person keeps one WebRTC connection to each speaker, and a
 * speaker also keeps one to each listener. Who sends the offer is fixed, so two
 * people never offer to each other at once for long: in a speaker-listener
 * pair the speaker offers; between two speakers, the smaller user id offers.
 *
 * Signaling data (relayed as-is by POST /v1/rooms/:id/signal):
 *  - offer / answer: { sid, description: { type, sdp } }
 *  - candidate:      { sid, candidate: RTCIceCandidateInit }
 * `sid` names one connection attempt; answers and candidates for an older
 * attempt are ignored. An incoming offer always replaces the connection with
 * that person.
 */
export interface RoomMeshLink {
  userId: string;
  /** Changes when either person's role changes, which means the connection is rebuilt. */
  key: string;
  /** This side sends the offer. */
  offer: boolean;
}

export interface RoomMeshPerson {
  user: { id: string };
  role: 'speaker' | 'listener';
}

/** The connections `meId` should have with the people in the room right now. */
export function roomMeshLinks(meId: string, people: RoomMeshPerson[]): RoomMeshLink[] {
  const mine = people.find((p) => p.user.id === meId);
  if (!mine) return [];
  return people
    .filter((p) => p.user.id !== meId && (mine.role === 'speaker' || p.role === 'speaker'))
    .map((p) => ({
      userId: p.user.id,
      key: `${mine.role}:${p.role}`,
      offer: mine.role === p.role ? meId < p.user.id : mine.role === 'speaker',
    }));
}

export interface RoomSignalData {
  sid: string;
  description?: { type: 'offer' | 'answer'; sdp?: string };
  candidate?: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
}

/** Root-mean-square level of an analyser's time-domain samples (0..1). Above ~0.04 someone is talking. */
export function speechLevel(samples: Uint8Array): number {
  let sum = 0;
  for (const v of samples) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export const ROOM_SPEAKING_LEVEL = 0.04;
/** How often clients tell the API they are still in the room. */
export const ROOM_HEARTBEAT_MS = 15_000;
