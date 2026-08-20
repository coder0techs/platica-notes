// Pure helpers for the release flow, kept separate from the IO so they can be
// unit-tested (see tests/release.test.ts). Nothing here touches the filesystem,
// git, or the clock.

/**
 * Bump level implied by Conventional Commit subjects and bodies.
 *
 * A breaking change must be a real footer (`BREAKING CHANGE:` on its own line)
 * or a `type!:` subject. Merely mentioning the words in prose does not count,
 * which matters because this project's own commit bodies discuss them.
 *
 * @param {string[]} subjects one entry per commit subject line
 * @param {string} bodies all commit bodies concatenated
 * @returns {"major" | "minor" | "patch"}
 */
export function bumpLevel(subjects, bodies) {
  const breaking =
    /^BREAKING[ -]CHANGE:/m.test(bodies) || subjects.some((s) => /^[a-z]+(\(.+?\))?!:/.test(s))
  if (breaking) return "major"
  return subjects.some((s) => /^feat(\(.+?\))?!?:/.test(s)) ? "minor" : "patch"
}

/**
 * @param {string} current a semver `X.Y.Z`
 * @param {"major" | "minor" | "patch"} level
 * @returns {string}
 */
export function nextVersion(current, level) {
  const parts = current.split(".").map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Not a semver version: ${current}`)
  }
  const [maj, min, pat] = parts
  if (level === "major") return `${maj + 1}.0.0`
  if (level === "minor") return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

const UNRELEASED = "## Unreleased"

/**
 * Body of the `## Unreleased` section, without its heading.
 *
 * @param {string} changelog
 * @returns {string}
 */
export function unreleasedBody(changelog) {
  const start = changelog.indexOf(`${UNRELEASED}\n`)
  if (start === -1) throw new Error("CHANGELOG.md has no `## Unreleased` heading.")
  const after = start + UNRELEASED.length
  const next = changelog.indexOf("\n## ", after)
  return (next === -1 ? changelog.slice(after) : changelog.slice(after, next)).trim()
}

/**
 * Turn the accumulated `## Unreleased` entries into a dated release section and
 * leave a fresh, empty `## Unreleased` above it for the next change.
 *
 * The entries themselves are never generated or reworded: they are written by
 * hand, per change, in the pull request that makes the change. A changelog
 * generated from commit subjects would read like a commit log, and this one is
 * shown to Chrome Web Store users.
 *
 * @param {string} changelog current CHANGELOG.md contents
 * @param {string} version the version being released, `X.Y.Z`
 * @param {string} date ISO date, `YYYY-MM-DD`
 * @returns {string} the rewritten CHANGELOG.md contents
 */
export function cutChangelog(changelog, version, date) {
  const body = unreleasedBody(changelog)
  if (body === "") {
    throw new Error(
      "The `## Unreleased` section is empty — a release needs user-visible notes. " +
        "Describe the change there first.",
    )
  }
  if (new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`)
  }

  const start = changelog.indexOf(`${UNRELEASED}\n`)
  const after = start + UNRELEASED.length
  const next = changelog.indexOf("\n## ", after)
  const tail = next === -1 ? "" : changelog.slice(next + 1)

  return (
    changelog.slice(0, start) +
    `${UNRELEASED}\n\n## ${version} - ${date}\n\n${body}\n` +
    (tail ? `\n${tail}` : "")
  )
}

/**
 * Body of a released section, for use as GitHub release notes.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function sectionFor(changelog, version) {
  const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b.*$`, "m")
  const match = heading.exec(changelog)
  if (!match) throw new Error(`CHANGELOG.md has no section for ${version}.`)
  const after = match.index + match[0].length
  const next = changelog.indexOf("\n## ", after)
  return (next === -1 ? changelog.slice(after) : changelog.slice(after, next)).trim()
}
