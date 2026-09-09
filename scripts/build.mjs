import { build } from "esbuild";

await build({
  entryPoints: ["mcp-server/src/index.ts"],
  outfile: "mcp-server/dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "external",
  banner: {
    js: "#!/usr/bin/env node"
  }
});
