# Vigilnz RuntimeGuard — Claude Code Plugin

Reports every Claude Code tool call to your Vigilnz RuntimeGuard gateway and enforces
its allow / deny / pending-approval decisions in real time.

## What it does

The plugin registers a `PreToolUse` and `PostToolUse` hook (`hooks/vigilnz-security-hook.js`)
that runs before and after every tool call:

- **PreToolUse** — sends the tool name, arguments, and session context to the gateway,
  then maps the gateway's decision to Claude Code's permission system:
  - `allow` → the tool call proceeds
  - `block` → the tool call is denied, with the gateway's reason shown to the user
  - `pending_approval` → the user is prompted to approve manually
- **PostToolUse** — sends the tool's result to the gateway so it can flag a call
  after the fact (e.g. if the response reveals something risky); a `block` decision
  here surfaces as a blocked result.

If the gateway is unreachable or misconfigured, the hook **fails open** by default —
tool calls are allowed so a Vigilnz outage doesn't stop your Claude Code session. Set
`VIGILNZ_FAIL_OPEN=false` to fail closed instead.

## Requirements

- Node.js available on `PATH` (the hook runs via `node`)
- A Vigilnz RuntimeGuard gateway URL and plugin key (from your Vigilnz admin / the
  RuntimeGuard Setup page)

## Configuration

Configure via one of two paths:

**1. Plugin install (recommended)**

```
claude plugin install vigilnz-runtimeguard --marketplace vigilnz/...
```

Claude Code prompts for the plugin's `userConfig` values (see
[.claude-plugin/plugin.json](.claude-plugin/plugin.json)):

| Option | Description |
|---|---|
| `gateway_url` | Your Vigilnz RuntimeGuard gateway URL |
| `plugin_key` | The one-time plugin key from the RuntimeGuard Setup page (sensitive) |

These are injected as `CLAUDE_PLUGIN_OPTION_GATEWAY_URL` / `CLAUDE_PLUGIN_OPTION_PLUGIN_KEY`.

**2. Manual install**

For organizations with `allowManagedHooksOnly` set (which blocks plugin hooks), wire
the hook directly in `settings.json` and set these environment variables instead:

| Variable | Description |
|---|---|
| `VIGILNZ_GATEWAY_URL` | Your Vigilnz RuntimeGuard gateway URL |
| `VIGILNZ_CLAUDE_CODE_PLUGIN_KEY` | The plugin key from the RuntimeGuard Setup page |
| `VIGILNZ_FAIL_OPEN` | `"false"` to block tool calls when the gateway is unreachable (default: fail-open) |

## Files

- [.claude-plugin/plugin.json](.claude-plugin/plugin.json) — plugin manifest and `userConfig` schema
- [hooks/hooks.json](hooks/hooks.json) — registers the hook for `PreToolUse` and `PostToolUse`
- [hooks/vigilnz-security-hook.js](hooks/vigilnz-security-hook.js) — the hook implementation; see its
  header comment for the full wire contract with the gateway
