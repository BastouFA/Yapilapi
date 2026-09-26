import { router } from 'expo-router';
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import { tr } from './locale';
import { captureOne, pickOne, type Picked } from './media';

export type CreateMode = 'post' | 'reel' | 'story';
type Pending = { asset: Picked | 'denied-camera' | 'denied-library'; mode: CreateMode };

let pending: Pending | null = null;
const listeners = new Set<() => void>();

/** What was just taken or picked from "+", once. */
export function takePendingAsset(): Pending | null {
  const p = pending;
  pending = null;
  return p;
}

/** Call `fn` whenever something is taken or picked from "+" (Create may already be open). */
export function onPendingAsset(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function deliver(p: Pending) {
  pending = p;
  listeners.forEach((l) => l());
}

/**
 * The "+" button: ask whether to use the camera, the library or just write, open Create, and go
 * straight to the camera or the library. What comes back is handed to Create, which opens the editor.
 */
export function openCreateSheet(mode: CreateMode = 'post', maxSeconds?: number) {
  const go = () => router.navigate({ pathname: '/create', params: mode === 'post' ? {} : { mode } });
  const camera = async () => {
    go();
    const a = await captureOne(maxSeconds).catch(() => null);
    if (a) deliver({ asset: a === 'denied' ? 'denied-camera' : a, mode });
  };
  const library = async () => {
    go();
    const a = await pickOne(['images', 'videos'], maxSeconds).catch(() => null);
    if (a) deliver({ asset: a === 'denied' ? 'denied-library' : a, mode });
  };
  const options = [tr('m.create.camera'), tr('m.create.library'), tr('m.create.textOnly'), tr('m.create.cancel')];
  if (Platform.OS === 'ios')
    ActionSheetIOS.showActionSheetWithOptions({ title: tr('m.create.sheetTitle'), options, cancelButtonIndex: 3 }, (i) => {
      if (i === 0) void camera();
      else if (i === 1) void library();
      else if (i === 2) go();
    });
  else
    Alert.alert(
      tr('m.create.sheetTitle'),
      undefined,
      [
        { text: options[0]!, onPress: () => void camera() },
        { text: options[1]!, onPress: () => void library() },
        { text: options[2]!, onPress: go },
      ],
      { cancelable: true },
    );
}
