import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

import { ROOT } from "./lib.mjs";

export const RUNTIME_BUNDLES = Object.freeze([
  Object.freeze({
    id: "mcp-server",
    entry: "mcp-server/src/index.ts",
    output: "mcp-server/dist/server.mjs",
    executable: true,
  }),
  Object.freeze({
    id: "skill-schema-runtime",
    entry: "scripts/schema-runtime-entry.mjs",
    output: "runtime/schema-validation.mjs",
    executable: false,
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

async function findPackageRoot(input) {
  const dependencyRoot = path.join(ROOT, "node_modules");
  let current = path.dirname(path.join(ROOT, input));
  while (current.startsWith(dependencyRoot)) {
    try {
      await access(path.join(current, "package.json"));
      return current;
    } catch {
      current = path.dirname(current);
    }
  }
  return null;
}

async function readLicense(packageRoot) {
  for (const filename of LICENSE_FILENAMES) {
    try {
      return (await readFile(path.join(packageRoot, filename), "utf8")).trim();
    } catch {
      // Try the next conventional license filename.
    }
  }
  throw new Error(`Bundled package at ${packageRoot} has no supported license file.`);
}

async function buildThirdPartyNotices(metafile) {
  const packageRoots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.replaceAll("\\", "/").includes("/node_modules/")) continue;
    const packageRoot = await findPackageRoot(input);
    if (packageRoot) packageRoots.add(packageRoot);
  }
  const packages = await Promise.all([...packageRoots].map(async (packageRoot) => {
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
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
    "The generated `runtime/schema-validation.mjs` bundle includes the packages below.",
    "Their copyright and license notices are reproduced verbatim from the installed packages.",
    "",
    ...sections,
    "",
  ].join("\n");
}

export async function buildRuntimeBundle(target, outputRoot = ROOT) {
  return build({
    absWorkingDir: ROOT,
    entryPoints: [target.entry],
    outfile: path.join(outputRoot, target.output),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "external",
    metafile: true,
    minify: !target.executable,
    banner: { js: target.executable ? "#!/usr/bin/env node" : "/* eslint-disable */" },
  });
}

export async function buildRuntimeBundles(outputRoot = ROOT) {
  let schemaRuntimeMetafile;
  for (const target of RUNTIME_BUNDLES) {
    const result = await buildRuntimeBundle(target, outputRoot);
    if (target.id === "skill-schema-runtime") schemaRuntimeMetafile = result.metafile;
  }
  if (!schemaRuntimeMetafile) throw new Error("The skill schema runtime bundle was not built.");
  const notice = await buildThirdPartyNotices(schemaRuntimeMetafile);
  const noticePath = path.join(outputRoot, RUNTIME_NOTICES);
  await mkdir(path.dirname(noticePath), { recursive: true });
  await writeFile(noticePath, notice, "utf8");
}
