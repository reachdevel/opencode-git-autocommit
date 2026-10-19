# Git Autocommit Plugin — Agent Context

This file records decisions so we don't re-litigate them on every change. If you're modifying the plugin, read this first.

## What the plugin does

OpenCode plugin (v2 API) that auto-commits when a session run reaches a terminal state (`session.execution.succeeded`, `.failed`, `.interrupted`). It derives the commit message from the staged git diff itself — no model call, no sanitizing of assistant prose.

## Key design decisions

### 1. Messages come from the diff, not the model's last sentence

`commitMessageFromDiff()` reads `git diff --cached --name-status` and `--numstat`, then infers a Conventional Commits type and picks representative files:

| Situation | Example |
|---|---|
| New files only | `feat: add src/new.ts` |
| Existing source edited | `fix: update src/index.ts` |
| Tests only | `test: update src/a.test.ts` |
| Docs only | `docs: update README.md` |
| Deletions only | `chore: remove src/gone.ts` |
| Lockfiles/dist/CI only | `chore: update dist/index.js` |
| Many files | `fix: update src/one.ts and 5 more files` |

**Do not revert to sanitizing the assistant's last message.** That produced garbage like `srcindexts50` and `stylecss` because dots and backticks get stripped. The diff is deterministic, free, and never garbled.

### 2. Only root sessions trigger commits

Subagent sessions also fire `session.execution.*` terminal events. The plugin checks `ctx.session.get({ sessionID }).parentID` and skips when a parent exists, so subagent work isn't committed mid-parent-task. If parentage can't be determined, it defaults to committing (don't lose work).

**Don't remove this guard.** Without it, every subagent finish creates a premature commit.

### 3. Staged before describing

`git add .` runs before `commitMessageFromDiff()`, so brand-new files are included in the diff and message.

### 4. Identity fallback

Commits with `user.name=opencode`, `user.email=opencode@localhost` only when the machine has no `user.email` configured.

### 5. `--no-verify`

Auto-commits bypass hooks so they never block on pre-commit hooks.

## Package name

- The npm package is **`opencode-git-commit`** (unscoped). It was originally published as `@reachdevel/opencode-git-commit`; do not move it back under the scope.
- `compat/opencode-git-commit-alias/` holds the deprecated `@reachdevel/opencode-git-commit@3.0.0` shim, which just re-exports the unscoped package so existing `opencode.json` entries keep loading. It is published manually, not by CI.
- After the 3.0.0 shim is live, the scoped package is deprecated via `npm deprecate` with a pointer to the unscoped name.

## Releases

- Version is in `package.json`.
- Pushing a `v*` tag (e.g. `git tag v3.0.0 && git push origin v3.0.0`) triggers `.github/workflows/publish.yml`, which runs `npm ci`, `npm run build`, and `npm publish` to npm via OIDC trusted publishing.
- Trusted publishing is configured **per package name** on npmjs.com. A rename means adding a new trusted publisher entry for `opencode-git-commit` (GitHub repo `reachdevel/opencode-git-commit`, workflow `publish.yml`); otherwise the tag push fails with 403/404.
- `dist/` is gitignored — only `src/` and package metadata ship. The published package's `dist/` is built by CI from the tagged commit.

## Porting to Claude Code (future)

The diff-logic half is portable shell/git. The trigger half is runtime-specific: OpenCode uses `ctx.event.subscribe` over `session.execution.*`; Claude Code uses `Stop` / `SessionEnd` hooks in `settings.json`. Do not try to make one entry point detect its environment — write one shared script and two thin adapters (OpenCode plugin TS + Claude hook JSON).

## Conventional commit format

Subjects are capped at 72 characters:

```
<type>: <verb> <files>
```

Type inference is structural: `test` (all test paths), `docs` (all doc paths), `chore` (build/lock/CI/deletions), `feat` (all newly added), `fix` (everything else). Messages describe what changed, not why.