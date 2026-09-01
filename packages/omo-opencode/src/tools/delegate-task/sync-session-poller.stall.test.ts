declare const require: (name: string) => any
const { describe, test, expect } = require("bun:test")

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

type TestClock = {
  readonly now: () => number
  readonly wait: (milliseconds: number) => Promise<void>
}

async function withAdvancingClock(stepMs: number, run: (clock: TestClock) => Promise<void>) {
  let currentTime = 0
  const now = () => {
    const current = currentTime
    currentTime += stepMs
    return current
  }
  await run({ now, wait: async () => {} })
}

describe.serial("sync session poll stall detection", () => {
  describe("#given an inactive session whose last assistant message has finish=unknown", () => {
    describe("#when no new messages arrive and no deliverable exists", () => {
      test("#then poll fails fast with a stall error instead of waiting for the inactivity timeout", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        let abortCount = 0
        const client = createStalledClient("ses_stall_no_deliverable", "unknown", [])
        client.session.abort = async () => {
          abortCount++
        }

        await withAdvancingClock(60_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_stall_no_deliverable",
            agentToUse: "oracle",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            ...clock,
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

        await withAdvancingClock(60_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_stall_deliverable",
            agentToUse: "oracle",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            ...clock,
          })

          expect(result).toBeNull()
        })
      })

      test("#then an earlier deliverable from the same user turn survives a later empty retry", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_same_turn_deliverable", "unknown", [])
        client.session.messages = async () => ({
          data: [
            { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" }, parts: [{ type: "text", text: "final report" }] },
            { info: { id: "msg_003", role: "assistant", time: { created: 3000 }, finish: "unknown" }, parts: [] },
          ],
        })

        await withAdvancingClock(60_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_same_turn_deliverable",
            agentToUse: "oracle",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            ...clock,
          })

          expect(result).toBeNull()
        })
      })
    })

    describe("#when the last assistant message has finish=tool-calls", () => {
      test("#then stall detection does NOT fire and the normal inactivity timeout still applies", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_toolcalls", "tool-calls", [])

        await withAdvancingClock(60_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_toolcalls",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            ...clock,
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

        await withAdvancingClock(60_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_no_finish",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            ...clock,
          }, 120_000)

          expect(result).toContain("Poll inactivity timeout reached")
          expect(result).not.toContain("Subagent stalled")
        })
      })
    })

    describe("#when the session is waiting on its own background children", () => {
      test("#then stall detection does NOT fire (session is legitimately quiescent)", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_child_wait", "unknown", [])

        await withAdvancingClock(60_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_child_wait",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            hasActiveChildBackgroundTasks: () => true,
            ...clock,
          }, 120_000)

          expect(result).toContain("Poll inactivity timeout reached")
          expect(result).not.toContain("Subagent stalled")
        })
      })
    })

    describe("#when the session becomes active again during the stall window", () => {
      test.each(["busy", "retry", "running"])(
        "#then %s resets the stall timer and requires a fresh contiguous idle window",
        async (activeStatus: string) => {
          const { pollSyncSession } = require("./sync-session-poller")
          let abortCount = 0
          let messageCallCount = 0
          const statusSequence: string[] = ["idle", "idle", activeStatus, "idle", "idle", "idle"]
          let statusCallCount = 0
          const client = createStalledClient("ses_active_reset", "unknown", [])
          client.session.abort = async () => {
            abortCount++
          }
          client.session.status = async () => {
            statusCallCount++
            const type = statusSequence[statusCallCount - 1] ?? "idle"
            return { data: { ses_active_reset: { type } } }
          }
          client.session.messages = async () => {
            messageCallCount++
            return {
              data: [
                { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
                { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" }, parts: [] },
              ],
            }
          }

          // 10s per poll. Without the active-state reset the stall would fire on
          // the 4th poll; with the reset it needs a fresh 30s contiguous idle
          // window and fires later, proving active periods do not count toward
          // the stall timeout.
          await withAdvancingClock(10_000, async (clock) => {
            const result = await pollSyncSession(createMockCtx(), client, {
              sessionID: "ses_active_reset",
              agentToUse: "test-agent",
              toastManager: null,
              taskId: undefined,
              stallTimeoutMs: 30_000,
              ...clock,
            })

            expect(result).toContain("Subagent stalled")
            expect(abortCount).toBe(1)
            expect(messageCallCount).toBeGreaterThan(3)
          })
        }
      )
    })

    describe("#when status observation is unavailable during the stall window", () => {
      test.each(["throw", "missing"])(
        "#then a %s observation resets the timer while message completion remains available",
        async (unavailableKind: string) => {
          const { pollSyncSession } = require("./sync-session-poller")
          let statusCallCount = 0
          let messageCallCount = 0
          const client = createStalledClient("ses_status_unavailable", "unknown", [])
          client.session.status = async () => {
            statusCallCount++
            if (statusCallCount === 3) {
              if (unavailableKind === "throw") throw new Error("status unavailable")
              return { data: {} }
            }
            return { data: { ses_status_unavailable: { type: "idle" } } }
          }
          client.session.messages = async () => {
            messageCallCount++
            const assistant =
              messageCallCount >= 5
                ? { info: { id: "msg_003", role: "assistant", time: { created: 3000 }, finish: "stop" }, parts: [{ type: "text", text: "recovered" }] }
                : { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" }, parts: [] }
            return { data: [{ info: { id: "msg_001", role: "user", time: { created: 1000 } } }, assistant] }
          }

          await withAdvancingClock(10_000, async (clock) => {
            const result = await pollSyncSession(createMockCtx(), client, {
              sessionID: "ses_status_unavailable",
              agentToUse: "test-agent",
              toastManager: null,
              taskId: undefined,
              stallTimeoutMs: 30_000,
              ...clock,
            })

            expect(result).toBeNull()
            expect(messageCallCount).toBeGreaterThanOrEqual(5)
          })
        }
      )
    })

    describe("#when status observation returns an unrecognized state", () => {
      test("#then it does not count as inactive while terminal-message detection remains available", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        let messageCallCount = 0
        const client = createStalledClient("ses_unrecognized_status", "unknown", [])
        client.session.status = async () => ({
          data: { ses_unrecognized_status: { type: "connecting" } },
        })
        client.session.messages = async () => {
          messageCallCount++
          const assistant =
            messageCallCount >= 5
              ? { info: { id: "msg_003", role: "assistant", time: { created: 3000 }, finish: "stop" }, parts: [{ type: "text", text: "recovered" }] }
              : { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" }, parts: [] }
          return { data: [{ info: { id: "msg_001", role: "user", time: { created: 1000 } } }, assistant] }
        }

        await withAdvancingClock(10_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_unrecognized_status",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            ...clock,
          })

          expect(result).toBeNull()
          expect(messageCallCount).toBeGreaterThanOrEqual(5)
        })
      })
    })

    describe("#when relevant assistant content mutates without changing message count", () => {
      test.each([
        {
          name: "assistant id",
          prior: { id: "msg_002", finish: "stop", type: "text", text: "prior" },
          candidate: { id: "msg_004", finish: "unknown", type: "text", text: "draft-a" },
        },
        {
          name: "assistant finish",
          prior: { id: "msg_002", finish: "tool-calls", type: "text", text: "prior" },
          candidate: { id: "msg_003", finish: "unknown", type: "text", text: "draft-a" },
        },
        {
          name: "part type",
          prior: { id: "msg_002", finish: "stop", type: "text", text: "prior" },
          candidate: { id: "msg_003", finish: "unknown", type: "reasoning", text: "draft-a" },
        },
        {
          name: "part text",
          prior: { id: "msg_002", finish: "stop", type: "text", text: "prior" },
          candidate: { id: "msg_003", finish: "unknown", type: "text", text: "draft-b" },
        },
      ])("#then a same-length $name mutation resets the stall timer", async ({ prior, candidate }) => {
        const { pollSyncSession } = require("./sync-session-poller")
        let messageCallCount = 0
        const baseline = {
          prior: { id: "msg_002", finish: "stop", type: "text", text: "prior" },
          candidate: { id: "msg_003", finish: "unknown", type: "text", text: "draft-a" },
        }
        const recovered = {
          prior,
          candidate: { id: "msg_005", finish: "stop", type: "text", text: "recovered" },
        }
        const states = [baseline, baseline, { prior, candidate }, { prior, candidate }, recovered]
        const client = createStalledClient("ses_same_length_progress", "unknown", [])
        client.session.messages = async () => {
          const state = states[Math.min(messageCallCount, states.length - 1)]
          messageCallCount++
          return {
            data: [
              { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
              { info: { id: state.prior.id, role: "assistant", time: { created: 2000 }, finish: state.prior.finish }, parts: [{ type: state.prior.type, text: state.prior.text }] },
              { info: { id: state.candidate.id, role: "assistant", time: { created: 3000 }, finish: state.candidate.finish }, parts: [{ type: state.candidate.type, text: state.candidate.text }] },
            ],
          }
        }

        await withAdvancingClock(1_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_same_length_progress",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 3_000,
            ...clock,
          })

          expect(result).toBeNull()
          expect(messageCallCount).toBe(states.length)
        })
      })
    })

    describe("#given an anchored continuation", () => {
      test("#then stale prior-turn text is not a deliverable for an empty current-turn assistant", async () => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_stale_deliverable", "unknown", [])
        client.session.messages = async () => ({
          data: [
            { info: { id: "msg_000", role: "assistant", time: { created: 500 }, finish: "stop" } },
            { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" }, parts: [{ type: "text", text: "old result" }] },
            { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
            { info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "unknown" }, parts: [] },
          ],
        })

        await withAdvancingClock(10_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_stale_deliverable",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            anchorMessageCount: 1,
            stallTimeoutMs: 30_000,
            ...clock,
          })

          expect(result).toContain("Subagent stalled")
        })
      })

      test.each([
        {
          name: "pre-anchor assistant",
          messages: [
            { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "unknown" }, parts: [] },
            { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
          ],
          anchorMessageCount: 2,
        },
        {
          name: "assistant superseded by a newer user",
          messages: [
            { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            { info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" }, parts: [{ type: "text", text: "old result" }] },
            { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
            { info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "unknown" }, parts: [] },
            { info: { id: "msg_005", role: "user", time: { created: 5000 } } },
          ],
          anchorMessageCount: 2,
        },
      ])("#then $name cannot trigger current-turn stall detection", async ({ messages, anchorMessageCount }) => {
        const { pollSyncSession } = require("./sync-session-poller")
        const client = createStalledClient("ses_anchor_candidate", "unknown", [])
        client.session.messages = async () => ({ data: messages })

        await withAdvancingClock(10_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_anchor_candidate",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            anchorMessageCount,
            stallTimeoutMs: 30_000,
            ...clock,
          }, 80_000)

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

        await withAdvancingClock(60_000, async (clock) => {
          const result = await pollSyncSession(createMockCtx(), client, {
            sessionID: "ses_reset",
            agentToUse: "test-agent",
            toastManager: null,
            taskId: undefined,
            stallTimeoutMs: 30_000,
            ...clock,
          })

          expect(result).toBeNull()
        })
      })
    })
  })
})
