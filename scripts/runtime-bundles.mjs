import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ROOT } from "./lib.mjs";

export const RUNTIME_BUNDLES = Object.freeze([
  // Generate shared runtime before bundling consumers that import it.
  Object.freeze({
    id: "skill-schema-runtime",
    entry: "scripts/schema-runtime-entry.mjs",
    output: "runtime/schema-validation.mjs",
    executable: false,
  }),
  Object.freeze({
    id: "diagnostics-worker",
    entry: "mcp-server/src/diagnostics-worker.ts",
    output: "mcp-server/dist/diagnostics-worker.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "mcp-server",
    entry: "mcp-server/src/index.ts",
    output: "mcp-server/dist/server.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "governance-hook",
    entry: "mcp-server/src/governance-hook.ts",
    output: "mcp-server/dist/governance-hook.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "continuity-hook",
    entry: "mcp-server/src/continuity-hook.ts",
    output: "mcp-server/dist/continuity-hook.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "host-attestation-hook",
    entry: "mcp-server/src/host-attestation-hook.ts",
    output: "mcp-server/dist/host-attestation-hook.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "host-attestation-api",
    entry: "mcp-server/src/host-attestation-api.ts",
    output: "mcp-server/dist/host-attestation-api.mjs",
    executable: false,
  }),
  Object.freeze({
    id: "session-board-hook",
    entry: "mcp-server/src/session-board-hook.ts",
    output: "mcp-server/dist/session-board-hook.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "session-message-broker",
    entry: "mcp-server/src/session-message-broker.ts",
    output: "mcp-server/dist/session-message-broker.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "session-message-relay",
    entry: "mcp-server/src/session-message-relay-cli.ts",
    output: "mcp-server/dist/session-message-relay.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "session-message-hook",
    entry: "mcp-server/src/session-message-hook.ts",
    output: "mcp-server/dist/session-message-hook.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "session-message-cli",
    entry: "mcp-server/src/session-message-cli.ts",
    output: "mcp-server/dist/session-message-cli.mjs",
    executable: true,
  }),
]);

export const RUNTIME_NOTICES = "runtime/THIRD_PARTY_NOTICES.md";
export const RUNTIME_ARTIFACTS = Object.freeze([
  ...RUNTIME_BUNDLES.map((target) => target.output),
  RUNTIME_NOTICES,
]);

const LICENSE_FILENAMES = Object.freeze([
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
]);

async function findPackageRoot(input, root) {
  const resolved = path.resolve(root, input);
  // Metafile keys may be flat, relative physical paths outside ROOT, or absolute paths.
  const relative = path.relative(root, resolved);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!outside && !relative.split(path.sep).includes("node_modules")) return null;
  let boundary = path.dirname(resolved);
  while (path.basename(boundary) !== "node_modules") {
    const parent = path.dirname(boundary);
    if (parent === boundary) return null;
    boundary = parent;
  }
  const parts = path.relative(boundary, resolved).split(path.sep);
  const count = parts[0].startsWith("@") ? 2 : 1;
  const current = path.join(boundary, ...parts.slice(0, count));
  const metadataPath = path.join(current, "package.json");
  try { await access(metadataPath); } catch (cause) {
    if (cause?.code === "ENOENT") throw new Error(`No package metadata for bundled dependency ${input} beneath ${boundary}.`, {cause});
    throw new Error(`Cannot access bundled package metadata at ${metadataPath}.`, {cause});
  }
  return current;
}

async function readLicense(packageRoot) {
  for (const filename of LICENSE_FILENAMES) {
    try {
      return (await readFile(path.join(packageRoot, filename), "utf8")).trim();
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw new Error(`Cannot read bundled package license at ${path.join(packageRoot, filename)}.`, { cause });
      // Only an absent conventional filename permits trying the next one.
    }
  }
  throw new Error(`Bundled package at ${packageRoot} has no supported license file.`);
}

/** root is the metafile's absWorkingDir; normal generation keeps the existing ROOT default. */
export async function buildThirdPartyNotices(metafile, root = ROOT) {
  const packageRoots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const packageRoot = await findPackageRoot(input, root);
    if (packageRoot) packageRoots.add(packageRoot);
  }
  const packages = await Promise.all([...packageRoots].map(async (packageRoot) => {
    const metadataPath = path.join(packageRoot, "package.json");
    let metadata;
    try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); }
    catch (cause) { throw new Error(`Cannot read bundled package metadata at ${metadataPath}.`, { cause }); }
    return {
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      notice: await readLicense(packageRoot),
    };
  }));
  packages.sort((left, right) => left.name.localeCompare(right.name));
  const sections = packages.map((item) => [
    `## ${item.name} ${item.version} (${item.license})`,
    "",
    "```text",
    item.notice,
    "```",
  ].join("\n"));
  return [
    "# Third-Party Notices",
    "",
    "The generated runtime bundles include the packages below.",
    "Their copyright and license notices are reproduced verbatim from the installed packages.",
    "",
    ...sections,
    "",
  ].join("\n");
}

export async function buildRuntimeBundle(target, outputRoot = ROOT) {
  const { build } = await import("esbuild");
  return build({
    absWorkingDir: ROOT,
    entryPoints: [target.entry],
    outfile: path.join(outputRoot, target.output),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // Escape template contents without trimming runtime string values.
    supported: { "template-literal": false },
    sourcemap: false,
    legalComments: "external",
    metafile: true,
    minify: !target.executable,
    // Omit path-bearing debug module keys/comments without changing dependency resolution.
    minifyIdentifiers: true,
    minifyWhitespace: true,
    banner: { js: target.id === "diagnostics-worker" ? "#!/usr/bin/env node\nimport {createRequire as agsRequire} from 'node:module'; const require = agsRequire(import.meta.url);" : target.executable ? "#!/usr/bin/env node" : "/* eslint-disable */" },
  });
}

export async function buildRuntimeBundles(outputRoot = ROOT) {
  let schemaRuntimeMetafile;
  const inputs = {};
  for (const target of RUNTIME_BUNDLES) {
    const result = await buildRuntimeBundle(target, outputRoot);
    Object.assign(inputs, result.metafile.inputs);
    if (target.id === "skill-schema-runtime") schemaRuntimeMetafile = result.metafile;
  }
  if (!schemaRuntimeMetafile) throw new Error("The skill schema runtime bundle was not built.");
  const notice = await buildThirdPartyNotices({inputs});
  const noticePath = path.join(outputRoot, RUNTIME_NOTICES);
  await mkdir(path.dirname(noticePath), { recursive: true });
  await writeFile(noticePath, notice, "utf8");
}
