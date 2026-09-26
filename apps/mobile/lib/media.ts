import * as ImagePicker from 'expo-image-picker';
import { baseUrl, client, getToken } from './api';
import { tr } from './locale';

/** Reels are up to 3 minutes, as on the web (10 with Plus). */
export const REEL_MAX_SECONDS = 180;
export const PLUS_REEL_MAX_SECONDS = 600;
/** Largest resumable upload (the API's limit; bigger with Plus). */
export const RESUMABLE_MAX_BYTES = 200 * 1024 * 1024;
export const PLUS_RESUMABLE_MAX_BYTES = 500 * 1024 * 1024;
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
export async function pickOne(kinds: ImagePicker.MediaType[], maxSeconds = REEL_MAX_SECONDS): Promise<Picked | 'denied' | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted && perm.accessPrivileges !== 'limited') return 'denied';
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: kinds,
    allowsMultipleSelection: false,
    quality: 0.9,
    videoMaxDuration: kinds.includes('videos') && !kinds.includes('images') ? maxSeconds : undefined,
  });
  if (r.canceled || !r.assets[0]) return null;
  return r.assets[0];
}

/**
 * Take a photo or record a video with the camera. Returns null when the person closed the camera,
 * or 'denied' when camera access is off.
 */
export async function captureOne(maxSeconds = REEL_MAX_SECONDS): Promise<Picked | 'denied' | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return 'denied';
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.9, videoMaxDuration: maxSeconds });
  if (r.canceled || !r.assets[0]) return null;
  return r.assets[0];
}

/**
 * Upload a picked file. Small files go in one request to the same multipart endpoint the web
 * app uses (XMLHttpRequest, so progress shows); large ones (long videos) go in resumable
 * chunks that are retried on a flaky connection, up to the server's resumable limit.
 */
export async function uploadPicked(asset: Picked, onProgress?: (fraction: number) => void): Promise<Uploaded> {
  const video = asset.type === 'video';
  const type = asset.mimeType ?? (video ? 'video/mp4' : 'image/jpeg');
  const name = asset.fileName ?? `upload.${type.split('/')[1] ?? (video ? 'mp4' : 'jpg')}`;
  if ((asset.fileSize ?? 0) > MAX_UPLOAD_BYTES * 0.9) return uploadInChunks(asset.uri, name, type, onProgress);
  return uploadFile(asset.uri, name, type, onProgress);
}

/** A voice message recorded in the app (AAC in an .m4a file). */
export const VOICE_MIME = 'audio/mp4';

/**
 * Upload a file on the phone (a picked photo or video, or a voice recording) in one multipart
 * request to /v1/media, the endpoint the web app uses. XMLHttpRequest, so progress shows.
 */
export async function uploadFile(uri: string, name: string, type: string, onProgress?: (fraction: number) => void): Promise<Uploaded> {
  const form = new FormData();
  form.append('file', { uri, name, type } as unknown as Blob);
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

/** Resumable upload of a large file: the file is read as a Blob and sent slice by slice. */
async function uploadInChunks(uri: string, name: string, type: string, onProgress?: (fraction: number) => void): Promise<Uploaded> {
  const blob = await (await fetch(uri)).blob();
  // The client only needs what a browser File has: name, type, size and slice().
  const file = { name, type, size: blob.size, slice: (start: number, end: number) => blob.slice(start, end) } as unknown as File;
  try {
    const { media } = await (await client()).uploads.resumable(file, onProgress);
    return media;
  } catch (e) {
    throw new Error(e instanceof Error && e.message ? e.message : tr('m.real.uploadFailed'));
  }
}
