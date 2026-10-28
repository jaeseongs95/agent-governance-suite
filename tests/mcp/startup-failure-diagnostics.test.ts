import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {expect, it} from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = path.join(root, "mcp-server/dist/server.mjs");
const prefix = "[agent-governance-suite] startup-failure ";
const privateCode = "PRIVATE_STARTUP_CODE:" + "s".repeat(300);
const privateMessage = "PRIVATE_STARTUP_MESSAGE Bearer synthetic-auth /private/startup/path SELECT private_sql";
const codeContext = (code: string) => ({type: "string", length: code.length, prefixCodeUnits: Math.min(code.length, 256),
  truncated: code.length > 256, encoding: "utf16le", prefixSha256: createHash("sha256").update(Buffer.from(code.slice(0, 256), "utf16le")).digest("hex")});

it.each(["default-log-off", "before-diagnostics"] as const)("public startup retains one safe fatal diagnostic for %s", async mode => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-startup-failure-"));
  expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
  const database = path.join(directory, "PRIVATE_DATABASE_PATH.sqlite3");
  const preload = path.join(directory, "startup-failure.mjs");
  const args = ["--no-warnings"];
  // Keep ambient credentials, NODE_OPTIONS and logging configuration out of the child.
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, {AGENT_GOVERNANCE_SHARED_STATE_DIR: directory,
    AGENT_GOVERNANCE_DB_PATH: database, AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"), PRIVATE_STARTUP_ENV: "PRIVATE_ENV_VALUE"});
  try {
    if (mode === "default-log-off") {
      // Real SQLite initialization fails after default-OFF diagnostics exist.
      await writeFile(database, privateMessage, "utf8");
    } else {
      // Only the first host-adapter lookup throws; the actual public CLI catch remains unmodified.
      environment.AGENT_GOVERNANCE_HOST_ATTESTATION = "synthetic-startup-failure";
      await writeFile(preload, `process.stderr.write = () => { throw new Error("ASYNC_STDERR_FORBIDDEN"); };
const original = Map.prototype.get;
Map.prototype.get = function(key) {
  if (key === "synthetic-startup-failure") {
    Map.prototype.get = original;
    const error = new TypeError(${JSON.stringify(privateMessage)}, {cause: new SyntaxError("PRIVATE_CAUSE_MESSAGE")});
    error.code = ${JSON.stringify(privateCode)};
    throw error;
  }
  return original.call(this, key);
};
`, "utf8");
      args.push("--import", pathToFileURL(preload).href);
    }
    const child = spawnSync(process.execPath, [...args, bundle], {
      cwd: directory, env: environment, input: "", encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr, "STARTUP_FAILURE_DIAGNOSTIC_REQUIRED").toMatch(/^\[agent-governance-suite\] startup-failure \{[^\r\n]*\}\n$/u);
    const record = JSON.parse(child.stderr.slice(prefix.length));
    expect(record).toEqual({phase: "startup", context: mode === "default-log-off"
      ? {type: "error", code: codeContext("MCP_UNAVAILABLE")}
      : {type: "type-error", code: codeContext(privateCode), cause: {type: "syntax-error"}}});
    for (const secret of [privateMessage, privateCode, "PRIVATE_CAUSE_MESSAGE", "PRIVATE_ENV_VALUE", "PRIVATE_DATABASE_PATH", directory,
      "Bearer", "SELECT", "stack", "databasePath"]) expect(child.stderr).not.toContain(secret);
    if (mode === "before-diagnostics") expect(existsSync(database)).toBe(false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
