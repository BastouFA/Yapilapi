import { describe, expect, it } from 'vitest';
import { sniffMedia } from './sniff.js';

const b = (...bytes: number[]) =>
  Buffer.from([...bytes, ...new Array(Math.max(0, 32 - bytes.length)).fill(0)]);
const ascii = (s: string, at = 0, total = 32) => {
  const x = Buffer.alloc(total);
  x.write(s, at, 'latin1');
  return x;
};
function ftyp(major: string, compat: string[] = []) {
  const size = 16 + compat.length * 4;
  const x = Buffer.alloc(Math.max(size, 32));
  x.writeUInt32BE(size, 0);
  x.write('ftyp', 4, 'latin1');
  x.write(major, 8, 'latin1');
  compat.forEach((c, i) => x.write(c, 16 + i * 4, 'latin1'));
  return x;
}

describe('sniffMedia', () => {
  it('recognises allowlisted images by magic bytes', () => {
    expect(sniffMedia(b(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({
      kind: 'image',
      mime: 'image/jpeg',
    });
    expect(sniffMedia(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toMatchObject({
      kind: 'image',
      mime: 'image/png',
    });
    expect(sniffMedia(ascii('GIF89a'))).toMatchObject({ mime: 'image/gif' });
    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    expect(sniffMedia(webp)).toMatchObject({ kind: 'image', mime: 'image/webp' });
    expect(sniffMedia(ftyp('avif', ['mif1']))).toMatchObject({ kind: 'image', mime: 'image/avif' });
    expect(sniffMedia(ftyp('mif1', ['avif']))).toMatchObject({ kind: 'image', mime: 'image/avif' });
  });

  it('recognises video, audio and pdf', () => {
    expect(sniffMedia(ftyp('isom', ['mp42']))).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(sniffMedia(ftyp('qt  '))).toMatchObject({ kind: 'video', mime: 'video/quicktime' });
    expect(sniffMedia(ftyp('M4A ', ['mp42']))).toMatchObject({ kind: 'audio', mime: 'audio/mp4' });
    const webm = Buffer.alloc(64);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
    webm.write('webm', 20, 'latin1');
    expect(sniffMedia(webm)).toMatchObject({ kind: 'video', mime: 'video/webm' });
    const mkv = Buffer.alloc(64);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(mkv);
    mkv.write('matroska', 20, 'latin1');
    expect(sniffMedia(mkv)).toBeNull();
    expect(sniffMedia(ascii('OggS'))).toMatchObject({ kind: 'audio', mime: 'audio/ogg' });
    expect(sniffMedia(ascii('OggStheora'.padEnd(12, ' ')))).toBeNull();
    expect(sniffMedia(ascii('ID3\x04'))).toMatchObject({ kind: 'audio', mime: 'audio/mpeg' });
    expect(sniffMedia(b(0xff, 0xfb, 0x90, 0x00))).toMatchObject({
      kind: 'audio',
      mime: 'audio/mpeg',
    });
    const wav = Buffer.alloc(32);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    expect(sniffMedia(wav)).toMatchObject({ kind: 'audio', mime: 'audio/wav' });
    expect(sniffMedia(ascii('%PDF-1.7\n'))).toMatchObject({
      kind: 'file',
      mime: 'application/pdf',
    });
  });

  it('rejects everything else, whatever it claims to be', () => {
    expect(sniffMedia(ascii('MZ\x90\x00\x03'))).toBeNull(); // Windows executable
    expect(sniffMedia(ascii('\x7fELF'))).toBeNull();
    expect(sniffMedia(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull(); // SVG can carry script
    expect(sniffMedia(ascii('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffMedia(ascii('#!/bin/sh\nrm -rf /\n'))).toBeNull();
    expect(sniffMedia(ftyp('heic', ['mif1']))).toBeNull(); // HEIC is not allowlisted
    expect(sniffMedia(b(0xff, 0xf1, 0x50, 0x80))).toBeNull(); // raw ADTS AAC
    expect(sniffMedia(Buffer.alloc(4))).toBeNull(); // too short
    expect(sniffMedia(Buffer.alloc(64))).toBeNull();
    const riffOther = Buffer.alloc(32);
    riffOther.write('RIFF', 0);
    riffOther.write('AVI ', 8);
    expect(sniffMedia(riffOther)).toBeNull();
  });
});
