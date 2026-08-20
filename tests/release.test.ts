import { describe, expect, it } from "vitest"
import { bumpLevel, cutChangelog, nextVersion, sectionFor, unreleasedBody } from "../scripts/lib/release-lib.mjs"

const CHANGELOG = `# Release notes

All notable changes to Plática Notes, newest first.

## Unreleased

- **Something visible changed.** Described for a user of the extension, not for
  someone reading the commit log.
- **A second entry.** Also user-facing.

## 1.14.1 - 2026-08-14

- **An older entry.**

## 1.14.0 - 2026-08-10

- **Older still.**
`

describe("bumpLevel", () => {
  it("treats any feat as a minor bump", () => {
    expect(bumpLevel(["fix(a): x", "feat(b): y", "docs: z"], "")).toBe("minor")
  })

  it("treats a bare feat with no scope as a minor bump", () => {
    expect(bumpLevel(["feat: y"], "")).toBe("minor")
  })

  it("falls back to patch when nothing is a feature", () => {
    expect(bumpLevel(["fix: x", "chore: y", "refactor: z"], "")).toBe("patch")
  })

  it("promotes a type! subject to major", () => {
    expect(bumpLevel(["feat(api)!: drop the old shape"], "")).toBe("major")
    expect(bumpLevel(["fix!: change a default"], "")).toBe("major")
  })

  it("promotes a real BREAKING CHANGE footer to major", () => {
    expect(bumpLevel(["fix: x"], "body text\n\nBREAKING CHANGE: the format moved")).toBe("major")
    expect(bumpLevel(["fix: x"], "BREAKING-CHANGE: hyphenated is also a footer")).toBe("major")
  })

  it("ignores the words breaking change in prose", () => {
    // This project's own commit bodies discuss breaking changes; a mention must
    // not silently ship a major version.
    const prose = "This avoids a BREAKING CHANGE for downstream parsers, deliberately."
    expect(bumpLevel(["fix: x"], prose)).toBe("patch")
  })

  it("does not mistake a merge subject for a feature", () => {
    expect(bumpLevel(["Merge pull request #7 from o/feat/thing", "fix: x"], "")).toBe("patch")
  })
})

describe("nextVersion", () => {
  it("bumps each level and zeroes the lower parts", () => {
    expect(nextVersion("1.14.1", "patch")).toBe("1.14.2")
    expect(nextVersion("1.14.1", "minor")).toBe("1.15.0")
    expect(nextVersion("1.14.1", "major")).toBe("2.0.0")
  })

  it("crosses the ten boundary without string sorting nonsense", () => {
    expect(nextVersion("1.9.0", "minor")).toBe("1.10.0")
    expect(nextVersion("1.9.9", "patch")).toBe("1.9.10")
  })

  it("refuses anything that is not a three-part semver", () => {
    expect(() => nextVersion("1.14", "patch")).toThrow(/semver/)
    expect(() => nextVersion("v1.14.1", "patch")).toThrow(/semver/)
    expect(() => nextVersion("1.14.x", "patch")).toThrow(/semver/)
  })
})

describe("unreleasedBody", () => {
  it("returns the entries without the heading", () => {
    const body = unreleasedBody(CHANGELOG)
    expect(body).toContain("**Something visible changed.**")
    expect(body).toContain("**A second entry.**")
    expect(body).not.toContain("## Unreleased")
    expect(body).not.toContain("An older entry")
  })

  it("returns empty when nothing has accumulated", () => {
    expect(unreleasedBody("# T\n\n## Unreleased\n\n## 1.0.0 - 2026-01-01\n\n- old\n")).toBe("")
  })

  it("throws when the heading is missing entirely", () => {
    expect(() => unreleasedBody("# T\n\n## 1.0.0 - 2026-01-01\n")).toThrow(/Unreleased/)
  })
})

describe("cutChangelog", () => {
  const cut = cutChangelog(CHANGELOG, "1.15.0", "2026-08-20")

  it("dates the accumulated entries under the new version", () => {
    expect(cut).toContain("## 1.15.0 - 2026-08-20")
    expect(sectionFor(cut, "1.15.0")).toContain("**Something visible changed.**")
    expect(sectionFor(cut, "1.15.0")).toContain("**A second entry.**")
  })

  it("leaves a fresh empty Unreleased heading on top", () => {
    expect(cut).toContain("## Unreleased")
    expect(unreleasedBody(cut)).toBe("")
    expect(cut.indexOf("## Unreleased")).toBeLessThan(cut.indexOf("## 1.15.0"))
  })

  it("keeps the older sections untouched and in order", () => {
    expect(sectionFor(cut, "1.14.1")).toContain("**An older entry.**")
    expect(sectionFor(cut, "1.14.0")).toContain("**Older still.**")
    expect(cut.indexOf("## 1.15.0")).toBeLessThan(cut.indexOf("## 1.14.1"))
    expect(cut.indexOf("## 1.14.1")).toBeLessThan(cut.indexOf("## 1.14.0"))
  })

  it("preserves the file's own header", () => {
    expect(cut.startsWith("# Release notes\n")).toBe(true)
    expect(cut).toContain("All notable changes")
  })

  it("does not invent or reword entries", () => {
    // The entries are hand-written prose shown to store users; the cut is a move,
    // never a rewrite.
    expect(sectionFor(cut, "1.15.0")).toBe(unreleasedBody(CHANGELOG))
  })

  it("refuses to release with an empty Unreleased section", () => {
    const empty = "# T\n\n## Unreleased\n\n## 1.0.0 - 2026-01-01\n\n- old\n"
    expect(() => cutChangelog(empty, "1.0.1", "2026-08-20")).toThrow(/user-visible notes/)
  })

  it("refuses to write a version that already has a section", () => {
    expect(() => cutChangelog(CHANGELOG, "1.14.1", "2026-08-20")).toThrow(/already has a section/)
  })

  it("is idempotent in shape: cutting twice needs new entries first", () => {
    expect(() => cutChangelog(cut, "1.15.1", "2026-08-21")).toThrow(/user-visible notes/)
  })
})

describe("sectionFor", () => {
  it("returns only the requested version's entries", () => {
    expect(sectionFor(CHANGELOG, "1.14.1")).toBe("- **An older entry.**")
  })

  it("returns the last section when nothing follows it", () => {
    expect(sectionFor(CHANGELOG, "1.14.0")).toBe("- **Older still.**")
  })

  it("does not match a version that is a prefix of another", () => {
    const text = "## 1.1.0 - 2026-01-02\n\n- one one\n\n## 1.1 - nonsense\n"
    expect(sectionFor(text, "1.1.0")).toBe("- one one")
  })

  it("throws for a version with no section", () => {
    expect(() => sectionFor(CHANGELOG, "9.9.9")).toThrow(/no section/)
  })
})
