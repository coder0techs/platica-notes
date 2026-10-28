// The Meet code (abc-defg-hij) is the one stable part of a call's url: Google
// moved calls from /<code> to /meet/<code> in October 2026, per account, and
// nothing says the prefix will not move again. So a meeting is identified by the
// code wherever it sits in the path, never by a fixed prefix. Two sessions with
// the same code are the same meeting even if the url shape changed between them.
const CODE = /^\/(?:[a-z0-9_-]+\/)*([a-z]{3}-[a-z]{4}-[a-z]{3})(?=[/?#]|$)/i

/** The Meet code in a pathname, lowercased; null for /lookup/<alias>, landing pages, etc. */
export function meetCodeFromPath(pathname: string): string | null {
  const m = pathname.match(CODE)
  return m ? m[1].toLowerCase() : null
}

/** Meeting identity for comparing two paths: the code when there is one, else the path itself. */
export function meetKey(pathname: string): string {
  return meetCodeFromPath(pathname) ?? pathname
}

/**
 * The meeting's title from what the page shows (`raw`) and its pathname. Meet
 * prefixes document.title with "Meet - " once you have been in the call; for the
 * first seconds it reads just "Meet" or "Google Meet", which names no meeting, so
 * the code stands in (the file name then carries the code once, not "Meet_<code>").
 */
export function meetingTitle(raw: string, pathname: string): string {
  const title = raw.replace(/^Meet - /, "")
  if (title !== "Meet" && title !== "Google Meet") return title
  return meetCodeFromPath(pathname) ?? title
}
