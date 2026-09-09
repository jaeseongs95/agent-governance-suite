import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error(`Node.js 22.13 or newer is required; found ${process.versions.node}.`);
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
if (
  server?.command !== "node"
  || server?.args?.[0] !== "mcp-server/dist/server.mjs"
  || server?.cwd !== "."
) {
  throw new Error(".mcp.json does not point to the packaged STDIO server.");
}

console.log(`runtime: ready (Node.js ${process.versions.node})`);
