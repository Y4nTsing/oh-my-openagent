declare const require: (name: string) => any
const { describe, test, expect, beforeEach, afterEach } = require("bun:test")
import { __setTimingConfig, __resetTimingConfig } from "./timing"

function createMockCtx(aborted = false) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    sessionID: "parent-session",
    messageID: "parent-message",
    agent: "test-agent",
    abort: controller.signal,
  }
}

function createStalledClient(
  sessionID: string,
  lastFinish: string | undefined,
  parts: Array<{ type: string; text?: string }> = []
) {
  return {
    session: {
      abort: async () => {},
      messages: async () => ({
        data: [
          { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
          { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: lastFinish }, parts },
        ],
      }),
      status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
    },
  }
}

async function withMockedDateNow(stepMs: number, run: () => Promise<void>) {
  const originalDateNow = Date.now
  let now = 0

  Date.now = () => {
    const current = now
    now += stepMs
    return current
  }

  try {
    await run()
  } finally {
    Date.now = originalDateNow
  }
}

describe("sync session poll stall detection", () => {
  beforeEach(() => {
    __setTimingConfig({
      POLL_INTERVAL_MS: 10,
      MIN_STABILITY_TIME_MS: 0,
      STABILITY_POLLS_REQUIRED: 1,
      MAX_POLL_TIME_MS: 600_000,
    })
  })

  afterEach(() => {
    __resetTimingConfig()
  })

  describe("#given an inactive session whose last assistant message has finish=unknown", () => {
    describe("#when no new messages arrive and no deliverable exists", () => {
      test("#then poll fails fast with a stall error instead of waiting for the inactivity timeout", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        let abortCount = 0
        const client = createStalledClient("ses_stall_no_deliverable", "unknown", [])
        client.session.abort = async () => {
          abortCount++
        }

        await withMockedDateNow(60_000, async () => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_stall_no_deliverable",
            agentToUse: "oracle",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
          })

          expect(result).toContain("Subagent stalled")
          expect(result).toContain("finish=\"unknown\"")
          expect(abortCount).toBe(1)
        })
      })
    })

    describe("#when the stalled session still contains a substantive deliverable", () => {
      test("#then poll treats the session as complete and returns the result", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_stall_deliverable", "unknown", [
          { type: "text", text: "final report" },
        ])

        await withMockedDateNow(60_000, async () => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_stall_deliverable",
            agentToUse: "oracle",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
          })

          expect(result).toBeNull()
        })
      })
    })

    describe("#when the last assistant message has finish=tool-calls", () => {
      test("#then stall detection does NOT fire and the normal inactivity timeout still applies", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_toolcalls", "tool-calls", [])

        await withMockedDateNow(60_000, async () => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_toolcalls",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
          }, 120_000)

          expect(result).toContain("Poll inactivity timeout reached")
          expect(result).not.toContain("Subagent stalled")
        })
      })
    })

    describe("#when the last assistant message has no finish field at all", () => {
      test("#then stall detection does NOT fire (undefined finish can be a transient mid-generation state)", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_no_finish", undefined, [])

        await withMockedDateNow(60_000, async () => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_no_finish",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
          }, 120_000)

          expect(result).toContain("Poll inactivity timeout reached")
          expect(result).not.toContain("Subagent stalled")
        })
      })
    })

    describe("#when new messages arrive during the stall window", () => {
      test("#then the stall timer resets and poll keeps waiting", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        let messageCallCount = 0
        const client = createStalledClient("ses_reset", "unknown", [])
        client.session.messages = async () => {
          messageCallCount++
          const extra =
            messageCallCount > 2
              ? [{ info: { id: "msg_003", role: "assistant", time: { created: 3000 }, finish: "stop" }, parts: [{ type: "text", text: "recovered" }] }]
              : []
          return {
            data: [
              { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
              { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" }, parts: [] },
              ...extra,
            ],
          }
        }

        await withMockedDateNow(60_000, async () => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_reset",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
          })

          expect(result).toBeNull()
        })
      })
    })
  })
})
