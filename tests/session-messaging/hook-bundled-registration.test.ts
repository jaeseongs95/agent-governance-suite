import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("registers a fourth host through the same deployed namespace that consumes its adapter", () => {
  const bundle = fileURLToPath(new URL("../../mcp-server/dist/session-message-hook.mjs", import.meta.url));
  const bundleUrl = pathToFileURL(bundle).href;
  const script = [
    'import assert from "node:assert/strict";',
    "const entry = await import(" + JSON.stringify(bundleUrl) + ");",
    'const host = "fourth-bundled-host";',
    'assert.equal(typeof entry.registerHookHostAdapter, "function");',
    'assert.equal(typeof entry.runSessionMessageHook, "function");',
    'assert.throws(() => entry.sessionMessageTransport(host, {}), {code:"HOST_ADAPTER_UNAVAILABLE"});',
    'const adapter = {deliveryProfile: () => ({transport:"claude-inbox", capabilities:{supportedInjection:["tool-boundary"],idleWake:"none"}, blocksEmptyWakePrompt:false}), processPid: () => undefined};',
    'entry.registerHookHostAdapter(host, adapter);',
    'assert.equal(entry.sessionMessageTransport(host, {}), "claude-inbox");',
    'assert.throws(() => entry.registerHookHostAdapter(host, adapter), {code:"HOOK_HOST_ADAPTER_DUPLICATE"});',
    'assert.throws(() => entry.registerHookHostAdapter("codex", adapter), {code:"HOOK_HOST_ADAPTER_DUPLICATE"});',
    'assert.throws(() => entry.registerHookHostAdapter("../bad-host", adapter), {code:"INVALID_HOOK_HOST_ADAPTER"});',
    'const env = {AGENT_GOVERNANCE_CODEX_QUEUE_WAKE:"0",AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE:"0"};',
    'assert.equal(entry.sessionMessageTransport("codex", env), "codex-deferred");',
    'assert.equal(entry.sessionMessageTransport("claude-code", env), "claude-inbox");',
    'assert.equal(entry.sessionMessageTransport("gemini", env), "codex-deferred");',
    "const other = await import(" + JSON.stringify(bundleUrl + "?separate-namespace") + ");",
    'assert.throws(() => other.sessionMessageTransport(host, {}), {code:"HOST_ADAPTER_UNAVAILABLE"});',
    // No session ID, actor authority, or process observation is invented by registration.
    'assert.equal(await entry.runSessionMessageHook(host, "{}"), "");',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.dirname(bundle), encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe("");
});
