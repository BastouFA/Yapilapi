/** Only same-origin relative paths: never redirect a signed-in session to a location the URL supplied. */
export function safeNext(next: string | undefined): string {
  if (
    !next ||
    !next.startsWith('/') ||
    next.startsWith('//') ||
    next.startsWith('/\\') ||
    next.startsWith('/login')
  )
    return '/';
  return next;
}
