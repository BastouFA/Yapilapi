import * as ImagePicker from 'expo-image-picker';
import { baseUrl, getToken } from './api';
import { tr } from './locale';

/** Reels are up to 3 minutes, as on the web. */
export const REEL_MAX_SECONDS = 180;
/** The largest file POST /v1/media accepts (MAX_UPLOAD_BYTES in the API). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type Uploaded = { id: string; kind: 'image' | 'video' | 'audio'; url: string };
export type Picked = ImagePicker.ImagePickerAsset;

/** "1:05" style length, for video durations. */
export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Pick one photo or video from the library. Returns null when the person closed the picker,
 * or 'denied' when photo access is off.
 */
export async function pickOne(kinds: ImagePicker.MediaType[]): Promise<Picked | 'denied' | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted && perm.accessPrivileges !== 'limited') return 'denied';
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: kinds,
    allowsMultipleSelection: false,
    quality: 0.9,
    videoMaxDuration: kinds.includes('videos') && !kinds.includes('images') ? REEL_MAX_SECONDS : undefined,
  });
  if (r.canceled || !r.assets[0]) return null;
  return r.assets[0];
}

/**
 * Upload a picked file with the same multipart endpoint the web app uses. XMLHttpRequest
 * (rather than fetch) so a long video can show its progress.
 */
export async function uploadPicked(asset: Picked, onProgress?: (fraction: number) => void): Promise<Uploaded> {
  const video = asset.type === 'video';
  const type = asset.mimeType ?? (video ? 'video/mp4' : 'image/jpeg');
  const name = asset.fileName ?? `upload.${type.split('/')[1] ?? (video ? 'mp4' : 'jpg')}`;
  const form = new FormData();
  form.append('file', { uri: asset.uri, name, type } as unknown as Blob);
  const token = await getToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/v1/media`);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error(tr('m.real.uploadFailed')));
    xhr.onload = () => {
      let json: { media?: Uploaded; error?: { message?: string } } | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (a proxy error page): the generic message below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.media) resolve(json.media);
      else reject(new Error(json?.error?.message ?? tr('m.real.uploadFailed')));
    };
    xhr.send(form);
  });
}
