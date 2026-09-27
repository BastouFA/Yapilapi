import { router } from 'expo-router';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { splitRichText } from '../../../packages/shared/src/hashtags';
import { useColors, userText } from './ui';

/** Text with #tags and @mentions that open the tag or the person's profile. */
export function RichText({
  text,
  style,
  numberOfLines,
  linkStyle,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Overrides the link look (Reels show white links over the video). */
  linkStyle?: StyleProp<TextStyle>;
}) {
  const c = useColors();
  return (
    <Text style={[style, userText]} numberOfLines={numberOfLines}>
      {splitRichText(text).map((part, i) =>
        'tag' in part || 'mention' in part ? (
          <Text
            key={i}
            accessibilityRole="link"
            suppressHighlighting={false}
            onPress={() => router.push('tag' in part ? `/t/${encodeURIComponent(part.tag)}` : `/u/${part.mention}`)}
            style={[{ color: c.yapi, fontWeight: '600' }, linkStyle]}
          >
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}
