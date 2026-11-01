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
