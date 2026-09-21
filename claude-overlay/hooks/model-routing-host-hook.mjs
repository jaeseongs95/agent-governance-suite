#!/usr/bin/env node
// Optional native observer. Do not rewrite tool inputs, approvals or v1 attestation.
import { spawnSync } from "node:child_process";
import { readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.env.CLAUDE_PLUGIN_DATA?.trim();
if (directory) {
  try {
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(16384);
      const size = readSync(0, chunk, 0, chunk.length, null);
      if (!size) break;
      total += size;
      if (total > 1024 * 1024) throw new Error("Input limit exceeded.");
      chunks.push(chunk.subarray(0, size));
    }
    const executable = fileURLToPath(new URL("../mcp-server/dist/model-routing-host-hook.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [executable, "--host", "claude-code"], {
      input: Buffer.concat(chunks), encoding: "utf8", timeout: 4000, maxBuffer: 65536,
      windowsHide: true, env: { ...process.env, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3") },
    });
    if (!result.error && result.status === 0 && result.stdout) process.stdout.write(result.stdout);
    if (result.error || result.status !== 0 || result.stderr?.includes("AGS native routing observation unavailable;")) {
      process.stderr.write("AGS native routing observer unavailable; no execution assurance was added.\n");
    }
  } catch {
    process.stderr.write("AGS native routing observer unavailable; no execution assurance was added.\n");
  }
}
