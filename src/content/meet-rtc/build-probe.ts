// Meet stamps its server build tag into window.WIZ_global_data as a
// "boq_meetingsuiserver_<date>.<rev>" token. Capturing it lets a capture failure
// be attributed to a specific Meet release — the wire protocol and DOM contract
// can change silently between builds, and the tag is the only stable breadcrumb
// tying a broken capture to the version that broke it.
//
// Pure (no window/DOM) so it can be unit-tested off a sample object.

const BUILD_RE = /boq_meetingsuiserver_[\w.]+/

// Walk an arbitrary object graph (Meet's WIZ_global_data) for the first value
// containing the build token. The holding key ("cfb2h" on today's builds) is not
// stable across releases, so we match by content, not by key. Bounded node count
// and a visited set keep a huge or cyclic graph from hanging the page.
export function extractMeetBuild(wiz: unknown): string | null {
  if (!wiz || typeof wiz !== "object") return null
  const seen = new Set<unknown>()
  const stack: unknown[] = [wiz]
  let budget = 5000
  while (stack.length && budget-- > 0) {
    const cur = stack.pop()
    if (typeof cur === "string") {
      const m = cur.match(BUILD_RE)
      if (m) return m[0]
      continue
    }
    if (cur && typeof cur === "object" && !seen.has(cur)) {
      seen.add(cur)
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v)
    }
  }
  return null
}
