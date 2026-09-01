// End-to-end stall evidence harness v2.
// Real opencode + source-loaded plugin (with rebased stall detection) + mock
// interrupted-stream provider. Parent turn uses the built-in `build` agent so
// the session model (mock/mock-model) is honored.
//
// Usage: node drive-stall.mjs DELIVERABLE|EMPTY
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, openSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const WORKTREE = "C:/Users/sayan/AppData/Local/Temp/opencode/pr6666-sync"
const OC_EXE = process.env.APPDATA + "/npm/node_modules/opencode-ai/bin/opencode.exe"
const MOCK_PORT = 8790
const SERVER_PORT = 8797
const PASSWORD = "stall-evidence-pw"
const MODE = (process.argv[2] ?? "DELIVERABLE").toUpperCase()

const sandbox = mkdtempSync(join(tmpdir(), `pr6666-e2e-${MODE}-`))
for (const d of ["data", "config", "cache", "state", "home", "proj"]) mkdirSync(join(sandbox, d))

const config = {
  plugin: [`file://${WORKTREE}/packages/omo-opencode/src/index.ts`],
  model: "opencode-go/deepseek-v4-flash",
  provider: {
    // The real user's ~/.omo/omo.jsonc overrides agents to opencode-go and
    // mzy models; register THOSE provider ids against the mock so every
    // resolution lands on the interrupted-stream server regardless.
    "opencode-go": {
      npm: "@ai-sdk/openai-compatible",
      name: "Mock Stall Probe (opencode-go)",
      options: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "mock-key" },
      models: {
        "deepseek-v4-flash": { name: "Mock DsFlash", limit: { context: 32000, output: 8000 }, tool_call: true, reasoning: true },
        "claude-opus-5": { name: "Mock Opus", limit: { context: 32000, output: 8000 }, tool_call: true, reasoning: true },
      },
    },
    mzy: {
      npm: "@ai-sdk/openai-compatible",
      name: "Mock Stall Probe (mzy)",
      options: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "mock-key" },
      models: {
        "gpt-5.6-sol": { name: "Mock Sol", limit: { context: 32000, output: 8000 }, tool_call: true },
        "gpt-5.6-terra": { name: "Mock Terra", limit: { context: 32000, output: 8000 }, tool_call: true },
      },
    },
    opencode: {
      npm: "@ai-sdk/openai-compatible",
      name: "Mock Stall Probe (opencode)",
      options: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "mock-key" },
      models: {
        "claude-opus-5": { name: "Mock Opus", limit: { context: 32000, output: 8000 }, tool_call: true, reasoning: true },
      },
    },
  },
}

// Route every OMO agent/category at the mock model BEFORE the server starts.
{
  const { writeFileSync, mkdirSync } = await import("node:fs")
  const mockModel = "opencode/claude-opus-5"
  const agents = {}
  for (const a of ["sisyphus", "sisyphus-junior", "explore", "librarian", "oracle", "build", "plan", "atlas", "hephaestus", "metis", "momus", "quick", "deep", "ultrabrain", "writing", "artistry", "unspecified-low", "unspecified-high"]) {
    agents[a] = { model: mockModel }
  }
  const categories = {}
  for (const c of ["quick", "deep", "ultrabrain", "writing", "artistry", "explore", "librarian", "oracle", "general"]) {
    categories[c] = { model: mockModel }
  }
  const cfg = JSON.stringify({ agents, categories }, null, 2)
  // user-level: <home>/.omo/omo.jsonc ; project-level: <proj>/.omo/omo.jsonc
  mkdirSync(join(sandbox, "home", ".omo"), { recursive: true })
  writeFileSync(join(sandbox, "home", ".omo", "omo.jsonc"), cfg)
  mkdirSync(join(sandbox, "proj", ".omo"), { recursive: true })
  writeFileSync(join(sandbox, "proj", ".omo", "omo.jsonc"), cfg)
}

const logPath = join(sandbox, "serve.log")
const logFd = openSync(logPath, "a")
const child = spawn(OC_EXE, ["serve", "--port", String(SERVER_PORT), "--hostname", "127.0.0.1", "--print-logs"], {
  cwd: join(sandbox, "proj"),
  env: {
    ...process.env,
    HOME: join(sandbox, "home"),
    USERPROFILE: join(sandbox, "home"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  },
  stdio: ["ignore", logFd, logFd],
})
console.log(`[e2e:${MODE}] opencode pid ${child.pid}, sandbox ${sandbox}`)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Wait for listening.
let up = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try { await fetch(`http://127.0.0.1:${SERVER_PORT}/doc`); up = true; break } catch { /* retry */ }
  if (readFileSync(logPath, "utf8").includes("listening")) { up = true; break }
}
console.log(`[e2e:${MODE}] server up: ${up}`)
if (!up) { console.log(readFileSync(logPath, "utf8").slice(-2000)); child.kill(); process.exit(1) }
await sleep(3000) // let the plugin finish loading

const auth = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64")
const H = { "Content-Type": "application/json", Authorization: auth }
const base = `http://127.0.0.1:${SERVER_PORT}`

// --- parent session, built-in build agent, mock model ---
const createRes = await fetch(`${base}/session`, { method: "POST", headers: H, body: JSON.stringify({ title: `stall-e2e-${MODE}` }) })
const sid = (await createRes.json())?.id
console.log(`[e2e:${MODE}] parent session ${sid}`)

const promptT0 = Date.now()
const prRes = await fetch(`${base}/session/${sid}/prompt_async`, {
  method: "POST", headers: H,
  body: JSON.stringify({
    model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    parts: [{ type: "text", text: MODE === "EMPTY" ? "PARENTDELEGATE EMPTYMODE please delegate the probe now" : "PARENTDELEGATE DELIVERMODE please delegate the probe now" }],
  }),
})
console.log(`[e2e:${MODE}] prompt(async) status ${prRes.status}`)

async function getJSON(url) {
  const r = await fetch(url, { headers: { Authorization: auth } })
  return r.json()
}

let taskDone = false
let taskOutput = ""
let taskError = ""
const statusLog = []
const deadline = Date.now() + 400_000
while (Date.now() < deadline) {
  await sleep(1000)
  const elapsed = Math.round((Date.now() - promptT0) / 1000)
  try {
    const st = await getJSON(`${base}/session/status`)
    const summary = Object.entries(st ?? {}).map(([k, v]) => `${k.slice(0, 12)}=${v?.type}`).join(" ")
    if (statusLog[statusLog.length - 1] !== summary) statusLog.push(summary)
    const msgs = await getJSON(`${base}/session/${sid}/message?limit=100`)
    const arr = Array.isArray(msgs) ? msgs : (msgs?.data ?? [])
    for (const m of arr) {
      for (const p of m?.parts ?? []) {
        if (p?.type === "tool" && p?.tool === "task") {
          const status = p?.state?.status
          if (status === "completed" || status === "error" || status === "pending") {
            if (!taskDone && typeof p.state?.output === "string" && p.state.output.length > 0 || status === "error") {
              taskDone = true
              taskOutput = String(p.state?.output ?? "")
              taskError = String(p.state?.error ?? "")
              console.log(`[e2e:${MODE}] t+${elapsed}s TASK tool reached status=${status}`)
            }
          }
        }
      }
    }
    if (taskDone) break
  } catch (e) {
    console.log(`[e2e:${MODE}] t+${elapsed}s poll err: ${String(e).slice(0, 120)}`)
  }
}

const totalSecs = Math.round((Date.now() - promptT0) / 1000)
console.log(`\n[e2e:${MODE}] status-map timeline:`)
statusLog.forEach((s, i) => console.log(`  [${i}] ${s}`))

if (taskDone) {
  console.log(`\n[e2e:${MODE}] === TASK TOOL OUTPUT (t+${totalSecs}s) ===`)
  if (taskError) console.log(`[e2e:${MODE}] task error: ${taskError.slice(0, 300)}`)
  console.log(taskOutput.slice(0, 900))
  console.log(`\n[e2e:${MODE}] VERDICT: task tool returned at ~${totalSecs}s`)
} else {
  console.log(`\n[e2e:${MODE}] TASK TOOL DID NOT FINISH within ${totalSecs}s`)
}

// Dump the parent transcript for the record.
{
  const msgs = await getJSON(`${base}/session/${sid}/message?limit=100`)
  const arr = Array.isArray(msgs) ? msgs : (msgs?.data ?? [])
  console.log(`\n[e2e:${MODE}] --- PARENT TRANSCRIPT (${arr.length}) ---`)
  for (const m of arr) {
    const info = m?.info ?? {}
    console.log(`[e2e:${MODE}] ${info.role} finish=${JSON.stringify(info.finish)}`)
    for (const p of m?.parts ?? []) {
      const d = { type: p.type }
      if (p.text) d.text = String(p.text).slice(0, 100)
      if (p.tool) d.tool = p.tool
      if (p.state) { d.status = p.state.status; d.output = String(p.state.output ?? "").slice(0, 220) }
      console.log("[e2e:${MODE}]   part", JSON.stringify(d).slice(0, 400))
    }
  }
}

// Log tail for stall-detection lines.
const log = readFileSync(logPath, "utf8")
const stallLines = log.split("\n").filter((l) => /stall|Stall|task\]|delegate|sync/i.test(l)).slice(-40)
console.log(`\n[e2e:${MODE}] --- relevant log lines ---`)
for (const l of stallLines) console.log("[log]", l.slice(0, 220))

child.kill()
process.exit(0)
