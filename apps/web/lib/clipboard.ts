/**
 * Copies text, and says whether it worked. The browser can refuse (no permission, the page not in
 * focus, or no clipboard at all outside HTTPS); callers then tell the person to copy it themselves
 * instead of failing silently with an unhandled rejection.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies a picture, and says whether it worked. Clipboards take PNG, so it's redrawn as one. The
 * picture is handed over as a promise, inside the tap, which is what phones ask for.
 */
export async function copyImage(url: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    const png = (async () => {
      const bitmap = await createImageBitmap(await (await fetch(url, { credentials: 'include' })).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no picture'))), 'image/png'));
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}

const isMedia = (f: File) => f.type.startsWith('image/') || f.type.startsWith('video/') || /\.(heic|heif)$/i.test(f.name);

/**
 * Which of what was copied goes in a chat as a photo or video. Words with a picture of them (a
 * spreadsheet, a document) stay words; a picture copied from a page often brings its link, which
 * doesn't count.
 */
export function mediaToSend(files: File[], text: string): File[] {
  const media = files.filter(isMedia);
  return media.length && !/\s/.test(text.trim()) ? media : [];
}

/**
 * What's on the clipboard, for a Paste button: phones only offer Paste in a message box for words,
 * so a copied photo has to come this way. The phone may ask first, inside the tap. Null when the
 * browser can't or you said no.
 */
export async function readClipboard(): Promise<{ files: File[]; text: string } | null> {
  try {
    if (!navigator.clipboard?.read) return { files: [], text: await navigator.clipboard.readText() };
    const files: File[] = [];
    let text = '';
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        if (type === 'text/plain') text = await (await item.getType(type)).text();
        else if (type.startsWith('image/') || type.startsWith('video/')) {
          files.push(new File([await item.getType(type)], `pasted.${type.split('/')[1]}`, { type }));
          break;
        }
      }
    }
    return { files, text };
  } catch {
    return null;
  }
}
