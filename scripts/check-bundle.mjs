import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-governance-bundle-"));
const output = path.join(temporaryDirectory, "server.mjs");

try {
  await build({
    entryPoints: ["mcp-server/src/index.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "external",
    banner: { js: "#!/usr/bin/env node" }
  });

  const [expected, actual] = await Promise.all([
    readFile(output),
    readFile("mcp-server/dist/server.mjs")
  ]);

  if (!expected.equals(actual)) {
    throw new Error("mcp-server/dist/server.mjs is stale. Run pnpm build and commit the result.");
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
