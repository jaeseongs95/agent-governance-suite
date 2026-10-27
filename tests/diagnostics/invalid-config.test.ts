import {expect, it} from "vitest";
import {spawn} from "node:child_process";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

it("closes the one-shot invalid-config logger while MCP remains available", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "ags-invalid-log-"));
  const wrapper = path.join(directory, "startup.mts");
  const entry = new URL("../../mcp-server/src/index.ts", import.meta.url).href;
  await writeFile(wrapper, `
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original = childProcess.fork;
childProcess.fork = (...args) => {
  const child = original(...args);
  if (String(args[0]).includes('diagnostics-worker')) {
    process.send?.({kind:'logger-created'});
    const send = child.send.bind(child);
    child.send = (...messages) => {
      const message = messages[0];
      if (message?.fields?.event) process.send?.({kind:'event', event:message.fields.event});
      if (message?.close) process.send?.({kind:'logger-close'});
      return send(...messages);
    };
    child.once('exit', (code, signal) => process.send?.({kind:'logger-exit',code,signal}));
  }
  return child;
};
syncBuiltinESMExports();
const {startMcpServer} = await import(${JSON.stringify(entry)});
await startMcpServer();
process.send?.({kind:'started'});
`, "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !key.startsWith("AGENT_GOVERNANCE_"))) as Record<string, string>;
  Object.assign(env, {
    AGENT_GOVERNANCE_LOG_CONFIG: "{invalid-synthetic-config",
    SKILL_REGISTRY_PATH: path.join(root, "skills/registry.json"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: directory,
    AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
  });
  const child = spawn(process.execPath, ["--import", "tsx", wrapper], {
    cwd: root, env, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  const observed: Array<{kind: string; event?: string}> = [];
  let out = "", err = "";
  child.stdout!.on("data", data => {out += data;});
  child.stderr!.on("data", data => {err += data;});
  const until = async (predicate: () => boolean, milliseconds: number) => {
    const end = Date.now() + milliseconds;
    while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    expect(predicate(), JSON.stringify({observed, out, err})).toBe(true);
  };
  child.on("message", message => {observed.push(message as {kind: string; event?: string});});
  try {
    await until(() => observed.some(message => message.kind === "started"), 8000);
    // The real logger has a 100ms flush deadline; allow scheduling overhead without waiting for server shutdown.
    await until(() => observed.some(message => message.kind === "logger-exit"), 1500);
    expect(observed.filter(message => message.kind === "logger-created")).toHaveLength(1);
    expect(observed.filter(message => message.event === "configuration_invalid")).toHaveLength(1);
    expect(observed.filter(message => message.kind === "logger-close")).toHaveLength(1);
    child.stdin!.write(JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "invalid-log-fixture", version: "1.0.0"},
    }}) + "\n");
    await until(() => out.includes('"id":1'), 2000);
    const initialized = out.split("\n").filter(Boolean).map(line => JSON.parse(line) as {id?: number; result?: unknown});
    expect(initialized.find(message => message.id === 1)?.result).toBeDefined();
    expect(child.exitCode).toBeNull();
  } finally {
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.stdin!.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await exited;
    clearTimeout(timer);
  }
});
