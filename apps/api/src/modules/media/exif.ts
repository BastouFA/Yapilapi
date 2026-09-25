/**
 * Pure-JS JPEG/PNG metadata stripping. This is the FALLBACK used when `sharp` cannot be loaded; when sharp is
 * available, images are re-encoded (which drops all metadata). Both paths remove GPS and every other EXIF/XMP/IPTC
 * datum. The EXIF orientation flag is preserved (rewritten as a minimal EXIF block) so photos do not turn sideways.
 */

/** Read the EXIF Orientation (1-8) from a JPEG, or null. */
export function readJpegOrientation(buf: Uint8Array): number | null {
  const seg = findExifSegment(buf);
  return seg ? orientationFromExif(seg) : null;
}

function findExifSegment(buf: Uint8Array): Uint8Array | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2) return null;
    if (marker === 0xe1 && String.fromCharCode(...buf.subarray(i + 4, i + 10)) === 'Exif\0\0')
      return buf.subarray(i + 10, i + 2 + len);
    i += 2 + len;
  }
  return null;
}

function orientationFromExif(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const u16 = (o: number) =>
    o + 2 <= tiff.length
      ? le
        ? tiff[o]! | (tiff[o + 1]! << 8)
        : (tiff[o]! << 8) | tiff[o + 1]!
      : 0;
  const u32 = (o: number) =>
    le ? (u16(o) | (u16(o + 2) << 16)) >>> 0 : ((u16(o) << 16) | u16(o + 2)) >>> 0;
  const ifd = u32(4);
  const n = u16(ifd);
  for (let k = 0; k < Math.min(n, 64); k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** Minimal big-endian EXIF APP1 segment holding only Orientation. */
function orientationSegment(o: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0,
    0,
    0,
    8,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0,
    0,
    0,
    1,
    0x00,
    o,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const payload = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
}

/** JPEG segments worth keeping: JFIF (APP0), ICC profile (APP2) and Adobe colour transform (APP14). */
function keepSegment(marker: number, buf: Uint8Array, at: number): boolean {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2)
    return String.fromCharCode(...buf.subarray(at + 4, at + 15)) === 'ICC_PROFILE';
  return !(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe; // every other APPn and COM is dropped
}

/**
 * Remove EXIF/XMP/IPTC/comment segments from a JPEG, keeping orientation as a minimal EXIF block, and truncate any
 * data after the end-of-image marker (thumbnails / multi-picture payloads / "aCropalypse" leftovers). Segments are
 * removed losslessly: the entropy-coded image data is not touched.
 */
export function stripJpegMetadata(buf: Uint8Array): Uint8Array {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const orientation = readJpegOrientation(buf);
  const out: Uint8Array[] = [buf.subarray(0, 2)];
  if (orientation && orientation !== 1) out.push(orientationSegment(orientation));
  let i = 2;
  while (i + 2 <= buf.length) {
    if (buf[i] !== 0xff) throw new Error('corrupt JPEG');
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) {
      out.push(buf.subarray(i, i + 2));
      return concat(out);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) throw new Error('corrupt JPEG');
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2 || i + 2 + len > buf.length) throw new Error('corrupt JPEG');
    let next = i + 2 + len;
    if (keepSegment(marker, buf, i)) out.push(buf.subarray(i, next));
    if (marker === 0xda) {
      // Entropy-coded scan data: runs until the next real marker (not 00 stuffing, not RSTn, not 0xFF fill).
      let j = next;
      while (j + 1 < buf.length) {
        if (
          buf[j] === 0xff &&
          buf[j + 1] !== 0x00 &&
          !(buf[j + 1]! >= 0xd0 && buf[j + 1]! <= 0xd7) &&
          buf[j + 1] !== 0xff
        )
          break;
        j++;
      }
      if (j + 1 >= buf.length) throw new Error('corrupt JPEG');
      out.push(buf.subarray(next, j));
      next = j;
    }
    i = next;
  }
  throw new Error('corrupt JPEG: missing end of image');
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
/** Remove textual/EXIF ancillary chunks from a PNG (lossless). */
export function stripPngMetadata(buf: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = ((buf[i]! << 24) | (buf[i + 1]! << 16) | (buf[i + 2]! << 8) | buf[i + 3]!) >>> 0;
    const type = String.fromCharCode(buf[i + 4]!, buf[i + 5]!, buf[i + 6]!, buf[i + 7]!);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error('corrupt PNG');
    if (!PNG_DROP.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return concat(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    res.set(p, o);
    o += p.length;
  }
  return res;
}
