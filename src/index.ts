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

/** One staged path plus its line delta, used to describe the commit. */
type Change = {
  /** Porcelain status letter(s), e.g. "A", "M", "D", "R100". */
  status: string
  file: string
  added: number
  deleted: number
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const DOC_RE = /(^|\/)(docs?)\/|\.(md|mdx|rst)$|^readme/i
const BUILD_RE =
  /(^|\/)(dist|build|out|coverage|\.next|target|vendor)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.lock|\.DS_Store|tsconfig.*\.json|.*\.config\.[cm]?[jt]s)$|^\.github\//
const SOURCE_RE =
  /\.(cm?js|[jt]sx?|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|svelte|vue|sh|bash|sql|html|css|scss|astro)$/

/** Ranking used to pick the most representative file when several changed. */
function rank(file: string) {
  if (BUILD_RE.test(file)) return 3
  if (DOC_RE.test(file)) return 2
  if (TEST_RE.test(file)) return 1
  return 0
}

function isAll(changes: readonly Change[], pattern: RegExp) {
  return changes.every((c) => pattern.test(c.file))
}

/** Parse `git diff --cached --name-status`, e.g. "M\tsrc/a.ts" or "R100\told\tnew". */
function parseNameStatus(output: string) {
  const entries: { status: string; file: string }[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    const fields = line.split("\t")
    entries.push({ status: fields[0] ?? "", file: fields[fields.length - 1] ?? "" })
  }
  return entries
}

/** Parse `git diff --cached --numstat`, e.g. "6\t1\tsrc/a.ts". */
function parseNumstat(output: string) {
  const stats = new Map<string, { added: number; deleted: number }>()
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    const [added, deleted, ...rest] = line.split("\t")
    const file = rest[rest.length - 1]
    if (!file) continue
    stats.set(file, {
      added: Number.isFinite(+added) ? +added : 0,
      deleted: Number.isFinite(+deleted) ? +deleted : 0,
    })
  }
  return stats
}

async function stagedChanges(cwd: string): Promise<Change[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(cwd, ["diff", "--cached", "--name-status"]),
    git(cwd, ["diff", "--cached", "--numstat"]),
  ])
  const stats = parseNumstat(numstat)
  return parseNameStatus(nameStatus).map(({ status, file }) => ({
    status,
    file,
    added: stats.get(file)?.added ?? 0,
    deleted: stats.get(file)?.deleted ?? 0,
  }))
}

/** Map the change set onto a Conventional Commits type. */
function classify(changes: readonly Change[]) {
  const allAdded = changes.every((c) => c.status.startsWith("A"))
  const allDeleted = changes.every((c) => c.status.startsWith("D"))

  if (isAll(changes, TEST_RE)) return "test"
  if (isAll(changes, DOC_RE)) return "docs"
  if (isAll(changes, BUILD_RE)) return "chore"
  if (allDeleted) return "chore"
  if (allAdded) return "feat"
  return "fix"
}

function describeFiles(files: readonly string[]) {
  const [first, second] = files
  if (files.length === 1) return first
  if (files.length === 2) return `${first} and ${second}`
  // "and N more files" counts everything beyond the first, not beyond what we kept.
  return `${first} and ${files.length - 1} more files`
}

/** Build a commit subject from the staged diff alone - no model call, no prose guessing. */
async function commitMessageFromDiff(cwd: string) {
  const changes = await stagedChanges(cwd)
  if (!changes.length) return undefined

  const type = classify(changes)
  const allDeleted = changes.every((c) => c.status.startsWith("D"))

  // Lead with the most representative path and keep the subject readable.
  const files = changes
    .slice()
    .sort((a, b) => rank(a.file) - rank(b.file) || a.file.length - b.file.length)
    .map((c) => c.file)

  const verb = allDeleted ? "remove" : type === "feat" ? "add" : "update"

  const subject = `${type}: ${verb} ${describeFiles(files)}`
  const message = subject.length > 72 ? `${subject.slice(0, 69).trimEnd()}...` : subject
  return message.replace(/[\r\n]/g, " ")
}

const GitAutocommitPlugin = Plugin.define({
  id: "git-autocommit",
  setup(ctx) {
    log("info", `Plugin initialized for ${ctx.location.directory}`)

    const controller = new AbortController()
    const pending = new Map<string, Promise<void>>()

    const run = (directory: string) => {
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

        // Stage first so the diff describes everything, including brand new files
        await git(cwd, ["add", "."])

        // Derive the message from the staged diff itself: deterministic, local, never garbled
        let message: string | undefined
        try {
          message = await commitMessageFromDiff(cwd)
        } catch (err) {
          log("debug", `Falling back to generic message: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!message) message = "chore: automated update"

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

        await run(ctx.location.directory)
      }
    })()

    return () => controller.abort()
  },
})

export { GitAutocommitPlugin }
export default GitAutocommitPlugin