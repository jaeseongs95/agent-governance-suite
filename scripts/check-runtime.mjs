import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (major < 22) {
  throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
}

const requiredFiles = [
  ".mcp.json",
  "mcp-server/dist/server.mjs",
  "skills/registry.json"
];
for (const relativePath of requiredFiles) {
  await access(path.join(ROOT, relativePath));
}

const mcp = JSON.parse(await readFile(path.join(ROOT, ".mcp.json"), "utf8"));
const server = mcp.mcpServers?.["agent-governance-suite"];
if (server?.command !== "node" || server?.args?.[0] !== "mcp-server/dist/server.mjs") {
  throw new Error(".mcp.json does not point to the packaged STDIO server.");
}

console.log(`runtime: ready (Node.js ${process.versions.node})`);
