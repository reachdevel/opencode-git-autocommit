import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Plugin } from "@opencode/plugin"

const exec = promisify(execFile)

const SERVICE = "git-autocommit"

/** Terminal session events: the session stopped running and can be committed. */
type TerminalEvent = {
  type: "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
  data: { sessionID: string }
}

const TERMINAL = new Set<string>([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

function isTerminal(event: { type: string }): event is unknown & TerminalEvent {
  return TERMINAL.has(event.type)
}

function log(level: "info" | "debug" | "error", message: string) {
  const line = `[${SERVICE}] ${message}`
  if (level === "error") console.error(line)
  else console.log(line)
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { cwd })
  return stdout
}

async function isRepository(cwd: string) {
  try {
    await git(cwd, ["rev-parse", "--git-dir"])
    return true
  } catch {
    return false
  }
}

function commitMessageFrom(messages: readonly { type: string; content?: readonly { type: string; text?: string }[] }[]) {
  const assistant = [...messages].reverse().find((m) => m.type === "assistant")
  const text = assistant?.content?.find((part) => part.type === "text")?.text
  if (!text) return undefined

  const sanitized = text
    .split("\n")[0]
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .substring(0, 50)
    .trim()

  return sanitized || undefined
}

function buildCommitMessage(text: string) {
  const type = text.toLowerCase().includes("fix") ? "fix" : "feat"
  return `${type}: ${text}`
}

const GitAutocommitPlugin = Plugin.define({
  id: "git-autocommit",
  setup(ctx) {
    log("info", `Plugin initialized for ${ctx.location.directory}`)

    const controller = new AbortController()
    const pending = new Map<string, Promise<void>>()

    const run = (directory: string, sessionID: string) => {
      const previous = pending.get(directory) ?? Promise.resolve()
      const next = previous.then(async () => {
        const cwd = directory

        // Initialize a repository if the location has none yet
        if (!(await isRepository(cwd))) {
          await git(cwd, ["init"])
          log("info", "Initialized git repository")
        }

        const status = await git(cwd, ["status", "--porcelain"])
        if (!status.trim()) {
          log("debug", "No changes detected")
          return
        }

        const messages = await ctx.session.context({ sessionID })
        const text = commitMessageFrom(messages) ?? "automated update"
        const message = buildCommitMessage(text)

        // Stage and commit (git respects .gitignore by default)
        await git(cwd, ["add", "."])

        // Fall back to a bot identity only when the machine has no git identity configured
        const identity =
          process.env.GIT_AUTHOR_EMAIL || (await git(cwd, ["config", "--get", "user.email"]).catch(() => ""))
            ? []
            : ["-c", "user.name=opencode", "-c", "user.email=opencode@localhost"]

        await git(cwd, [...identity, "commit", "-m", message, "--no-verify"])

        log("info", `Committed: ${message}`)
      })

      const settled = next.catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        log("error", message)
      })
      pending.set(directory, settled)
      return settled
    }

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // OpenCode v2 does not publish session.idle to plugins. The terminal
        // execution events are what actually signal the session finished.
        if (!isTerminal(event)) continue
        log("debug", `Session finished (${event.type})`)

        await run(ctx.location.directory, event.data.sessionID)
      }
    })()

    return () => controller.abort()
  },
})

export { GitAutocommitPlugin }
export default GitAutocommitPlugin