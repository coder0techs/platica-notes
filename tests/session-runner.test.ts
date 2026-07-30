// @vitest-environment jsdom
//
// The session runner against the in-memory chrome fake and a fake platform. This is
// what the runMeeting extraction bought: the whole session lifecycle — resume,
// capture, presence, finalize — is now reachable without a browser or Google Meet.
//
// jsdom is needed only because the runner mounts the real pills and panel; the
// assertions are all about the persisted session, never the markup.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeChromeMock, type ChromeMock } from "./helpers/chrome-mock"
import { runSession } from "../src/content/core/session-runner"
import type { RunnerDeps } from "../src/content/core/session-runner"
import type { CaptureEvent } from "../src/content/capture/protocol"
import type { ActiveSession } from "../src/shared/types"
import type { Capabilities, PlatformAdapter } from "../src/content/platforms/adapter"

const TAB = 7
const KEY = `session_${TAB}`

interface Fake {
  adapter: PlatformAdapter
  emit: (event: CaptureEvent) => void
  end: (reason?: string) => void
  endCalls: () => number
}

function fakeAdapter(capabilities: Partial<Capabilities> = {}): Fake {
  let emit: (event: CaptureEvent) => void = () => {}
  let end: (reason: string) => void = () => {}
  let endCalls = 0
  const adapter: PlatformAdapter = {
    id: "zoom",
    capabilities: {
      chat: true,
      languageSwitch: "none",
      rawVersions: true,
      participantEvents: true,
      livenessEnd: false,
      ...capabilities,
    },
    captionRules: { interruptionGapMs: null, speakerLabel: (id) => `Speaker ${id}`, selfChatDedupMs: null },
    timings: { captionFlushMs: 0, joinSettleMs: 10_000 },
    isMeetingPage: () => true,
    meetingKey: () => "999",
    waitForJoin: async () => true,
    watchEnd: (onEnd) => {
      end = onEnd
      return () => {}
    },
    readTitle: () => "Fixture meeting",
    meetingUrl: (key) => `https://example.zoom.us/wc/${key}/join`,
    subscribe: (on) => {
      emit = on
      return () => {
        emit = () => {}
      }
    },
  }
  return {
    adapter,
    emit: (event) => emit(event),
    end: (reason = "test") => {
      endCalls++
      end(reason)
    },
    endCalls: () => endCalls,
  }
}

let chromeMock: ChromeMock
let sent: string[]

function deps(adapter: PlatformAdapter, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  let selfName: string | null = null
  return {
    tabId: TAB,
    adapter,
    roster: new Map(),
    getSelfName: () => selfName,
    setSelfName: (name) => {
      selfName = name
    },
    debug: { enabled: () => false, events: () => [], onEvent: () => {}, log: () => {} },
    bindNoteSink: () => {},
    onContextInvalidated: () => {},
    noteIfInvalidated: () => {},
    ...overrides,
  }
}

const stored = (): ActiveSession | undefined => chromeMock._store[KEY] as ActiveSession | undefined

const utterance = (speakerId: string, id: string, revision: number, text: string): CaptureEvent => ({
  type: "utterance",
  speakerId,
  utteranceId: id,
  revision,
  text,
})

beforeEach(() => {
  chromeMock = makeChromeMock()
  sent = []
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    ...chromeMock,
    runtime: {
      sendMessage: async (request: { kind: string }) => {
        sent.push(request.kind)
        return { ok: true, data: undefined }
      },
    },
    storage: { ...chromeMock.storage, onChanged: { addListener: () => {} } },
  }
})

afterEach(() => {
  document.body.innerHTML = ""
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})

describe("runSession", () => {
  it("persists transcript and chat under the tab's session key", async () => {
    const fake = fakeAdapter()
    const run = runSession(deps(fake.adapter))
    await new Promise((r) => setTimeout(r, 0))

    fake.emit({ type: "roster", speakerId: "u1", name: "Grace Hopper" })
    fake.emit(utterance("u1", "m1", 1, "the compiler"))
    fake.emit(utterance("u1", "m1", 2, "the compiler works"))
    fake.emit(utterance("u2", "m2", 1, "ship it"))
    fake.emit({ type: "chat", speakerId: "u1", text: "link in the notes", sender: "Grace Hopper" })
    fake.end()
    await run

    const session = stored()
    expect(session).toBeDefined()
    expect(session!.transcript.map((u) => u.text)).toEqual(["the compiler works", "ship it"])
    expect(session!.chat.map((c) => c.text)).toEqual(["link in the notes"])
    // The roster event resolved the speaker; the unknown one fell back to the rule.
    expect(session!.transcript.map((u) => u.speaker)).toEqual(["Grace Hopper", "Speaker u2"])
  })

  it("stamps the platform id and the adapter's title", async () => {
    const fake = fakeAdapter()
    const run = runSession(deps(fake.adapter))
    await new Promise((r) => setTimeout(r, 0))
    fake.emit(utterance("u1", "m1", 1, "hello"))
    fake.end()
    await run

    expect(stored()!.platform).toBe("zoom")
    expect(stored()!.title).toBe("Fixture meeting")
    expect(stored()!.path).toBe("999")
  })

  it("finalizes once even if the platform reports the end twice", async () => {
    const fake = fakeAdapter()
    const run = runSession(deps(fake.adapter))
    await new Promise((r) => setTimeout(r, 0))
    fake.emit(utterance("u1", "m1", 1, "hello"))
    fake.end("first")
    fake.end("second")
    await run

    expect(sent.filter((kind) => kind === "meetingEnded")).toHaveLength(1)
    expect(sent).toContain("meetingStarted")
  })

  it("drops chat when the platform declares it cannot capture it", async () => {
    const fake = fakeAdapter({ chat: false })
    const run = runSession(deps(fake.adapter))
    await new Promise((r) => setTimeout(r, 0))
    fake.emit(utterance("u1", "m1", 1, "spoken"))
    fake.emit({ type: "chat", speakerId: "u1", text: "typed", sender: "Grace Hopper" })
    fake.end()
    await run

    expect(stored()!.transcript).toHaveLength(1)
    expect(stored()!.chat).toEqual([])
  })

  it("resumes a stored session for the same meeting instead of erasing it", async () => {
    const previous: ActiveSession = {
      platform: "zoom",
      path: "999",
      title: "Fixture meeting",
      startedAt: "2026-07-30T08:00:00.000Z",
      isPrivate: false,
      transcript: [{ speaker: "Ada Lovelace", startedAt: "2026-07-30T08:00:05.000Z", text: "said earlier" }],
      chat: [],
      participants: ["Ada Lovelace"],
    }
    await chromeMock.storage.local.set({ [KEY]: previous })

    const fake = fakeAdapter()
    const run = runSession(deps(fake.adapter))
    await new Promise((r) => setTimeout(r, 0))
    fake.emit(utterance("u1", "m1", 1, "said after the reload"))
    fake.end()
    await run

    const session = stored()!
    expect(session.startedAt).toBe(previous.startedAt)
    expect(session.transcript.map((u) => u.text)).toEqual(["said earlier", "said after the reload"])
    expect(session.participants).toContain("Ada Lovelace")
    // A same-meeting resume must NOT finalize the stored session first.
    expect(sent.filter((kind) => kind === "meetingEnded")).toHaveLength(1)
  })

  it("finalizes a stored session that belongs to a DIFFERENT meeting before writing", async () => {
    const stale: ActiveSession = {
      platform: "zoom",
      path: "111",
      title: "Earlier call",
      startedAt: "2026-07-30T07:00:00.000Z",
      isPrivate: false,
      transcript: [],
      chat: [],
      participants: [],
    }
    await chromeMock.storage.local.set({ [KEY]: stale })

    const fake = fakeAdapter()
    const run = runSession(deps(fake.adapter))
    await new Promise((r) => setTimeout(r, 0))
    fake.emit(utterance("u1", "m1", 1, "fresh call"))
    fake.end()
    await run

    // Two finalizes: the stale one before the join, then this meeting's own.
    expect(sent.filter((kind) => kind === "meetingEnded")).toHaveLength(2)
    expect(stored()!.title).toBe("Fixture meeting")
    expect(stored()!.transcript.map((u) => u.text)).toEqual(["fresh call"])
  })

  it("marks a mid-meeting arrival as a join once the settle window has passed", async () => {
    const fake = fakeAdapter()
    const roster = new Map<string, string>()
    const run = runSession(deps(fake.adapter, { roster, adapter: { ...fake.adapter, timings: { captionFlushMs: 0, joinSettleMs: 0 } } }))
    await new Promise((r) => setTimeout(r, 0))
    roster.set("u9", "Katherine Johnson")
    fake.emit({ type: "roster", speakerId: "u9", name: "Katherine Johnson" })
    fake.emit(utterance("u9", "m1", 1, "sorry I am late"))
    fake.end()
    await run

    expect(stored()!.participantEvents).toEqual([
      expect.objectContaining({ name: "Katherine Johnson", kind: "join" }),
    ])
  })
})
