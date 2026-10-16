# Git Autocommit Plugin for OpenCode

[![npm version](https://badge.fury.io/js/@reachdevel%2Fopencode-git-commit.svg)](https://badge.fury.io/js/@reachdevel%2Fopencode-git-commit)

An OpenCode plugin that automatically commits changes when your coding session becomes idle.

Requires OpenCode v2 (uses the `@opencode/plugin` v2 plugin API).

## What It Does

This plugin monitors your OpenCode session and automatically creates git commits when:

1. The session goes idle (no active operations)
2. There are uncommitted changes in your working directory
3. A git repository exists (or can be initialized)

The commit message is intelligently extracted from the last assistant message in your conversation, making commits contextual and meaningful.

## Features

- **Automatic Commits** - Commits changes whenever your session becomes idle
- **Smart Commit Messages** - Extracts context from your last conversation to create meaningful commit messages
- **Auto-initialize** - Automatically initializes a git repository if one doesn't exist
- **Respects .gitignore** - Git handles ignored files automatically
- **Conventional Commits** - Uses `feat:` or `fix:` prefixes based on message content

## Installation

### Via Command Line
```bash
opencode plugin add @reachdevel/opencode-git-commit@latest
```

### Via Configuration
Add to your `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@reachdevel/opencode-git-commit@latest"
  ]
}
```

### Manual Installation
```bash
npm install @reachdevel/opencode-git-commit
```

Then add to `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "file:///path/to/node_modules/@reachdevel/opencode-git-commit/dist/index.js"
  ]
}
```

## How It Works

1. When a `session.idle` event is triggered, the plugin checks for git changes
2. If changes exist, it fetches the last assistant message from your session
3. Extracts the first line, sanitizes it, and uses it as the commit message
4. Stages all changes with `git add .`
5. Commits with `--no-verify` to bypass hooks

## Configuration

The plugin works out of the box with no configuration needed. Just install and it will start auto-committing.

To disable it for a project, remove its id from the plugin list:

```json
{
  "plugins": ["*", "-git-autocommit"]
}
```

## Requirements

- OpenCode with plugin support
- Node.js (for running the plugin)
- Git installed on your system

## License

MIT