import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DATA_SAVER_MODES, DATA_SAVER_UPLOAD, dataSaverActive, fitWithin, type DataSaverMode } from '../../../packages/shared/src/data-saver';
import { client } from './api';
import { isDataSaverActive, setDataSaverActive } from './data-saver-state';
import type { Picked } from './media';
import { useSession } from './session';

/**
 * Data saver on the phone.
 *
 * The account's setting (Me.dataSaver) follows the person across devices; this
 * phone can override it (kept on the phone, never sent). Automatic would turn on
 * on mobile data, but telling Wi-Fi from mobile data needs a network module this
 * app doesn't include yet, so on the phone Automatic works like Off (Settings says so).
 */

/** This phone's choice: 'account' follows the account's setting. */
export type DeviceDataSaver = 'account' | DataSaverMode;
const DEVICE_KEY = 'ypl_data_saver_device';

/** Whether the app can tell it is on mobile data. False until a network-info module is added. */
export const CAN_DETECT_CELLULAR = false;

interface DataSaverCtx {
  account: DataSaverMode;
  device: DeviceDataSaver;
  mode: DataSaverMode;
  active: boolean;
  setDevice: (v: DeviceDataSaver) => void;
  setAccount: (v: DataSaverMode) => Promise<void>;
}

const Ctx = createContext<DataSaverCtx>({
  account: 'auto',
  device: 'account',
  mode: 'auto',
  active: false,
  setDevice: () => {},
  setAccount: async () => {},
});
export const useDataSaver = () => useContext(Ctx);

export function DataSaverProvider({ children }: { children: ReactNode }) {
  const { me, refresh } = useSession();
  const [device, setDeviceState] = useState<DeviceDataSaver>('account');
  // The account's setting as last chosen here, until /v1/auth/me catches up.
  const [chosen, setChosen] = useState<DataSaverMode | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync(DEVICE_KEY)
      .then((v) => v && (DATA_SAVER_MODES as readonly string[]).includes(v) && setDeviceState(v as DataSaverMode))
      .catch(() => {});
  }, []);
  useEffect(() => setChosen(null), [me?.dataSaver]);
  const setDevice = useCallback((v: DeviceDataSaver) => {
    setDeviceState(v);
    (v === 'account' ? SecureStore.deleteItemAsync(DEVICE_KEY) : SecureStore.setItemAsync(DEVICE_KEY, v)).catch(() => {});
  }, []);
  const setAccount = useCallback(
    async (v: DataSaverMode) => {
      setChosen(v);
      try {
        await (await client()).me.setDataSaver(v);
        await refresh();
      } catch (e) {
        setChosen(null);
        throw e;
      }
    },
    [refresh],
  );
  const account: DataSaverMode = chosen ?? me?.dataSaver ?? 'auto';
  const mode = device === 'account' ? account : device;
  // No connection hints on the phone yet (see CAN_DETECT_CELLULAR): Automatic stays off.
  const on = dataSaverActive(mode, {});
  // Set during render so requests made by children in this same render already ask for lite responses.
  setDataSaverActive(on);
  return <Ctx.Provider value={{ account, device, mode, active: on, setDevice, setAccount }}>{children}</Ctx.Provider>;
}

// ── Uploads ──────────────────────────────────────────────────────────────
/**
 * On Data saver, photos are made smaller on the phone before they upload: the
 * longest side at most 1600 pixels, JPEG at quality 0.8. GIFs and videos are left alone.
 */
export async function shrinkForUpload(asset: Picked): Promise<Picked> {
  if (!isDataSaverActive() || asset.type !== 'image' || asset.mimeType === 'image/gif') return asset;
  const { width, height } = fitWithin(asset.width || DATA_SAVER_UPLOAD.maxSide, asset.height || DATA_SAVER_UPLOAD.maxSide);
  try {
    let ctx = ImageManipulator.manipulate(asset.uri);
    if (width < (asset.width || 0) || height < (asset.height || 0)) ctx = ctx.resize({ width, height });
    const out = await (await ctx.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: DATA_SAVER_UPLOAD.quality });
    const size = new File(out.uri).size ?? undefined;
    // Keep the original when it is already smaller.
    if (size && asset.fileSize && size >= asset.fileSize) return asset;
    return {
      ...asset,
      uri: out.uri,
      width: out.width,
      height: out.height,
      mimeType: 'image/jpeg',
      fileName: (asset.fileName ?? 'photo').replace(/\.[^.]+$/, '') + '.jpg',
      fileSize: size,
    };
  } catch {
    return asset;
  }
}

// ── Videos waiting for Wi-Fi ──────────────────────────────────────────────
/**
 * Videos the person chose to upload later. The file is copied into the app's
 * documents so it survives the picker's cache being cleared; the list lives in
 * a small JSON file next to it. Nothing uploads by itself: the person chooses
 * Upload now once they are on Wi-Fi.
 */
export interface QueuedVideo {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize: number | null;
  width: number;
  height: number;
  /** Milliseconds, as the picker reports it. */
  duration: number | null;
  queuedAt: string;
}

const queueDir = () => new Directory(Paths.document, 'upload-later');
const queueFile = () => new File(Paths.document, 'upload-later.json');

export async function listQueuedVideos(): Promise<QueuedVideo[]> {
  try {
    const f = queueFile();
    if (!f.exists) return [];
    const items = JSON.parse(await f.text()) as QueuedVideo[];
    // Drop entries whose file is gone.
    return items.filter((q) => new File(q.uri).exists);
  } catch {
    return [];
  }
}

function saveQueue(items: QueuedVideo[]) {
  const f = queueFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(items));
}

export async function queueVideo(asset: Picked): Promise<QueuedVideo> {
  const dir = queueDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const ext = (asset.fileName?.split('.').pop() ?? asset.mimeType?.split('/')[1] ?? 'mp4').toLowerCase();
  const dest = new File(dir, `${id}.${ext}`);
  await new File(asset.uri).copy(dest);
  const item: QueuedVideo = {
    id,
    uri: dest.uri,
    fileName: asset.fileName ?? `video.${ext}`,
    mimeType: asset.mimeType ?? 'video/mp4',
    fileSize: asset.fileSize ?? dest.size ?? null,
    width: asset.width,
    height: asset.height,
    duration: asset.duration ?? null,
    queuedAt: new Date().toISOString(),
  };
  saveQueue([...(await listQueuedVideos()), item]);
  return item;
}

export async function removeQueuedVideo(id: string, o: { keepFile?: boolean } = {}) {
  const items = await listQueuedVideos();
  const gone = items.find((q) => q.id === id);
  if (gone && !o.keepFile) {
    try {
      new File(gone.uri).delete();
    } catch {
      /* already gone */
    }
  }
  saveQueue(items.filter((q) => q.id !== id));
}

/** A queued video as a picked asset, to hand back to the composer. */
export function queuedAsAsset(q: QueuedVideo): Picked {
  return {
    uri: q.uri,
    type: 'video',
    fileName: q.fileName,
    mimeType: q.mimeType,
    fileSize: q.fileSize ?? undefined,
    width: q.width,
    height: q.height,
    duration: q.duration,
    assetId: null,
  } as Picked;
}
