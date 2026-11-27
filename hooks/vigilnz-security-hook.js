#!/usr/bin/env node
/**
 * File: vigilnz-security-hook.js
 * Purpose: Claude Code PreToolUse/PostToolUse hook that reports tool calls to Vigilnz's
 *          RuntimeGuard gateway (the same event pipeline the OpenClaw plugin uses) and
 *          enforces its allow/deny decision.
 * Author: Anand
 * Date: 2026-10-12
 *
 * Wire contract verified directly against the Go gateway source
 * (unified-gateway-go/internal/openclaw/handler.go, classify_event.go, decide.go) — not
 * guessed from the OpenClaw-specific docs, since this hook is a new, separate integration.
 *
 * Request to POST {VIGILNZ_GATEWAY_URL}/api/openclaw/event:
 *   headers: { "x-plugin-key": VIGILNZ_CLAUDE_CODE_PLUGIN_KEY, "Content-Type": "application/json" }
 *   body: { hook, session_id, agent_id, payload, timestamp }
 *     - hook: "before_tool_call" | "after_tool_call" (classify_event.go's own hook-name switch)
 *     - session_id, agent_id: required by the gateway's validateOpenClawEventBody
 *     - payload.tool_name / payload.args: read by the classifier for exec/mcp/tool_call detection
 *
 * Response: { decision: "allow" | "block" | "pending_approval", reason?, risk_score, cumulative_risk }
 *
 * Claude Code's own hook I/O contract (verified against code.claude.com/docs/en/hooks):
 *   PreToolUse stdin:  { session_id, tool_name, tool_input, tool_use_id, ... }
 *   PreToolUse stdout: { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 *     permissionDecision is "allow" | "deny" | "ask" | "defer" — there is no native async-wait
 *     mechanism verified here, so the gateway's "pending_approval" decision maps to "ask"
 *     (prompts the human) rather than a true blocking wait on the backend's approval queue.
 *   PostToolUse stdin: same plus { tool_response, duration_ms }
 *   PostToolUse stdout: top-level { decision: "block", reason } — no permissionDecision here.
 *
 * Config is read two ways, in this order, so both install paths work with the same script:
 *   1. Claude Code plugin install (../.claude-plugin/plugin.json's userConfig) — Claude Code
 *      injects each option as CLAUDE_PLUGIN_OPTION_<KEY> (key uppercased). This is the
 *      recommended path: `claude plugin install vigilnz-runtimeguard --marketplace vigilnz/...`.
 *   2. Manual install (customer hand-edits settings.json per the Setup page's install guide) —
 *      falls back to raw VIGILNZ_* env vars for orgs where `allowManagedHooksOnly` blocks
 *      plugin hooks entirely (code.claude.com/docs/en/hooks.md).
 *
 * Required (either naming):
 *   CLAUDE_PLUGIN_OPTION_GATEWAY_URL / VIGILNZ_GATEWAY_URL            — e.g. https://gateway.vigilnz.com
 *                                                                        (no default: never guess a
 *                                                                        customer's gateway host)
 *   CLAUDE_PLUGIN_OPTION_PLUGIN_KEY  / VIGILNZ_CLAUDE_CODE_PLUGIN_KEY — the workflow's plugin key
 *                                                                        from the Setup page
 * Optional:
 *   VIGILNZ_FAIL_OPEN               — "false" to block tool calls when the gateway is
 *                                      unreachable; defaults to fail-open so a Vigilnz outage
 *                                      doesn't stop the customer's Claude Code session
 */

'use strict';

const HTTP_TIMEOUT_MS = 5000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function buildEventBody(hookInput, hookName) {
  return {
    hook: hookName,
    session_id: hookInput.session_id,
    agent_id: hookInput.agent_id || 'claude-code-main',
    payload: {
      tool_name: hookInput.tool_name,
      args: hookInput.tool_input,
      tool_response: hookInput.tool_response,
      cwd: hookInput.cwd,
    },
    timestamp: new Date().toISOString(),
  };
}

async function callGateway(gatewayUrl, pluginKey, eventBody) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${gatewayUrl}/api/openclaw/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-plugin-key': pluginKey },
      body: JSON.stringify(eventBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Gateway responded ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function preToolUseOutput(decision) {
  if (decision.decision === 'block') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason || 'Blocked by Vigilnz RuntimeGuard',
      },
    };
  }
  if (decision.decision === 'pending_approval') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: decision.reason || 'Vigilnz RuntimeGuard flagged this for review',
      },
    };
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
}

function postToolUseOutput(decision) {
  if (decision.decision === 'block') {
    return { decision: 'block', reason: decision.reason || 'Flagged by Vigilnz RuntimeGuard after execution' };
  }
  return {};
}

async function main() {
  const raw = await readStdin();
  const hookInput = JSON.parse(raw);
  const isPostToolUse = hookInput.hook_event_name === 'PostToolUse';
  const hookName = isPostToolUse ? 'after_tool_call' : 'before_tool_call';

  const gatewayUrl = process.env.CLAUDE_PLUGIN_OPTION_GATEWAY_URL || process.env.VIGILNZ_GATEWAY_URL;
  const pluginKey = process.env.CLAUDE_PLUGIN_OPTION_PLUGIN_KEY || process.env.VIGILNZ_CLAUDE_CODE_PLUGIN_KEY;
  const failOpen = process.env.VIGILNZ_FAIL_OPEN !== 'false';

  if (!gatewayUrl || !pluginKey) {
    process.stderr.write('vigilnz-security-hook: gateway URL / plugin key not set (plugin userConfig or VIGILNZ_GATEWAY_URL / VIGILNZ_CLAUDE_CODE_PLUGIN_KEY)\n');
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(failOpen ? 0 : 2);
    return;
  }

  try {
    const eventBody = buildEventBody(hookInput, hookName);
    const decision = await callGateway(gatewayUrl, pluginKey, eventBody);
    const output = isPostToolUse ? postToolUseOutput(decision) : preToolUseOutput(decision);
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`vigilnz-security-hook: gateway call failed: ${error.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(failOpen ? 0 : 2);
  }
}

main();
