/**
 * A small QR code encoder (ISO/IEC 18004), for the phone app, which has no QR library: tickets
 * show their code with it. Byte mode (text as UTF-8), versions 1 to 10 (up to 271 bytes at level
 * L, 213 at M), any error correction level.
 *
 * It picks the mask the way the web's generator (qrcode-generator) does, with the same scoring,
 * so the same text gives the same modules on the web and on the phone; qr.test.ts compares the
 * two on known strings.
 *
 * No zod and no dependencies here: the mobile app imports this file directly.
 */

export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  /** 1 to 10. */
  version: number;
  /** Modules per side (version × 4 + 17). */
  size: number;
  level: QrErrorLevel;
  /** 0 to 7. */
  mask: number;
  /** modules[row][column]: true is dark. Leave a quiet zone of 4 light modules around it when drawing. */
  modules: boolean[][];
}

/** The highest version supported. */
export const QR_MAX_VERSION = 10;

/** The level's two bits in the format information. */
const LEVEL_BITS: Record<QrErrorLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Error correction blocks per version (index 0 is version 1) and level:
 * [block count, codewords per block, data codewords per block], then a second group when there is one.
 */
const RS_BLOCKS: Record<QrErrorLevel, number[][]> = {
  L: [
    [1, 26, 19],
    [1, 44, 34],
    [1, 70, 55],
    [1, 100, 80],
    [1, 134, 108],
    [2, 86, 68],
    [2, 98, 78],
    [2, 121, 97],
    [2, 146, 116],
    [2, 86, 68, 2, 87, 69],
  ],
  M: [
    [1, 26, 16],
    [1, 44, 28],
    [1, 70, 44],
    [2, 50, 32],
    [2, 67, 43],
    [4, 43, 27],
    [4, 49, 31],
    [2, 60, 38, 2, 61, 39],
    [3, 58, 36, 2, 59, 37],
    [4, 69, 43, 1, 70, 44],
  ],
  Q: [
    [1, 26, 13],
    [1, 44, 22],
    [2, 35, 17],
    [2, 50, 24],
    [2, 33, 15, 2, 34, 16],
    [4, 43, 19],
    [2, 32, 14, 4, 33, 15],
    [4, 40, 18, 2, 41, 19],
    [4, 36, 16, 4, 37, 17],
    [6, 43, 19, 2, 44, 20],
  ],
  H: [
    [1, 26, 9],
    [1, 44, 16],
    [2, 35, 13],
    [4, 25, 9],
    [2, 33, 11, 2, 34, 12],
    [4, 43, 15],
    [4, 39, 13, 1, 40, 14],
    [4, 40, 14, 2, 41, 15],
    [4, 36, 12, 4, 37, 13],
    [6, 43, 15, 2, 44, 16],
  ],
};

/** Centres of the alignment patterns per version (index 0 is version 1). */
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ─── Galois field GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1 ─────────────────────────────
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** The generator polynomial for `degree` error correction codewords, highest power first. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon error correction codewords for one block. */
function errorCodewords(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    if (factor) for (let i = 0; i < degree; i++) rem[i]! ^= gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

/** UTF-8 bytes, without TextEncoder (not every phone runtime has it). */
export function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

function blocksOf(version: number, level: QrErrorLevel): { total: number; data: number }[] {
  const row = RS_BLOCKS[level][version - 1]!;
  const out: { total: number; data: number }[] = [];
  for (let i = 0; i < row.length; i += 3) for (let k = 0; k < row[i]!; k++) out.push({ total: row[i + 1]!, data: row[i + 2]! });
  return out;
}

const dataCapacity = (version: number, level: QrErrorLevel) => blocksOf(version, level).reduce((n, b) => n + b.data, 0);
/** Bits for the character count in byte mode. */
const countBits = (version: number) => (version < 10 ? 8 : 16);

/** The codewords to place: data then error correction, interleaved block by block. */
function codewords(bytes: number[], version: number, level: QrErrorLevel): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  const capacity = dataCapacity(version, level) * 8;
  if (bits.length + 4 <= capacity) put(0, 4);
  while (bits.length % 8) bits.push(0);
  for (let pad = 0; bits.length < capacity; pad ^= 1) put(pad ? 0x11 : 0xec, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));

  const blocks = blocksOf(version, level);
  const dc: number[][] = [];
  const ec: number[][] = [];
  let offset = 0;
  for (const b of blocks) {
    const part = data.slice(offset, offset + b.data);
    offset += b.data;
    dc.push(part);
    ec.push(errorCodewords(part, b.total - b.data));
  }
  const out: number[] = [];
  for (const group of [dc, ec]) {
    const longest = Math.max(...group.map((g) => g.length));
    for (let i = 0; i < longest; i++) for (const g of group) if (i < g.length) out.push(g[i]!);
  }
  return out;
}

/** BCH code for the 5 bits of format information, masked. */
function formatBits(data: number): number {
  let d = data << 10;
  for (let bit = 14; bit >= 10; bit--) if ((d >>> bit) & 1) d ^= 0x537 << (bit - 10);
  return ((data << 10) | d) ^ 0x5412;
}

/** BCH code for the 6 bits of version information (versions 7 and up). */
function versionBits(version: number): number {
  let d = version << 12;
  for (let bit = 17; bit >= 12; bit--) if ((d >>> bit) & 1) d ^= 0x1f25 << (bit - 12);
  return (version << 12) | d;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

/**
 * Lay out the symbol with `mask`. With `test`, the format and version information are left light,
 * as the web's generator does while it scores the masks.
 */
function layout(version: number, level: QrErrorLevel, data: number[], mask: number, test: boolean): boolean[][] {
  const n = version * 4 + 17;
  const m: (boolean | null)[][] = Array.from({ length: n }, () => new Array<boolean | null>(n).fill(null));

  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      if (row + r < 0 || row + r >= n) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c < 0 || col + c >= n) continue;
        m[row + r]![col + c] =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);

  const centres = ALIGNMENT[version - 1]!;
  for (const row of centres)
    for (const col of centres) {
      if (m[row]![col] !== null) continue;
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) m[row + r]![col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
    }

  for (let i = 8; i < n - 8; i++) {
    if (m[i]![6] === null) m[i]![6] = i % 2 === 0;
    if (m[6]![i] === null) m[6]![i] = i % 2 === 0;
  }

  const format = formatBits((LEVEL_BITS[level] << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const dark = !test && ((format >> i) & 1) === 1;
    // Down the column next to the top-left finder, then up from the bottom-left one.
    if (i < 6) m[i]![8] = dark;
    else if (i < 8) m[i + 1]![8] = dark;
    else m[n - 15 + i]![8] = dark;
    // Along the row, from the top-right finder in, then the top-left one.
    if (i < 8) m[8]![n - i - 1] = dark;
    else if (i < 9) m[8]![15 - i] = dark;
    else m[8]![14 - i] = dark;
  }
  m[n - 8]![8] = !test;

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = !test && ((bits >> i) & 1) === 1;
      m[Math.floor(i / 3)]![(i % 3) + n - 11] = dark;
      m[(i % 3) + n - 11]![Math.floor(i / 3)] = dark;
    }
  }

  // Data, two columns at a time from the bottom right, zigzagging up and down.
  const maskFn = MASKS[mask]!;
  let row = n - 1;
  let step = -1;
  let byte = 0;
  let bit = 7;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row]![col - c] !== null) continue;
        let dark = byte < data.length && ((data[byte]! >>> bit) & 1) === 1;
        if (maskFn(row, col - c)) dark = !dark;
        m[row]![col - c] = dark;
        if (--bit < 0) {
          byte++;
          bit = 7;
        }
      }
      row += step;
      if (row < 0 || row >= n) {
        row -= step;
        step = -step;
        break;
      }
    }
  }
  return m as boolean[][];
}

/** How bad a mask looks to a scanner, scored as the web's generator scores it (lower is better). */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let lost = 0;
  // Modules that look like most of their neighbours.
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let same = 0;
      const dark = m[r]![c];
      for (let dr = -1; dr <= 1; dr++) {
        if (r + dr < 0 || r + dr >= n) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (c + dc < 0 || c + dc >= n || (dr === 0 && dc === 0)) continue;
          if (m[r + dr]![c + dc] === dark) same++;
        }
      }
      if (same > 5) lost += 3 + same - 5;
    }
  // Blocks of 2 × 2 of one colour.
  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++) {
      const count = +m[r]![c]! + +m[r + 1]![c]! + +m[r]![c + 1]! + +m[r + 1]![c + 1]!;
      if (count === 0 || count === 4) lost += 3;
    }
  // Patterns that look like a finder (1:1:3:1:1), across and down.
  const finderLike = (at: (i: number) => boolean) => at(0) && !at(1) && at(2) && at(3) && at(4) && !at(5) && at(6);
  for (let r = 0; r < n; r++) for (let c = 0; c < n - 6; c++) if (finderLike((i) => m[r]![c + i]!)) lost += 40;
  for (let c = 0; c < n; c++) for (let r = 0; r < n - 6; r++) if (finderLike((i) => m[r + i]![c]!)) lost += 40;
  // Far from half dark.
  let darkCount = 0;
  for (const row of m) for (const v of row) if (v) darkCount++;
  const ratio = Math.abs((100 * darkCount) / n / n - 50) / 5;
  return lost + ratio * 10;
}

/**
 * Encode `text` as a QR code: the smallest version that holds it at `level` (M by default, which
 * still reads with some damage or glare). `mask` forces a mask instead of the best-scoring one.
 * Throws when the text doesn't fit in version 10.
 */
export function encodeQr(text: string, opts: { level?: QrErrorLevel; mask?: number } = {}): QrCode {
  const level = opts.level ?? 'M';
  const bytes = utf8Bytes(text);
  let version = 1;
  while (version <= QR_MAX_VERSION && 4 + countBits(version) + bytes.length * 8 > dataCapacity(version, level) * 8) version++;
  if (version > QR_MAX_VERSION) throw new RangeError('Too long for a QR code');
  const data = codewords(bytes, version, level);
  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = 0;
    for (let i = 0; i < 8; i++) {
      const score = penalty(layout(version, level, data, i, true));
      if (i === 0 || score < best) {
        best = score;
        mask = i;
      }
    }
  }
  const modules = layout(version, level, data, mask, false);
  return { version, size: modules.length, level, mask, modules };
}

/**
 * The dark modules of each row as runs [start column, length], so a view can draw a row with a
 * few rectangles instead of one per module.
 */
export function qrRuns(modules: boolean[][]): [number, number][][] {
  return modules.map((row) => {
    const runs: [number, number][] = [];
    let start = -1;
    row.forEach((dark, c) => {
      if (dark && start < 0) start = c;
      if (!dark && start >= 0) {
        runs.push([start, c - start]);
        start = -1;
      }
    });
    if (start >= 0) runs.push([start, row.length - start]);
    return runs;
  });
}
