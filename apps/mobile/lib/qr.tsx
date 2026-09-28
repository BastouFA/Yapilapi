import { useMemo } from 'react';
import { View } from 'react-native';
import { encodeQr, qrRuns } from '../../../packages/shared/src/qr';

/**
 * A QR code drawn with plain views, from the shared encoder (the same modules the web draws for the
 * same text). Always dark on white with a quiet zone, whatever the theme, so cameras at the door can
 * read it. The whole code is one image for screen readers, described by `label`.
 */
export function QrView({ value, size = 224, label }: { value: string; size?: number; label: string }) {
  const code = useMemo(() => {
    const qr = encodeQr(value, { level: 'M' });
    return { count: qr.size, runs: qrRuns(qr.modules) };
  }, [value]);
  const quiet = 4;
  // Whole pixels per module keep the edges sharp.
  const module = Math.max(2, Math.floor(size / (code.count + quiet * 2)));
  const side = module * (code.count + quiet * 2);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      // Left to right even in Arabic: a mirrored code wouldn't scan.
      style={{ width: side, height: side, backgroundColor: '#FFFFFF', padding: module * quiet, borderRadius: 8, direction: 'ltr' }}
    >
      {code.runs.map((row, r) => (
        <View key={r} style={{ height: module, flexDirection: 'row', direction: 'ltr' }}>
          {row.map(([start, length], i) => (
            <View key={i} style={{ position: 'absolute', left: start * module, width: length * module, height: module, backgroundColor: '#0E1020' }} />
          ))}
        </View>
      ))}
    </View>
  );
}
