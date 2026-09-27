import { musicCredit, type MusicLicence } from '@yapilapi/shared';
import type { MusicProvider, ProviderQuery, ProviderTrack } from './types.ts';

/**
 * An offline provider for development and tests: a few generated tones, each titled "[Dev data]"
 * so nobody takes them for real songs, with licences that cover the cases the checks handle
 * (business use, a country list, a short clip limit). Never on in production.
 */
interface DevTone {
  id: string;
  title: string;
  seconds: number;
  /** Notes of the tune, in Hz, one every half second, repeated. */
  notes: number[];
  licence: Omit<MusicLicence, 'attribution'>;
}

const everywhere = { url: null, regions: null, excludedRegions: [], expiresAt: null, cacheAllowed: true };

export const DEV_TONES: DevTone[] = [
  {
    id: 'tone-morning',
    title: '[Dev data] Morning tone',
    seconds: 40,
    notes: [262, 330, 392, 523, 392, 330],
    licence: { ...everywhere, name: 'Dev licence', commercialUse: true, maxClipSeconds: 30 },
  },
  {
    id: 'tone-evening',
    title: '[Dev data] Evening tone',
    seconds: 45,
    notes: [220, 262, 330, 262],
    licence: { ...everywhere, name: 'Dev licence, personal use', commercialUse: false, maxClipSeconds: 30 },
  },
  {
    id: 'tone-regional',
    title: '[Dev data] Regional tone',
    seconds: 35,
    notes: [294, 370, 440, 370],
    licence: { ...everywhere, name: 'Dev licence, some countries', commercialUse: true, maxClipSeconds: 30, regions: ['NG', 'GH', 'KE'] },
  },
  {
    id: 'tone-short',
    title: '[Dev data] Short clip tone',
    seconds: 60,
    notes: [349, 440, 523, 440],
    licence: { ...everywhere, name: 'Dev licence, 10 second clips', commercialUse: true, maxClipSeconds: 10 },
  },
  {
    id: 'tone-long',
    title: '[Dev data] Long tone',
    seconds: 120,
    notes: [196, 247, 294, 392, 294, 247],
    licence: { ...everywhere, name: 'Dev licence', commercialUse: true, maxClipSeconds: 30 },
  },
];

const ARTIST = 'Dev tones';

export function devProvider(opts: { enabled: boolean; publicApiUrl: string }): MusicProvider & { withdraw(id: string): void; restore(id: string): void } {
  const withdrawn = new Set<string>();
  const base = opts.publicApiUrl.replace(/\/+$/, '');
  const toTrack = (t: DevTone): ProviderTrack => ({
    externalId: t.id,
    title: t.title,
    artist: ARTIST,
    album: null,
    durationMs: t.seconds * 1000,
    coverUrl: null,
    previewUrl: `${base}/v1/music/dev/tones/${t.id}.wav`,
    licence: { ...t.licence, attribution: musicCredit({ title: t.title, artist: ARTIST, licenceName: t.licence.name }) },
  });
  const available = (o: ProviderQuery) =>
    DEV_TONES.filter((t) => !withdrawn.has(t.id) && (!o.commercialOnly || t.licence.commercialUse))
      .slice(0, o.limit)
      .map(toTrack);
  return {
    id: 'dev',
    label: 'Dev tones',
    kind: 'dev',
    enabled: opts.enabled,
    search: async (q, o) => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return available({ ...o, limit: DEV_TONES.length })
        .filter((t) => words.every((w) => `${t.title} ${t.artist}`.toLowerCase().includes(w)))
        .slice(0, o.limit);
    },
    trending: async (o) => available(o),
    getTrack: async (id) => {
      const t = DEV_TONES.find((x) => x.id === id);
      return t && !withdrawn.has(id) ? toTrack(t) : null;
    },
    /** Tests: the provider takes a tone down, or puts it back. */
    withdraw: (id) => void withdrawn.add(id),
    restore: (id) => void withdrawn.delete(id),
  };
}

const wavCache = new Map<string, Buffer>();

/** A tone as a small WAV file (8 kHz, 8-bit mono): a simple tune with soft note edges. */
export function devToneWav(id: string): Buffer | null {
  const tone = DEV_TONES.find((t) => t.id === id);
  if (!tone) return null;
  const hit = wavCache.get(id);
  if (hit) return hit;
  const rate = 8000;
  const n = tone.seconds * rate;
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n, 40);
  const noteLen = rate / 2;
  for (let i = 0; i < n; i++) {
    const note = tone.notes[Math.floor(i / noteLen) % tone.notes.length]!;
    const inNote = (i % noteLen) / noteLen;
    const envelope = Math.min(1, inNote * 20) * Math.min(1, (1 - inNote) * 8);
    const v = Math.sin((2 * Math.PI * note * i) / rate) * 0.35 * envelope;
    buf[44 + i] = Math.round(128 + v * 127);
  }
  wavCache.set(id, buf);
  return buf;
}
