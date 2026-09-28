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
