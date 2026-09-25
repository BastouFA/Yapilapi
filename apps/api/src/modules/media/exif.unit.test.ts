import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readJpegOrientation, stripJpegMetadata, stripPngMetadata } from './exif.js';

const gpsJpeg = () =>
  sharp({ create: { width: 20, height: 10, channels: 3, background: 'green' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'SecretCam' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    .toBuffer();

describe('pure-JS JPEG stripping (sharp-less fallback)', () => {
  it('removes EXIF/GPS losslessly and the result still decodes identically', async () => {
    const src = await gpsJpeg();
    expect((await sharp(src).metadata()).exif).toBeDefined();
    expect(src.includes(Buffer.from('SecretCam'))).toBe(true);
    const out = Buffer.from(stripJpegMetadata(src));
    expect(out.includes(Buffer.from('SecretCam'))).toBe(false);
    expect(out.includes(Buffer.from('Exif'))).toBe(false);
    expect((await sharp(out).metadata()).exif).toBeUndefined();
    const a = await sharp(src).raw().toBuffer();
    const b = await sharp(out).raw().toBuffer();
    expect(b.equals(a)).toBe(true); // pixel data untouched
  });

  it('drops data appended after the end-of-image marker', async () => {
    const src = await gpsJpeg();
    const stripped = Buffer.from(
      stripJpegMetadata(Buffer.concat([src, Buffer.from('SECRET-TRAILER-GPS')])),
    );
    expect(stripped.includes(Buffer.from('SECRET-TRAILER'))).toBe(false);
    expect(stripped.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });

  it('keeps a minimal orientation flag so photos do not turn sideways', () => {
    // Hand-built JPEG shell: SOI, APP1 Exif with Orientation=6 (+ GPS marker text), SOS + data, EOI.
    const tiff = Buffer.from([
      0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
    ]);
    const payload = Buffer.concat([
      Buffer.from('Exif\0\0', 'latin1'),
      tiff,
      Buffer.from('GPSDATA'),
    ]);
    const app1 = Buffer.concat([
      Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
      payload,
    ]);
    const sos = Buffer.from([0xff, 0xda, 0, 4, 0, 0, 1, 2, 3, 0xff, 0xd9]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos]);
    expect(readJpegOrientation(jpeg)).toBe(6);
    const out = Buffer.from(stripJpegMetadata(jpeg));
    expect(out.includes(Buffer.from('GPSDATA'))).toBe(false);
    expect(readJpegOrientation(out)).toBe(6);
  });

  it('rejects non-JPEG and corrupt input', () => {
    expect(() => stripJpegMetadata(Buffer.from('not a jpeg'))).toThrow();
    expect(() => stripJpegMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toThrow();
  });
});

describe('pure-JS PNG stripping', () => {
  it('removes text/EXIF chunks and trailing bytes but keeps a decodable image', async () => {
    const base = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    // Inject a tEXt chunk with a fake location before IEND, plus trailing junk.
    const text = Buffer.concat([Buffer.from('Comment\0lat=51.5,lon=-0.1', 'latin1')]);
    const chunk = Buffer.alloc(12 + text.length);
    chunk.writeUInt32BE(text.length, 0);
    chunk.write('tEXt', 4, 'latin1');
    text.copy(chunk, 8); // CRC left zero: we do not validate it
    const iend = base.length - 12;
    const dirty = Buffer.concat([
      base.subarray(0, iend),
      chunk,
      base.subarray(iend),
      Buffer.from('TRAILING-SECRET'),
    ]);
    const clean = Buffer.from(stripPngMetadata(dirty));
    expect(clean.includes(Buffer.from('lat=51.5'))).toBe(false);
    expect(clean.includes(Buffer.from('TRAILING-SECRET'))).toBe(false);
    expect((await sharp(clean).metadata()).width).toBe(8);
  });
});
