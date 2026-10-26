import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Whether the person asked for less motion (Reduce Motion, Remove animations): then nothing slides or springs. */
export function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

/** Whether VoiceOver or TalkBack is on. */
export function useScreenReader() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setOn);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => sub.remove();
  }, []);
  return on;
}

/**
 * An interpolation's points that follow `easing` between each pair of the given points. Animations on
 * the native driver ignore an interpolation's `easing` (they go straight from point to point), so
 * the curve is drawn with a few more points instead. `unit` turns the outputs into strings ('deg').
 */
export function curve(input: number[], output: number[], easing: (t: number) => number, unit?: string, steps = 6) {
  const inputRange = [input[0]!];
  const values = [output[0]!];
  for (let i = 1; i < input.length; i++)
    for (let k = 1; k <= steps; k++) {
      inputRange.push(input[i - 1]! + ((input[i]! - input[i - 1]!) * k) / steps);
      values.push(output[i - 1]! + (output[i]! - output[i - 1]!) * easing(k / steps));
    }
  return unit ? { inputRange, outputRange: values.map((v) => `${v}${unit}`) } : { inputRange, outputRange: values };
}
