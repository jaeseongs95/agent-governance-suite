#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstructionFiles, runCli } from "../../skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs";

// This precedence belongs to the Antigravity adapter, never the common request.
const OPTIONS = Object.freeze({ instructionFiles: Object.freeze([
  Object.freeze({ name: "GEMINI.override.md", kind: "override" }),
  Object.freeze({ name: "AGENTS.override.md", kind: "override" }),
  Object.freeze({ name: "GEMINI.md", kind: "agents" }),
  Object.freeze({ name: "AGENTS.md", kind: "agents" }),
]) });

export function resolveAntigravityInstructionFiles(request) {
  return resolveInstructionFiles(request, OPTIONS);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2), OPTIONS);
}
