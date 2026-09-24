import { buildRuntimeBundles } from "./runtime-bundles.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import { ROOT } from "./lib.mjs";

await buildRuntimeBundles();
const { buildCurrentHostIntegrationManifest } = await tsImport(
  "../mcp-server/src/host-integration/manifest.ts", import.meta.url,
);
const manifest = buildCurrentHostIntegrationManifest(ROOT);
await writeFile(path.join(ROOT, "host-integration.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
