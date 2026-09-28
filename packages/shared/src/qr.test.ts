import { describe, expect, it } from 'vitest';
import { encodeQr, qrRuns, utf8Bytes, type QrErrorLevel } from './qr.ts';

/**
 * Reference symbols made by the web app's QR generator (qrcode-generator 2.0.4, text as UTF-8):
 * each row of modules as hex, dark = 1, padded to whole hex digits. The shared encoder must
 * give exactly the same modules, so a ticket looks the same on the web and on the phone.
 */
const REFERENCE: { text: string; level: QrErrorLevel; version: number; rows: string }[] = [
  {
    text: 'HELLO WORLD',
    level: 'M',
    version: 1,
    rows: 'fe8bf8 828a08 ba02e8 baaae8 ba72e8 823a08 feabf8 00f800 b75a58 617f60 07d518 ad9150 8b6c28 00b328 febf80 82e578 ba4a40 bae270 bac920 827788 fed500',
  },
  {
    text: 'YT1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIj',
    level: 'M',
    version: 4,
    rows: 'fe12323f8 82f6c0a08 bafdedae8 baf80cae8 ba7d242e8 8250a6a08 feaaaabf8 00c012000 82db72e70 a59a063f8 fb9924a30 e01309728 560febb08 a8ea9b330 8a5e28190 8953294f8 f2e896d68 0d50ec120 23b9176a8 106678c30 37d792510 b860e7398 bf05cc8f0 b09812d60 d305dcfa8 00b6b98d0 fe4f2aa90 8230898f8 ba042efb8 ba3a89418 ba14d28f8 826da3560 fec4dff30',
  },
  {
    text: 'https://yapilapi.app/events/3f0c',
    level: 'L',
    version: 2,
    rows: 'fed0bf8 827a208 bab72e8 ba862e8 baa12e8 822c208 feaabf8 000a000 f2d3ce8 a8da910 8fda580 0894de0 bac5fb8 0d8fb88 56c20b0 b403388 0b7cff8 009c8a8 fe0aab8 8269890 ba12fc0 ba936e0 ba9deb0 82cc2a0 feae7f8',
  },
  {
    text: 'Café à Lagos, 20:00',
    level: 'Q',
    version: 3,
    rows: 'fe241bf8 827eb208 baa662e8 ba2822e8 bacae2e8 82995a08 feaaabf8 005c0800 4a828da0 b81ab168 3fe9b788 7d1c7e80 62df4e00 d092b0f8 aefbc658 0cefe3d0 569330c0 f0a2dcc0 2b60af28 05826108 ca735f90 009958b8 fe77bab8 823908f8 baad9fe0 ba303a70 ba3f0598 8293e098 fe146290',
  },
  {
    text: 'Ticket for the rooftop concert in Lagos on Saturday night, doors open at 19:00 sharp.',
    level: 'Q',
    version: 7,
    rows: 'fefe31ef4bf8 82716dbbd208 ba8bb8e692e8 ba8c29641ae8 ba190ffffae8 82f948e34208 feaaaaaaabf8 00d978f1f000 57deeff91768 74eeec9090c8 2795fcc06428 05ec83d958c8 ba970abab4f8 a83db35164a8 f74afc749260 30836c5d85c0 7fcbe2b29708 992b5b34d308 3a9aca5899b8 68d453f4a450 1fd79faa2f90 488808b10898 bac45ae5aab8 68e348b948d8 df9a8fe9af98 85682a94b0c8 dbbaf0b535e0 703d7a1d8b10 3b22e1d480c8 c43533041910 46f366809688 89032932ea88 f2f8c0a95218 e0fbd1c95e58 0af57665aec8 795e037e5940 9b71df99af88 00f848e128c8 feed0ab45af0 82ef4889d890 ba266ff69f90 baf78c558d88 ba6810491df8 82acc4058cc0 fe25aa9d4210',
  },
  {
    text: 'A longer line of text that needs version ten at the highest error correction level, so the count takes sixteen bits.',
    level: 'H',
    version: 10,
    rows: 'fe663aa610e73f8 82282e2d19fd208 ba550ed2a03b2e8 ba58eaa1bc612e8 ba8bd07ebf052e8 82582823b3b2208 feaaaaaaaaaabf8 00e8076394f6000 338cf63e8f81e80 558327bcff75d68 4fb6ec3232e2448 19986e14536d418 fa9ea5394257618 e80fcc5cf60c260 3f23103fbef1ec0 9cc2abd579cf5f0 2688f3edb249b78 309d1877a8974b8 4fd63c96e21aa30 e043aa748e84288 6e7ccdd96d86fb0 30dc63041c79d18 2faec63b80efc18 054b327a08d9450 ee8a3e9f6535140 35005654768c680 bfc1103e0b71f80 48c9e5e261ac8f8 faf7ad2aad5aac8 f8a9f1a3894a8f8 5fe556ff1f86fd0 38c6a855caf4988 43cc72f54d80d20 e49fb16ffce1668 4f166a199c6a718 74f981ca946dfd0 56648dbcf656490 188d1cdf0a9df50 a28bd62a5ea4980 813da4a6398d378 ff2f56531719de8 007046021d5fd98 5ae618840c07d30 a14a2841eac4918 2a0087297cb4020 f12b780965e0148 a6274fa7f5ba6b8 f8bf1ecdbb1ffd8 0277fe7f2a34f98 00a17022c519880 fe9cf0abace1ad0 822a73a33fac8b0 ba7a95fea31bff8 babf0d81c6d7c30 ba88f5a8f883920 823e5955b0c5708 fe30fd0edaf62e0',
  },
];

const toHexRows = (modules: boolean[][]) =>
  modules
    .map((row) => {
      const bits = row.map((d) => (d ? '1' : '0')).join('');
      const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0');
      let hex = '';
      for (let i = 0; i < padded.length; i += 4) hex += parseInt(padded.slice(i, i + 4), 2).toString(16);
      return hex;
    })
    .join(' ');

/** The format information around the top-left finder: level bits and mask, after unmasking. */
function readFormat(modules: boolean[][]): { levelBits: number; mask: number } {
  const bits: number[] = [];
  for (let i = 0; i <= 5; i++) bits.push(+modules[i]![8]!);
  bits.push(+modules[7]![8]!, +modules[8]![8]!, +modules[8]![7]!);
  for (let i = 5; i >= 0; i--) bits.push(+modules[8]![i]!);
  // bits[k] is bit k of the 15-bit word (read from least significant).
  const word = bits.reduce((n, b, k) => n | (b << k), 0) ^ 0x5412;
  return { levelBits: word >> 13, mask: (word >> 10) & 7 };
}

describe('QR encoder', () => {
  for (const ref of REFERENCE) {
    it(`matches the web generator for "${ref.text.slice(0, 24)}…" at ${ref.level}`, () => {
      const qr = encodeQr(ref.text, { level: ref.level });
      expect(qr.version).toBe(ref.version);
      expect(qr.size).toBe(ref.version * 4 + 17);
      expect(toHexRows(qr.modules)).toBe(ref.rows);
    });
  }

  it('writes the level and the chosen mask in the format information', () => {
    const qr = encodeQr('YT1.check', { level: 'M' });
    expect(readFormat(qr.modules)).toEqual({ levelBits: 0, mask: qr.mask });
    const forced = encodeQr('YT1.check', { level: 'H', mask: 5 });
    expect(forced.mask).toBe(5);
    expect(readFormat(forced.modules)).toEqual({ levelBits: 2, mask: 5 });
  });

  it('draws the three finders, the timing lines and the dark module', () => {
    const { modules: m, size } = encodeQr('HELLO');
    for (const [r0, c0] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      for (let i = 0; i < 7; i++) {
        expect(m[r0]![c0 + i]).toBe(true);
        expect(m[r0 + 6]![c0 + i]).toBe(true);
        expect(m[r0 + i]![c0]).toBe(true);
      }
      expect(m[r0 + 1]![c0 + 1]).toBe(false);
      expect(m[r0 + 3]![c0 + 3]).toBe(true);
    }
    for (let i = 8; i < size - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[size - 8]![8]).toBe(true);
  });

  it('picks the smallest version that holds the text, and refuses what version 10 cannot hold', () => {
    expect(encodeQr('a'.repeat(14), { level: 'M' }).version).toBe(1);
    expect(encodeQr('a'.repeat(15), { level: 'M' }).version).toBe(2);
    expect(encodeQr('a'.repeat(271), { level: 'L' }).version).toBe(10);
    expect(() => encodeQr('a'.repeat(272), { level: 'L' })).toThrow(RangeError);
  });

  it('encodes text as UTF-8', () => {
    expect(utf8Bytes('A é € 𝄞')).toEqual([0x41, 0x20, 0xc3, 0xa9, 0x20, 0xe2, 0x82, 0xac, 0x20, 0xf0, 0x9d, 0x84, 0x9e]);
  });

  it('turns rows into runs of dark modules', () => {
    expect(
      qrRuns([
        [true, true, false, true],
        [false, false, false, false],
        [false, true, true, true],
      ]),
    ).toEqual([
      [
        [0, 2],
        [3, 1],
      ],
      [],
      [[1, 3]],
    ]);
    const qr = encodeQr('HELLO WORLD');
    const dark = qr.modules.flat().filter(Boolean).length;
    expect(
      qrRuns(qr.modules)
        .flat()
        .reduce((n, [, len]) => n + len, 0),
    ).toBe(dark);
  });
});
